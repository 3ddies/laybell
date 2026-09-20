# 1.0.4 — release notes (IN PROGRESS)

Paste-ready store copy goes here once the release is settled. Google Play caps release
notes at **500 characters**, App Store "What's New" at **4000**:

```bash
node scripts/check-release-notes.mjs docs/RELEASE_NOTES_1.0.4.md
```

---

## Google Play — "What's new" (≤500 chars)

```
TBD
```

---

## App Store — "What's New in This Version" (≤4000 chars)

```
TBD
```

---

# STATUS

## The performance program (owner, 2026-09-19)

**Owner:** the app "still feels noticably less polished than instagram" — what should change
structurally for responsiveness, speed and memory? Nine items were proposed from a read of the
code, and the owner answered: "Do them each to the best of your ability, i will let you run."

| # | Item | Why (what the code showed) |
|---|---|---|
| 1 | Measure: Sentry performance tracing | Sentry installed, tracing off (`tracesSampleRate: 0`) |
| 2 | 120Hz animations | `CADisableMinimumFrameDurationOnPhone` missing — capped at 60fps |
| 3 | Query cache + leaner queries | no shared cache; screens refetch on focus; 57 `select('*')` |
| 4 | Right-sized images + placeholders | grids load 1440px uploads; 67 files use RN `Image`; no placeholders |
| 5 | Gestures/animations on the UI thread | 36 PanResponders in 26 files; no Reanimated |
| 6 | Virtualized lists | ~65 FlatLists (reels pager too); Explore grid renders every tile |
| 7 | Leaner startup | 1.5 MB i18n module builds 10 languages; ~27 root providers |
| 8 | Split giant screens | post.tsx 3,737 lines, index.tsx 2,887, music.tsx 2,317 |
| 9 | Finishing touches | press feedback, keyboard-synced inputs, finger-following sheets |

**Native pieces (one new dev build):** `react-native-reanimated` 4.1 + `react-native-worklets`
0.5 and `react-native-keyboard-controller` 1.18 — owner-approved 2026-09-19 — plus the 120Hz
Info.plist key. JS may not import them until that dev client is installed: an older binary
red-screens on the missing native module.

**Judge polish on a release build.** Dev builds run unminified JavaScript with React's dev
checks and are several times slower than TestFlight / the App Store.

**Dev client:** EAS build `0636bbfa-5cb7-4412-99fd-d2802656ef51` (2026-09-19) carries the
native pieces — install it before testing anything below.

## 1. Measurement — Sentry performance tracing

- [x] `lib/monitoring.ts`: `tracesSampleRate` 0 → `TRACES_SAMPLE_RATE` (0.3). App start, slow
      and frozen frames and JS stalls come with tracing; `reactNavigationIntegration` adds each
      screen's time to first draw (registered from `app/_layout.tsx`). It records route NAMES
      only, never params (screens pass whole posts as JSON params).
- [x] Privacy: transactions pass the same opt-out and scrubbing as errors
      (`beforeSendTransaction`), request spans lose their query strings, and
      `tracePropagationTargets: []` keeps trace headers off every outgoing request.
- [ ] After the build ships: read Sentry → Insights/Mobile (app starts, screen loads, slow and
      frozen frames) for a baseline; lower the rate as users grow.

## 2. 120Hz

- [x] `app.json` → `ios.infoPlist.CADisableMinimumFrameDurationOnPhone: true` (2026-09-19).
      Without it, iOS caps an app's animations at 60Hz on ProMotion iPhones (13 Pro and
      later); scrolling was already 120Hz.
- [ ] Device check (release build, Pro iPhone): sheets, the story viewer's progress bar and
      the tab bar's chrome animations look visibly smoother than 1.0.3.

## 3. Screens that open instantly

**Design note.** The plan named TanStack Query. The screens set a dozen pieces of state each
from hand-written fetches, so moving them onto `useQuery` meant rewriting their state, not just
their loading. A small stale-while-revalidate cache (`lib/screenCache.ts`) slots into the
screens as they are and gets the same result. TanStack Query was not adopted.

**Home feed, cold start** (`app/(tabs)/index.tsx`):
- [x] Last session's first 12 posts paint at once (`lib/feedSnapshot.ts`, per account,
      organic posts only — ads and spotlights carry impression tracking and are never replayed;
      dropped after 3 days; cleared on account deletion).
- [x] The fresh feed replaces the snapshot if the reader hasn't scrolled; if they have, what is
      on screen stays put and the fresh feed continues below it (`lib/feedMerge.ts`, 10 tests:
      `node scripts/tests/test-feedmerge.mjs`).
- [x] The critical path lost ~3 round trips: `getSession()` (on the phone) replaces
      `getUser()` (a server round trip); the taste profile comes from the phone's copy however
      old and is rebuilt behind (`feedScorer.loadAffinityProfileFast`); the posts, likes, saves,
      blocks and follows requests all go out at once (Following/Friends still fetch follows
      first — they filter by it).

**Visited profile** (`app/profile/[id].tsx`):
- [x] A profile seen this session paints at once and refreshes behind (24 kept). The cached
      copy tracks every change while it's open (follow, removed post).
- [x] `getSession()` instead of `getUser()`, and the page paints before the playlist covers
      load (they used to hold the whole page for one more round trip).

**Explore** (`app/(tabs)/explore.tsx`):
- [x] Each genre's grid is kept for the session — switching back to one is instant.
- [x] Fixed on the way: a slow response for a genre you'd already left used to repaint the grid
      under the genre you'd switched to.
- [x] Its launch load waits for Home's first paint (`lib/startupGate.ts`) unless Explore is
      opened first; the trending request goes out alongside the taste profile, not after it.

**Everywhere:** screen caches empty on sign-in/sign-out (`app/_layout.tsx`). Tests:
`node scripts/tests/test-screencache.mjs` (12).

**Device checks:**
- [ ] Kill the app and reopen: the feed shows posts immediately (no skeleton), then refreshes
      in place without a jump.
- [ ] Reopen and start scrolling at once: nothing on screen jumps when the fresh feed lands;
      more posts continue below.
- [ ] Open a profile, go back, open it again: instant the second time. Follow them, leave,
      come back: the button still says Following.
- [ ] Explore: switch genres back and forth — the second visit to a genre is instant.
- [ ] Sign out and in as another account: no trace of the first account's feed or profiles.

## 4. Images: right-sized, with placeholders

`supabase/sql/post_media_previews.sql` — **APPLIED 2026-09-19** (verified: both columns exist):
nullable `posts.thumb_url` + `posts.placeholder`. Nothing before 1.0.4 reads or writes them.

- [x] At post time (`lib/mediaPreview.ts`): a 560px JPEG of the post's picture — photo, audio
      cover, video poster, each slideshow slide — uploads beside the full file, and expo-image
      makes a thumbhash of it natively (~30 characters, stored in the row / the slide).
      Made in parallel with the main upload, so posting doesn't wait longer; a failed preview
      is a post without one, never a failed post.
- [x] Grids (Explore, both profiles) load the small copy instead of the 1440px upload; the
      feed card, post viewer and slideshow carousel show the small copy (or the blurred
      placeholder) until the full picture lands; everything fades in on network loads only.
- [x] Cleanup: deleting a post deletes its small copies (`storageCleanup.collectPostMediaUrls`
      + the delete path's select); a new cover in Edit post clears the stale copy and removes
      its file. Account deletion already purges the whole storage folder.
- [ ] **Posts from before this have no small copy or placeholder** — they look as they did.
      A backfill needs the service-role key (the owner would pass it on stdin); optional.

**Device checks:**
- [ ] Post a photo, a slideshow, a song with a cover and a video; each appears in your grid
      and the feed with a blurred placeholder first on a slow connection, then the picture.
- [ ] Delete one of them — its files go (check the Storage bucket if in doubt).
- [ ] Edit a video's cover — the grid shows the new cover, not the old one.

## 6. Lists that only build what's on screen

**The profile grids** (`app/(tabs)/profile.tsx`, `app/profile/[id].tsx`) were the worst case in
the app: the posts query has no limit and all five sub-tabs stay mounted, so a 300-post profile
built 300 squares — and started 300 image loads — before it could scroll.

- [x] Posts, Videos and Reposts are FlashLists now (the recycler the home feed uses), three to
      a row, at exactly the sizes and gutters the old grid had (`components/ProfileGridTile`).
      The custom page layout and the films shelf ride along as the list's first row, spanning
      all three columns — NOT `ListHeaderComponent`, which FlashList v2 + Fabric detaches
      wrongly when it scrolls out (the bug that ate Home's stories tray).
- [x] A reused square draws the new post, never the previous one for a frame:
      `components/VideoThumb` derives what it shows from its props instead of copying them
      into state, and every picture carries a `recyclingKey`.
- [x] The tapped square hands its own view to the viewer, so opening a post still grows out of
      the thumbnail — a shared id→view map breaks the moment views are reused.

**The Explore / Saved grid** (`components/ExploreGrid`) keeps its hand-packed masonry, so it
windows itself instead: every cell's position is known from the packing, and a cell more than a
screen away is an empty card of exactly its own size. That matters most on Saved, which puts
everything you have ever saved through this one grid.

**Device checks:**
- [ ] Your profile: scroll the whole Posts grid, fast — no blanks that stay blank, no square
      showing the wrong picture, nothing shifting under your thumb.
- [ ] Tap a post from the middle of the grid: it still expands out of its square, and Back
      still lands on it.
- [ ] A profile with a custom page layout, and one with films: the layout / films shelf sits
      above the grid exactly as before, and scrolling past it and back leaves it intact.
- [ ] Long-press a square (own profile) → the options sheet; on Reposts → remove the repost.
- [ ] Pull to refresh on each sub-tab; switch sub-tabs while scrolled down.
- [ ] Saved (Settings → Saved) and a community grid: scroll top to bottom and back.

## 7. A leaner launch

- [x] **The dictionaries load one at a time.** `lib/i18n.ts` held all ten languages as object
      literals — 1.5 MB — so every launch built ~15,000 strings in nine languages nobody had
      chosen. Each translation is now its own module (`lib/locales/<code>.ts`), built the first
      time that language is read; English stays inline because everything falls back to it.
      `i18n.ts` is 152 KB. Tests: `node scripts/tests/test-i18n.mjs` (58) — every language
      resolves, every key exists in English, fallbacks still work.
- [x] **The other tabs stop racing Home.** Every tab mounts at launch, so Music was fetching
      playlists, saved, liked and the whole Discover page while the feed was still loading;
      it now waits for Home's first paint (`lib/startupGate`), like Explore. Opening it
      directly still starts it at once.
- [x] **The camera roll isn't read at launch.** The composer's grid asked for photo permission
      and read 60 assets the moment it mounted — which is startup, and on a first run that is a
      photos dialog over the home feed. It waits for the composer to be opened; when permission
      is already granted it preloads quietly after Home's paint, so the tab is still instant.
- [x] **Downloads stop competing with the feed.** `OfflineContext` opened the app by initialising
      the offline engine, reconciling cached tracks and running the offline prefetch — which
      DOWNLOADS songs, over the same connection the feed was fetching its pictures on. All of it
      waits for Home's paint now. Nothing it does is on screen at launch.
- [x] **Four auth round trips became zero.** Follow, Profile, Premium and Offline each opened the
      app by asking the server to validate the session (`getUser`); they read the session already
      on the phone now (`getSession`), like Home. RLS still checks the token on every read.
- [x] **The store price list waits.** Premium's entitlement still resolves at launch — it decides
      whether the feed may show an ad — but the offerings fetch, which only the paywall reads,
      waits for Home's paint.

**Device checks:**
- [ ] Cold start: the feed is first; nothing else visibly competes with it.
- [ ] Switch to Music right after launch — it loads, and looks no different than before.
- [ ] Open the composer: the camera roll is there (already-granted account).
- [ ] Settings → Language → Spanish: everything translates as before, and switching back and
      forth stays instant. Restart the app in Spanish — it comes back in Spanish.
- [ ] Premium account: no ad appears in the first seconds of a cold start. Open the paywall
      (Settings → Premium) — prices are there.
- [ ] Offline: a pinned song still plays with the phone in airplane mode after a cold start.

## 5. Gestures on the UI thread

Every sheet that follows your finger dragged through `PanResponder`, so each finger move was a
round trip through the JS thread. Done one at a time with the phone in hand (2026-09-20) —
this is the one kind of change that cannot be judged by reading it.

- [x] **The 3-dot sheet** (`contexts/PostOptionsContext`) — Gesture Handler feeds the finger
      straight into a shared value. The backdrop is derived FROM the sheet's position instead of
      animated beside it, so they cannot drift; the drag-release dismissal now waits a frame
      before teardown, like the tap-dismiss already did.
- [x] **The share sheet** (`contexts/ShareContext`) — same shape, same pattern.
- [x] **The comments sheet** (`components/CommentsSheet`) — the biggest win of the three. Its
      detents are a real layout HEIGHT, and stretching it wrote that height from JS on every
      frame, reflowing the whole comment list each time, while a reel played behind it. It is
      on the UI thread now — and a constraint went with it: the old code needed two nested
      views to keep RN's JS driver and native driver apart (with a comment warning never to
      merge them), because RN's Animated cannot drive a layout prop natively. Reanimated can,
      so it is one view.
- [x] Each sheet got its own `GestureHandlerRootView`: they render in a `FullWindowOverlay` on
      iOS and a real `Modal` on Android, and in a window of its own a `GestureDetector`
      silently does nothing.
- **The report sheet needed nothing** — `contexts/ReportContext` was already on
      `PanGestureHandler` with a native-driven `Animated.event`. That was the pattern; the 3-dot
      sheet had just never been given it.
- [ ] `components/StickerLayer` (the studio's drag/pinch/rotate) — still `PanResponder`. Multi-
      touch, so it wants its own pass and a video-editing session to test.

**A bug the device found, worth keeping:** the first conversion popped the sheet back UP for a
moment before it left, if you dragged slowly and released while still moving. The exit aimed at
a flat `DISMISS_DIST` of 300pt, which is SHORTER than the sheet — so a drag past 300 was
answered by an exit animating upward to 300. (It was in the PanResponder version too; a drag
that tracks the finger properly just makes it easy to hit.) Both fixed:

- the exit aims at the sheet's own measured height, so it is always downward and always clears;
- a released drag decelerates from the finger's actual velocity (ease-OUT) instead of easing in
  from a standstill, which was a visible stall;
- the release rule is now a projection — position plus 0.12s of velocity — replacing "long pull
  OR hard flick". A short drag released while still moving dismisses; the same drag released
  dead still springs back; an upward flick counts against dismissing.

**Device checks (all passed 2026-09-20):** drag/fling/rubber-band/backdrop-tap on all three
sheets, from the feed and from a reel; comments expand-to-full, collapse, dismiss, and the
keyboard raising it to full.

## 8. Giant screens / React Compiler — measured, not enabled

`npx react-compiler-healthcheck` on this codebase: **180 of 180 components compile**, no
incompatible libraries, no StrictMode problems. That is as clean a result as this tool gives,
and enabling it (`app.json` → `experiments.reactCompiler`) would auto-memoize every screen —
including the three big ones (`post.tsx` 3,737 lines, `index.tsx` 2,887, `music.tsx` 2,317),
which is a better answer than hand-splitting them.

**Left off in this pass on purpose:** it rewrites how every component in the app re-renders. If
it ships in the same build as everything above, then any oddity in testing has ~15 candidate
causes instead of one. It is a one-line change and a one-line revert — worth doing as its own
build, with a pass over the main flows.

One thing it would have broken was found and fixed on the way: the Explore grid read a measured
offset from a ref during render, which auto-memoization cannot see.

## 9. Finishing touches

- [x] **Inputs move WITH the keyboard.** `react-native-keyboard-controller` is wired at the
      root (`KeyboardProvider`), and the comment screen and both message threads use its
      `KeyboardAvoidingView` — it follows the keyboard frame by frame on the UI thread, where
      React Native's animates on a guessed duration after the event lands.
- [x] The DM compose bar rides the same animation. That replaced five keyboard listeners and a
      guessed duration per thread, all of which existed to survive the stray off-screen frame
      iOS emits after a show ("slides up then glitches back down") — there is nothing left to
      race. Still iOS-only motion, as before: Android resizes the window.

**Device checks:**
- [ ] Open a DM and tap the input: the bar rises with the keyboard, in step, with no jump or
      overshoot — then dismiss, and re-open it twice more (the old bug appeared on re-triggers).
- [ ] Send a message with the keyboard up; attach a GIF; the bar sits right above the keyboard
      in both cases.
- [ ] A group chat, same checks.
- [ ] The comments screen: the input clears the keyboard and the list scrolls under it.
