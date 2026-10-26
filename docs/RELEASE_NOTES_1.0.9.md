# Laybell 1.0.9 — release notes

**Version:** 1.0.9 (EAS production, `appVersionSource: remote` → build number auto-assigned)
**Builds started:** 2026-10-25 (EAS `production`, iOS + Android)
**Branch/commit:** `dev` @ `785da2d`

Pre-build gates GREEN (2026-10-25):
- 💰 **Money** — `global_sum_must_be_0` = 0, no ledger violations, no negative balances,
  no stuck videos / overdue deletions (the 1 post + 4 user reports are moderation items,
  non-blocking). Demo money OFF.
- 🗄️ **Schema** — NO DRIFT. All 3 new 1.0.9 migrations already live in prod
  (`active_status`, `story_poll_votes`, `story_views_retention`).
- 🧩 **Edge functions** — all 27 deployed/ACTIVE, including the new `weather` function
  (story temperature stickers). No deploy drift.
- 🧹 **Typecheck** — app `tsc` 0 errors.

No OTA on this project — the JS is frozen at build time, so every fix in 1.0.9 ships with
this build.

---

## What's New (App Store / user-facing)

**Stories got a lot more fun.**
- New sticker pack: **polls**, **countdown**, **music**, **location & temperature**,
  **links**, questions, community and shop stickers.
- **Collage** and **Boomerang** right in the camera.
- **Effects & color filters** on your photos and stories.
- **Emoji reactions** and the slide-to-react emoji slider.

**A smoother way to post.**
- Your video now starts playing the moment it's live — with its sound — no scrolling to
  kick it off.
- A cleaner, more satisfying upload experience with a redesigned progress card and a
  little celebration when it lands.
- Faster, more reliable uploads, especially for short clips.

**More ways to connect.**
- See who's online with the new active-status dot.
- Delete once, and it's gone everywhere instantly.

Plus a pile of performance work, visual polish, and bug fixes.

### Play Store "What's new" (≤500 chars)

```
Stories just got better: polls, countdown, music, location & temperature, and link
stickers, plus collage, boomerang, effects/filters, and emoji reactions. Posting is
smoother too — your video starts playing with sound the moment it's live, uploads are
faster and more reliable, and there's a little celebration when it lands. New online
status, delete-everywhere sync, and lots of polish and fixes.
```

---

## Full change list (internal)

### Stories
- Sticker suite: `PollSticker` + `StoryPollView` (votes → `story_poll_votes.sql`),
  `CountdownSticker`, `MusicSticker`, `LinkSticker`, `InfoSticker` (location + temperature,
  powered by the new `weather` edge function), `CommunitySticker`, `ShopSticker`.
- `EmojiReaction` + `EmojiSlider` reactions.
- `CollageCamera` (photo grids) + `BoomerangCamera` (frame-burst), sharing the extracted
  `lib/cameraTurn` single-camera guard with `CaptureCamera`.
- New `StoryEditor` + `EffectsTray` (Skia GPU color filters, SDK-pinned).
- `story_views_retention.sql` — prunes per-viewer rows for long-expired stories.
- Expanded location permission copy for location/temperature stickers.

### Posting
- Just-posted video hands off to its **real feed card** (pinned), so it autoplays and
  plays its song through the normal feed machinery — **forced on-screen** so short
  horizontal clips start too, not only tall vertical ones.
- iOS-styled uploading toast (frosted blur, 8s / dismiss on tab-switch / tap).
- Confetti + View/Share celebration overlay on the pinned card (`PostCelebration`); the
  colliding song pill + tagged button hide while it's up.
- Transient-retry resilience: the `stream-direct-upload` handshake and the subdomain-resolve
  poll now ride through a momentary edge-function blip instead of surfacing
  "Could not start the video upload" on a clip that uploads fine; a failed speculative
  prewarm silently re-runs the real upload.
- Neutral (monochrome) retry button on `UploadFailedBanner`.
- **Delete-everywhere** — `lib/postEdits` gains `emitPostDeleted`/`subscribePostDeleted`;
  `deletePostById` broadcasts, and home/profile/explore/reel drop the row at once.

### Presence / health
- `onlineStatus` active-status dot (`active_status.sql`, reciprocal + opt-out, modelled on
  profile views).
- `PageHealthMeter` (`lib/pageHealth`).

### Filters (shipped earlier in 1.0.9, committed)
- Skia GPU color-filter engine; bake into exported photos and video; live filtered-video
  preview in the editor.

### Native
- `./plugins/withMediaRouterPin` config plugin (added to `app.json`).

---

## Owner submit steps (after the EAS builds finish)

- **iOS** (Apple ID + 2FA, in App Store Connect — app `6795675871`): create the 1.0.9
  version, select the finished build, paste the "What's New" above, keep the existing
  reviewer demo notes, Submit. No new IAPs this release, so nothing extra to attach.
- **Android**: `eas submit -p android --profile production` (uploads to the `production`
  track as a **draft** per `eas.json`), then promote/roll out in the Play Console — or
  upload the `.aab` by hand. Paste the ≤500-char "What's new".
- Re-confirm **demo money OFF** before either Submit (standing rule).
