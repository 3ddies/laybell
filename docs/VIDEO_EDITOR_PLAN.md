# In-app video recorder + editor ("like TikTok") — findings, 2026-09-06

Deferred to a later update. This is the survey, so nobody has to redo it.

## What already exists

| Piece | Where | State |
|---|---|---|
| Camera | `app/(tabs)/story-camera.tsx` (1497 lines) | Facing, flash, zoom, 3s/10s timer, tap-vs-hold, `recordAsync` with `maxDuration` |
| **Trim** | `lib/videoTrim.ts` → `react-native-video-trim` | **A native module ALREADY IN THE BINARY.** Headless — `trimVideoIfPossible` cuts a file with no UI |
| Thumbnails | `expo-video-thumbnails` | Working |
| Stills editing | `expo-image-manipulator` | Crop/resize, used by the slideshow composer |
| Playback | `components/AppVideo.tsx`, the reels pager | Pooled players, pre-warm budget of active + 1 |
| Hosting | Cloudflare Stream | Upload takes ONE file |

So recording and trimming are effectively solved already.

## What is missing, and why it is hard

Everything below needs the video to be **re-encoded**, which is native work:

- **Segmented recording** (record → pause → record more). Needs concatenation.
  Cloudflare Stream takes one file, so segments cannot simply be kept as a list
  unless every consumer — feed, reels, share page, upload — learns to play a
  sequence. That is a wide change for a narrow feature.
- **Speed control** (0.3×–3×) — re-encode.
- **Burned-in text, stickers, transitions** — compositing.
- **Voiceover, or music mixed into the file** — audio muxing.
- **Filters** — needs GL/Skia at the camera layer; `expo-camera` has no filter API.

## The FFmpeg situation

`ffmpeg-kit` is **retired**. The repository was archived 2026-07-02 with the
notice: *"FFmpegKit has been officially retired."* Development continues as
**FFmpegKitNext** under the original author, and community forks exist on npm.

So the usual answer to "just use FFmpeg in React Native" now means adopting a
successor or a fork — a real dependency decision, not a default.

## The option that needs NO new native module

**A non-destructive editor.** Record and trim with what is already here, then
store text, stickers, timing and music as a **recipe** in the database beside the
video, and render it at PLAYBACK time in the app.

- No new native dependency, so no new prebuild risk.
- The app already does this shape of thing: the top-caption feature draws
  captions over video at playback (`supabase/sql/post_top_caption.sql`).
- Rendering is React Native views over `AppVideo` — animation the app is good at.

**The honest cost:** the overlays are not in the file. A video saved to the
camera roll, shared to another app, or opened from the share page has none of
them. For a TikTok-style feature where the edit IS the post, that may be
acceptable — inside Laybell it looks identical. It is a product call, not a
technical one, and it should be made deliberately rather than discovered later.

## Recommended sequencing when this is picked up

1. **Non-destructive overlays first** — text with in/out timing, then stickers.
   Ships without touching native, and proves the interaction.
2. **Trim UI** — the native module is already there; only the interface is
   missing. Cheapest real win on this list.
3. **Only then** decide on FFmpegKitNext / a fork, for segments, speed and
   burned-in export. That decision needs an explicit yes: see AGENTS.md and the
   native-module rule — one was built and reverted 2026-08-12, and this project
   has no OTA, so every native change costs a full rebuild.
