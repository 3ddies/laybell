# Laybell on the web — plan

## §0. Status and the decision

**Nothing here is built.** This is the plan agreed on 2026-08-11, to be started
**after the App Store submission**, not before. Tier 1 is a multi-day project and
it competes directly with the remaining launch items in
`docs/LAUNCH_CHECKLIST.md` §0.0.

**The decision: a separate Next.js app, not the Expo app compiled to web.**

Expo Router can server-render on EAS Hosting, so "run the app on the web" is not
impossible. It is just the expensive way to get a worse result here:

- **17 of 63 dependencies are native-only**, and the worst one is
  `react-native-pager-view` — which has no web implementation *and* is patched
  (`patches/react-native-pager-view+6.9.1.patch`, the swipe-land haptic).
  Pagers are the navigation backbone: the hidden stories-camera page, the
  profile swipe, both reel modes. Web would need all of that rewritten anyway,
  so sharing the *UI* layer buys little while spraying `Platform.OS === 'web'`
  through files that are carefully tuned for native (the feed's active-video
  resolver in `app/(tabs)/index.tsx` is the type specimen).
  Also native-only: `react-native-purchases` (RevenueCat), `react-native-google-cast`,
  `@livekit/react-native*`, `expo-contacts`, `expo-location`, `expo-camera`,
  `expo-media-library`, `expo-notifications`, `expo-screen-orientation`,
  `expo-haptics`, `expo-file-system`, `react-native-nitro-modules`.
- **Risk isolation.** A separate surface cannot break the app build. Adding a web
  target to the Expo project can, and there is a submission in flight.
- **The point of a web presence is discovery.** Indexable public profiles and
  posts are the top of the install funnel for Instagram and TikTok both. That
  wants boring server-rendered HTML per entity — which `share-page` already
  proves works on this stack. Tier 1 is that function with a body instead of a
  redirect.

**Stack:** Next.js App Router → Cloudflare Pages (see §4 — it also fixes a latent
universal-links bug) → the same Supabase project, anon key, RLS.

---

## §1. Tier 1 routes — public, read-only, indexable

The whole tier is anonymous reads. No login, no writes, no session. That is what
makes it safe to ship next to a launch.

| route | page |
|---|---|
| `/@<username>` | profile: avatar, display name, badge, bio, link, counts, grid of public posts |
| `/p/<postId>` | single post: media playing, caption, author, community tags, counts |
| `/c/<hashtag>` | community: banner, name, description, member count, post grid |

Every page carries an **Open in Laybell** button plus the store buttons, using the
same UA detection as `web/open.html`.

### ⚠️ Do NOT use `/profile/<id>`, `/post/<id>`, `/reel/<id>`, `/communities/<id>`

Those paths are **already claimed as universal links** by
`web/.well-known/apple-app-site-association`. On any device with Laybell
installed, iOS and Android hand those URLs to the app and the browser never
renders them. That is correct behaviour for share links and must not change — it
is why the web routes use a different, unclaimed shape (`/@`, `/p/`, `/c/`).

Consequence to decide later: `/@handle` staying in the browser is the right
default for Tier 1 (a visitor without the app is the whole audience). If you ever
want it to deep-link for installed users, add `/@*` to the AASA `components` —
but then it stops being a web page for exactly the people most likely to share it.

### Media playback

Video already works on the web without transcoding: single video posts are on
Cloudflare Stream and `media_url` is an HLS manifest (see
`lib/streamUpload.ts`). Use `hls.js`, or Cloudflare's own `<stream>` embed.
Posters come from `cfStreamThumbnail()` — the same derivation `share-page`
already uses. Audio posts are plain files: `<audio>` is enough.

---

## §2. Data per page, and the RLS reality

**Every web query uses the anon key. Never a service key.** But RLS alone is not
enough, and the gaps below are the single most important thing in this document.

### What RLS actually covers

Verified against production on 2026-08-11 with the anon key:

| | protected by RLS? | evidence |
|---|---|---|
| private posts (`is_public = false`) | ✅ yes | anon count = 0 |
| posts/stories/playlists of a **hidden** author | ✅ yes | restrictive policies in `supabase/sql/account_hidden.sql` |
| **the `profiles` row of a hidden author** | ❌ **NO** | no policy on `profiles` exists; anon reads all 8 rows, `hidden` column included |
| **archived posts** (`archived_at` set) | ❌ **NO** | anon sees them |

In the app the first gap is covered in *application* code —
`lib/hiddenProfile.maskHiddenProfile()` blanks the identity, and the profile
screen has an "account unavailable" state. **A crawler runs none of that.** A
public endpoint taking a raw id therefore has to do the check itself.

`supabase/functions/share-page/index.ts` was fixed on 2026-08-11 to do exactly
that (select `hidden`, fall through to the generic card; and `.is('archived_at',
null)` on the post branch). **Every Tier 1 page must apply the same two
guards** — copy the pattern, do not re-derive it.

### Per-page selects

**`/@<username>`**
```
profiles: id, username, display_name, avatar_url, bio, link, badge_tier,
          badge_show, profile_theme, hidden        ← hidden is REQUIRED
  → if (hidden) return notFound()                  ← app-level, not RLS
posts:    …grid columns…  where user_id = <id> and archived_at is null
          order by created_at desc
```

**`/p/<postId>`**
```
posts: id, user_id, type, caption, media_url, thumbnail_url, cover_url,
       aspect_ratio, video_hls_url, video_poster, song_*, community_tags,
       like_count, comment_count, view_count, mature, created_at,
       profiles!posts_user_id_fkey(username, display_name, avatar_url, hidden)
  where id = <id> and archived_at is null
  → if (!post || post.profiles.hidden) return notFound()
```
RLS already drops it if the post is private or its author is hidden; the
`archived_at` filter and the profile check are the parts you own.

**`/c/<hashtag>`**
```
communities: id, name, description, hashtag, banner_url, member_count
posts:       …grid…  where community_hashtag = <tag> and archived_at is null
```

### Two more gates before this goes public

- **`posts.mature`** exists and the store listings promise a mature-content gate
  (see the review notes in `docs/`). A public, unauthenticated web page has no
  age signal at all. Decide before launch of Tier 1: exclude `mature` posts from
  web entirely (simplest, recommended), or interstitial them.
- **Geo/blocked content** — `lib/geoBlock.ts` and `lib/contentFilter.ts` shape
  what the app shows. Neither runs on a static crawler. Assume they do not apply
  and pick the conservative subset.

---

## §3. Shared modules

`constants/theme.ts` imports nothing from react-native — it ports as-is, so the
web app can use the real palette, spacing and gradients rather than a copy that
drifts.

**64 of the `lib/*.ts` modules have no react-native or expo import at all.** The
ones Tier 1/2 actually want:

| module | lines | note |
|---|---|---|
| `i18n.ts` | 20,315 | 10 languages; imports only `./format`. Free multilingual web. |
| `genres.ts`, `mentions.ts`, `aspectRatio.ts`, `timeAgo.ts`, `format.ts`, `postSong.ts` | small | pure helpers, drop straight in |
| `hiddenProfile.ts` | 31 | **use this** — it is the masking rule §2 depends on |
| `appLinks.ts` | 101 | store URLs, share URLs, already the single source |
| `entitlements.ts`, `contentFilter.ts`, `linkSafety.ts`, `communities.ts` | med | portable |

### The one real obstacle

Most of those import `./supabase`, and `lib/supabase.ts` pulls in
`react-native-url-polyfill/auto` and uses `AsyncStorage` as the auth storage
adapter. So `supabase.ts` is the **single file that needs a per-platform
implementation** (web: the supabase-js default `localStorage`). Everything
downstream is then unchanged.

Two modules need slightly more than that:

- **`lib/feedScorer.ts`** — imports `AsyncStorage` directly for the seen-post
  set. The scoring and `arrangeFeed` maths are portable; the persistence needs a
  small storage interface injected. Needed for Tier 2, not Tier 1.
- **`lib/badges.ts`** — imports `type ViewStyle` from react-native. Type-only, so
  it erases at build; either widen the type or keep a `types-only` shim.

**Suggested layout:** an npm workspace, `packages/core`, holding the pure `lib/`
modules and `constants/theme.ts`, with `supabase.ts` resolved per platform.
Both the Expo app and the Next.js app depend on it. Do this move in one commit,
on its own, with a full type-check either side — it touches every import path in
the app and must not be mixed with feature work.

---

## §4. Hosting cutover — the part that can break the live app

`laybell.app` today = **GitHub Pages**, publishing `web/` on every push to `dev`
(`web/CNAME` = laybell.app). Moving to Cloudflare Pages is recommended, but the
following must keep resolving at **byte-identical paths**, or things that are
already in the world break.

### Must survive, permanently

| path | why it can never move |
|---|---|
| `/.well-known/apple-app-site-association` | iOS universal links. Breaks every share link into the app. |
| `/.well-known/assetlinks.json` | Android App Links, ditto. |
| `/open.html` | **QR codes already printed and screenshotted encode this.** Permanent. |
| `/invite.html` | invites already sent |
| `/privacy.html`, `/terms.html`, `/community.html`, `/advertising.html`, `/marketplace.html`, `/payouts.html`, `/delete-account.html` | referenced from the store listings and in-app legal screens |
| `/studio.html` | the web DAW connector the app opens |
| `/tv-live-receiver.html` | the Chromecast CAF receiver — its **receiver ID is registered against this URL** with Google |
| `/logo.png`, `/invite-card.png`, `/tv-splash.png` | og:image targets on links already shared |

### The move actually fixes a latent bug

`web/_headers` sets `Content-Type: application/json` on the two `.well-known`
files — **and GitHub Pages ignores that file entirely**, serving the
extensionless AASA as `application/octet-stream`. Modern iOS usually copes;
"usually" is not something to ship. Cloudflare Pages honours `_headers`, so the
cutover closes that hole. Verify it with `curl -sI` on both files immediately
after, before touching DNS.

### The AASA constrains new routes

`exclude: true` is already set for the legal pages so they stay in the browser.
**Any new web route that collides with a claimed prefix will be swallowed by the
app**, and any new legal/marketing page should be added to the exclude list.
Claimed today: `/post/*`, `/reel/*`, `/profile/*`, `/playlist/*`,
`/communities/*`, `/shop/*`, `/story/*`, `/open.html`.

### Order of operations

1. Stand the Next.js site up on a Cloudflare Pages **preview** domain. Nothing
   points at it.
2. Copy `web/` in verbatim as static assets. Verify every path in the table
   above on the preview domain, including the two content-types.
3. Verify Tier 1 pages against production data (anon key, both §2 guards).
4. **Only then** re-point DNS.
5. **Never during App Store review** — the listing's privacy-policy and support
   URLs are on this domain, and a broken URL is a rejection.

---

## §5. Tier 2 and Tier 3 — sketch only

### Tier 2 — login + the scrolling feed

This is the point where it reads as instagram.com.

- **Auth:** supabase-js on web, same RLS, `localStorage` sessions. Watch the
  Apple private-relay gotcha already documented for OAuth usernames (see the
  `invite-and-usernames` notes) — the web signup path hits the same thing.
- **Feed:** `feedScorer.arrangeFeed` + the storage shim from §3. Spotlight and ad
  weaving (`lib/spotlight.ts`, `lib/ads.ts`) are a separate decision — web
  impressions would need their own dedupe and their own billing story before
  they are switched on.
- **Engagement:** likes, comments, follows, saves are all RLS-guarded RPCs
  already; no new backend.
- **Minors:** `lib/minors.ts` and the 13–17 parental-consent flow are part of the
  legal commitment. Web signup must implement them, not skip them.

### Tier 3 — creation, messaging, money

- **Uploads:** the Cloudflare direct-upload Edge Functions
  (`stream-direct-upload`, `stream-status`) are transport-agnostic and work from
  a browser.
- **DMs:** Supabase realtime; `lib/groups.ts` is already portable.
- **Money — the real decision.** RevenueCat is native-only, so web subscriptions
  mean **Stripe Checkout** (the platform account is already activated and
  Connect is configured). Two consequences: web purchases avoid the 15–30% store
  cut, and Apple's anti-steering rules mean **the iOS app must not link to it**.
  Entitlements would need to reconcile two sources of truth — `lib/entitlements.ts`
  and the RevenueCat webhook — which is money code, so per `AGENTS.md` it gets an
  adversarial review before it runs.

---

## §6. First session checklist (when Tier 1 starts)

1. `packages/core` extraction, on its own commit, type-check both sides.
2. Next.js skeleton + `web/` copied in as static assets, on a preview domain.
3. `/@<username>` with both §2 guards, tested against a real hidden account
   (create one deliberately — there are currently zero, which is why the RLS gap
   went unnoticed).
4. `/p/<postId>` with hls.js playback.
5. `/c/<hashtag>`.
6. Verify the §4 path table on the preview domain. DNS last.
