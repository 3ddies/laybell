# Laybell 1.1.1 — release notes

**Version:** 1.1.1 (EAS production, `appVersionSource: remote` → build number auto-assigned)
**Builds started:** 2026-11-03 (EAS `production`, iOS + Android)
**Branch/commit:** `dev`

**Why 1.1.1 (not 1.2.0):** an incremental bump — it revives and extends existing
surfaces (presence, Messages, the posting camera, Communities, the DJ Booth) and fixes a
production bug, rather than introducing a whole new pillar. Store build numbers (iOS
`buildNumber`, Android `versionCode`) increment separately and automatically.

Pre-build gates (2026-11-03):
- 🧹 **Typecheck** — app `tsc` 0 errors.
- 💰 **Money** — **no money-code changed** this release (nothing touches the ledger,
  wallet, payouts, IAP, or ad billing). The full `_HEALTH_CHECK.sql` was not re-run for an
  incremental, money-neutral update — can be run before the store Submit if desired.
- 🗄️ **Schema** — `online_user_ids` (the green-dot ambiguity fix + the @laybell test-gate)
  and the new `active_now` RPC are **already deployed to prod**, and the repo's
  `supabase/sql/active_status.sql` matches them → no drift. No other schema changes.
- 🧩 **Edge functions** — none changed since 1.1.0.

**Native** — no new native dependencies vs 1.1.0 (the DJ FX reuse the existing
`react-native-audio-api` engine), so the fingerprint is unchanged. A full rebuild is still
required because this project has **no OTA** — the JS is frozen at build time, so
everything below ships only with this build.

**Server note (already live, all builds):** the green-dot fix and the @laybell active-status
test-gate are server-side and already live in production for every build. The @laybell gate
(active status hidden from everyone except @3ddie) is intentionally **kept** for ongoing
testing this release.

---

## What's New (App Store / user-facing)

**See who's active, right in Messages.**
- A new **Active now** row at the top of Messages shows people who are online this moment —
  your friends first, then other people on Laybell — so you can jump straight into a chat.
- The green **active dot** is reliable now, and it clears on its own once someone's been
  away for a bit.

**Post your own music faster.**
- An **"Upload your Music"** button right in the posting camera takes you straight to posting
  a track.

**A cleaner Communities page.**
- The Communities tab is now a full page of Laybell's communities, most popular first.

**More DJ Booth effects.**
- One-shot **Tape Stop, Tape Start, Roll, and Reverse** effects to play with while you mix.

**Better "who to follow."**
- More accurate "In your area" and "popular on Laybell" labels, plus a simple **New Account**
  tag for brand-new members.

**Little things.**
- A slide-down **banner + buzz** when a new message arrives while you're in the app.
- Stories from the official **Laybell** account now reach everyone, not just followers.
- Plus polish and fixes.

### Play Store "What's new" (≤500 chars)

```
New "Active now" row in Messages shows who's online so you can jump into a chat — with a
reliable active dot. "Upload your Music" button right in the posting camera. Cleaner
Communities page (most popular first). More DJ Booth effects: Tape Stop, Tape Start, Roll,
Reverse. Smarter "who to follow" labels + a New Account tag. In-app new-message banner.
Plus polish and fixes.
```

---

## Full change list (internal)

### Messages / presence
- **Active-now rail** (`components/ActiveNowRail.tsx`) at the top of the main Messages tab:
  up to 5 online users via the new `active_now(p_prefer, p_limit)` RPC — the viewer's own
  people (friends, then follows) fill first, then other online users (most-recently-active)
  fill any remaining slots, so it shows faces on a near-empty app but never a stranger while
  five of your own are active. Hidden while searching / opted out; skips hidden + blocked.
- **Green-dot fix** — `online_user_ids` referenced an unqualified `id` that collided with its
  `RETURNS TABLE(id)` column, throwing "column reference \"id\" is ambiguous" on every
  authenticated call (silently swallowed), so the dot had never worked. Fixed by qualifying
  via an alias. Server-side; already live for all builds.
- **Idle-off heartbeat** (`lib/onlineStatus.ts`) — the heartbeat now stops while the app is
  idle (reusing the existing `isLoopIdle` signal), so an app left open but untouched drops to
  offline instead of reading "active" forever; a touch brings it right back. Viewers also
  re-poll on foreground so stale dots clear within a second on return.
- **@laybell test-gate** — `online_user_ids` + `active_now` hide @laybell's active status from
  everyone except @3ddie (TESTING ONLY; marked for removal in `active_status.sql`).
- **In-app message banner** (`components/ActivityBanner.tsx`, Source 4) — a slide-down banner
  + haptic for a new 1:1 or group message, routed to that thread, suppressed on the open one.

### Posting camera
- **"Upload your Music"** — a tall white oval on the right edge of the posting camera, label
  reading sideways with a subtle periodic bounce; leaves the camera and switches the composer
  to the audio post type (`app/(tabs)/post.tsx`).

### Communities
- The Communities tab is a full-page 2-column grid of the official Laybell communities,
  ordered by member then post count; discovery rails gated off until there are enough
  user-made communities (`app/communities/index.tsx`, `components/CommunityCard.tsx`,
  `lib/communities.ts`).

### DJ Booth
- One-shot FX — **Tape Stop, Tape Start, Roll, Reverse** — on a toggle next to Swap
  (`lib/dj/DjEngine.ts`, `components/dj/DjDeck.tsx`, `app/dj.tsx`). Roll uses discrete
  automation steps (no overlapping curve-crash) and tracks the intended fader level.

### Discovery / who-to-follow
- More accurate reasons: nearby capped at 80 km, "popular" requires ≥2 follows else falls back
  to a plain **New Account** label for accounts < 30 days old (`lib/suggestions.ts`,
  `lib/accountAge.ts`, shown as plain reason text in `SuggestedAccounts`/`PeopleRow`/friends).

### Story
- Official **Laybell** stories (`lib/official.ts`) are pinned into every tray regardless of
  follow (`lib/stories.ts`), the way Instagram surfaces its own.

### i18n
- New strings: `messages.activeNow`, `post.uploadMusic`, discovery `New Account`, etc.

---

## Release steps (this session is driving these)

- **Commit + bump** — all of the above committed on `dev`; `app.json` version → `1.1.1`.
- **EAS builds** — `eas build --platform all --profile production` (iOS + Android), started
  2026-11-03. Build numbers auto-increment (remote version source).
- **iOS submit** — `eas submit -p ios --profile production` via the stored ASC API key; then in
  App Store Connect (app `6795675871`) create the 1.1.1 version, select the build, paste
  "What's New", keep reviewer demo notes, Submit. **No new IAPs** this release. ⚠️ Confirm the
  prior 1.1.0 (build 22) is out of review before submitting 1.1.1.
- **Android submit** — `eas submit -p android --profile production` (uploads to the
  `production` track as a **draft** per `eas.json`), then roll out in Play Console. Paste the
  ≤500-char "What's new".
