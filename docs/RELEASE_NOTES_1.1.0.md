# Laybell 1.1.0 — release notes

**Version:** 1.1.0 (EAS production, `appVersionSource: remote` → build number auto-assigned)
**Builds started:** 2026-10-27 (EAS `production`, iOS + Android)
**Branch/commit:** `dev`

**Why 1.1.0 (not 1.0.10):** this release adds whole new features — Auto-mix Listen Mode,
a DJ Booth, a redesigned now-playing screen, profile Titles — so it's a minor-version bump
under semver, not a patch. `2.0.0` is reserved for a true overhaul. Store build numbers
(iOS `buildNumber`, Android `versionCode`) increment separately and automatically.

Pre-build gates GREEN (2026-10-27):
- 💰 **Money** — `global_sum_must_be_0` = 0, no ledger violations, no negative balances,
  no stuck videos / overdue deletions (the 1 post + 4 user reports are moderation items,
  non-blocking). Demo money OFF.
- 🗄️ **Schema** — NO DRIFT. The new `profile_title.sql` (`profiles.title`) is already live
  in prod; all 188 declared columns / 196 functions / 147 indexes present.
- 🧩 **Edge functions** — no edge-function changes since 1.0.9; all deployed/ACTIVE, no drift.
- 🧹 **Typecheck** — app `tsc` 0 errors.

**Native rebuild** — this build adds `react-native-audio-api` (with FFmpeg) for the DJ /
Auto-mix engine, so the fingerprint changed vs 1.0.9. The `./plugins/withMediaRouterPin`
cast-framework pin that fixed 1.0.9's first Android build is already in place.

No OTA on this project — the JS is frozen at build time, so everything in 1.1.0 ships with
this build.

---

## What's New (App Store / user-facing)

**Listen Mode now auto-mixes like a radio DJ.**
- Songs blend into each other seamlessly — beatmatched, with produced transitions (filter
  sweeps, reverb washes, risers and more) instead of a hard cut between tracks.
- Full **lock-screen controls** — play/pause, skip, and a live, draggable scrubber with the
  track's artwork and title, right on your lock screen.

**A DJ Booth.**
- A two-deck DJ booth to load up tracks and mix them yourself — cue pads, knobs, and a real
  audio engine.

**A better now-playing screen.**
- The full-screen player gets a redesigned, artwork-tinted look.

**Profile & story touches.**
- Add a **Title** under your name (your position — "Producer", "Engineer", "A&R"…).
- Tap a post someone reshared to their story to jump straight to the original, with a
  tidy **"View Post"** tag — just like you'd expect.

Plus performance work, polish, and bug fixes.

### Play Store "What's new" (≤500 chars)

```
Listen Mode now auto-mixes like a radio DJ: songs blend seamlessly with beatmatched,
produced transitions, plus full lock-screen controls (play/skip/scrub with artwork). New
two-deck DJ Booth to mix tracks yourself. Redesigned artwork-tinted now-playing screen. Add
a Title under your name on your profile, and tap a reshared story post to open the original.
Plus polish and fixes.
```

---

## Full change list (internal)

### DJ / Auto-mix (new `react-native-audio-api` engine)
- **DJ Booth (Phase 1)** — two-deck audio engine + UI (decks, cue pads, knobs); engine
  lazy-loaded so it can never crash app startup; renders once the engine is ready.
- **Auto-DJ / Listen Mode auto-mix** — tick-driven crossfades anchored to each song's true
  audio end (energy-based end detection, no abrupt cut-off), beatmatched "radio morph"
  transitions with tempo-lock, per-recipe transition effects by how songs end/start
  (filter sweeps, echo/delay tails, reverb-wash exits, tape-stop / beat-stutter / highpass
  risers, white-noise uplifters + incoming reverb bloom), beat-locked kick layering, and
  percussiveness-based vocal detection so two vocals don't mush. Non-blocking analysis +
  graceful degradation so Listen Mode always starts.
- **Lock-screen controls** — the audio-api engine's own `PlaybackNotification` drives the
  now-playing card (live scrubber / seek / skip), restoring the shared command center on
  teardown. Skip/scrub always available (debounced); clean-boundary ad breaks hold the
  transition for a song boundary **only** when a break is due AND there's eligible inventory
  (a no-op today with no inventory — money path unchanged).
- Drives the **real bottom mini-player** and a polished now-playing card (not a custom card).

### Now-playing
- Artwork-tinted background on the Spotify-style sheet; player UIs show the Auto-DJ track.

### Profile
- Optional **Title / position** (`profiles.title`, `profile_title.sql`) — bold under the
  display name on the own + public profiles; edited in Edit Profile (max 40).

### Story
- Reshared-post look centralized in `components/RepostCard.tsx` (editor + both viewer paths
  match); tapping a reshared post shows an Instagram-style **"View Post"** tag that opens
  the original (`story.viewPost`).

### Native
- `react-native-audio-api` (FFmpeg enabled) added to `app.json` plugins + `package.json`.
- `./plugins/withMediaRouterPin` cast-framework pin retained (fixes the Android build).

---

## Release steps (this session is driving these)

- **Pre-build gates** — ✅ all green (money / schema / edge-fn / typecheck), above.
- **EAS builds** — `eas build --platform all --profile production` (iOS + Android), started
  2026-10-27.
- **iOS submit** — `eas submit -p ios --profile production` uploads via the stored ASC API
  key; then in App Store Connect (app `6795675871`): create the 1.1.0 version, select the
  build, paste "What's New", keep the reviewer demo notes, Submit. **No new IAPs** this
  release.
- **Android submit** — `eas submit -p android --profile production` (uploads to the
  `production` track as a **draft** per `eas.json`), then roll out in Play Console. Paste the
  ≤500-char "What's new".
- Re-confirm **demo money OFF** before either Submit (standing rule — verified green above).
