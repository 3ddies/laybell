# 1.0.3 — release notes (IN PROGRESS)

Paste-ready copy for both stores, written as 1.0.3 grows. Google Play caps release
notes at **500 characters**, App Store "What's New" at **4000**. Assert the counts
rather than trusting a word processor:

```bash
node scripts/check-release-notes.mjs docs/RELEASE_NOTES_1.0.3.md
```

---

## Google Play — "What's new" (≤500 chars)

```
New: schedule posts for later, and edit posts after they're up — the caption, song, cover and more. Videos get their own editor: time on-screen text to the moment, start a song at any part, and save the finished video to your camera roll.

Video is kinder to your battery and data: Explore previews are moving stills, previews pause when your phone is put down, and a video you opened stops at its end instead of looping.

Plus fixes and polish throughout.
```

---

## App Store — "What's New in This Version" (≤4000 chars)

```
POST NOW, OR LATER

Schedule a post for the moment you want it seen, any time in the next 30 days. It goes up on its own, even with Laybell closed, and the people you tagged or mentioned hear about it right then. Until it does, change the time, post it early or edit it from Scheduled.

EDIT AFTER YOU POST

Change a post after it's up: the caption, who's tagged, the genre, who can see it and its song. On a video, reopen the editor to adjust its on-screen text, music, sound and cover. Everything but the video itself.

SAVE THE FINISHED VIDEO

When your video posts, Laybell can keep a copy in your camera roll: trimmed, with its song mixed in, and with its captions on vertical videos. Ready to share anywhere. It's on by default, under Advanced settings.

A NICER WAY TO POST

Videos open straight into one editor for text, music, sound and cover, and you can record one right in Laybell: the camera in the composer is the same camera as Stories. Sharing ends with a little celebration and a quick way to see or share what you just posted, and closing a post you haven't finished offers to save it as a draft.

CAPTIONS THAT HIT THEIR MOMENT

Add text and emoji to your vertical videos and choose exactly when each one appears and leaves. Your clip plays right in the editor: scrub to the moment, drag the ends of a caption's bar, and watch it land just the way your followers will see it.

YOUR SONG, YOUR MIX

Pick the part of a song that plays on your video — the chorus, the drop, wherever it hits — instead of always starting from the top. Set the song's volume and your video's own sound separately, so your voice and the music can both be heard. The song starts at your part when your video starts, and comes back to it every time the video loops.

VIDEO THAT KNOWS WHEN YOU HAVE STEPPED AWAY

Video used to keep playing for as long as a phone was left on it — looping over and over, holding the screen awake, and using battery and data with nobody watching. Now, once your phone has sat untouched for a few minutes, the previews that play on their own in your feed and on profiles pause right where they are, and carry on from the same spot the moment you touch the screen. A video you opened yourself plays to its end and stops there instead of starting over, so nothing you are actually watching gets cut off partway.

Reels keep auto-scrolling, and Laybell TV keeps playing, hands-free for up to an hour without a tap. After that they stop instead of playing on to an empty room — and on AirPlay, Laybell TV asks whether you are still watching.

EXPLORE, LIGHTER

Explore previews are now moving stills: a few moments from each video, gently cross-fading. They look alive, load quickly and use a fraction of the data. Tap one to watch the real thing.

Videos also no longer keep playing out of sight behind a screen you open on top of them.
```

---

# STATUS

## The headline fix — unattended video

**Why this release exists this early.** On 2026-09-10 the Cloudflare bill showed
$7 in 7 days, projecting $30. One 11.8-minute post had delivered **8,075 minutes in
30 days against 44 views**. Cause: a playing video keeps the phone's screen awake,
so a looping one never lets the phone lock, the app never backgrounds, and it
streams in the foreground forever. Full write-up in the commits and in
`lib/presenceCore.ts`.

⚠️ **The leak is still live on 1.0.1 and 1.0.2.** No OTA — only this build fixes it.
Every day before 1.0.3 is approved, any device left on a looping video keeps
billing. Shipping this soon is the mitigation.

**What Cloudflare actually bills** (Stream pricing, thumbnail and download docs, read
2026-09-10): $1 per 1,000 minutes of video delivered; "client-side preloading and
buffering is counted as billable delivery"; web/HLS delivery is "rounded to the
segment length" — 4 seconds for uploaded video; content replayed from the client's
cache is not billed; an MP4 download is billed "for the duration of the video each
time the MP4 for the video is downloaded". "Viewing animated thumbnails does not
count toward billed minutes delivered", and thumbnail images are not on the billed
list at all.

**How it behaves now:**
- **Explore previews (tiles and the Laybell TV banner) are moving stills** — four
  moments of the video cross-fading under a slow zoom, built from Cloudflare thumbnail
  frames. No video plays in the grid, so browsing Explore costs nothing on the bill.
  Owner's choice, 2026-09-10, over short capped clips (~$0.25 per 1,000 previews) and
  keeping video (up to 3 streams at once, ~$3 per 1,000 browsing minutes).
- **Other previews nobody opened** — home-feed autoplay, profile loops, slideshow
  clips, inline TV ad tiles — **pause** after 5 minutes untouched and resume from the
  same frame on a touch.
- **Videos somebody opened** — post viewer, stories, live, ads — **finish what is
  playing** and do not repeat; a touch restarts one that ended. The screen stays on
  while it plays.
- **Lean-back watching gets an hour.** Reels auto-scroll, Laybell TV over AirPlay
  ("Still watching?") and Laybell TV over Cast keep rolling until nobody has touched
  the phone for an hour, then stop after what is playing. Owner's choice, 2026-09-10:
  hands-free viewers see no change; a phone left on reels costs at most ~6 cents.
- **Autoplay runs only on the screen that is on top** — nothing streams behind a
  screen opened over it.

**Built and verified in code:**
- [x] Presence clocks, pure and fake-clock tested — 22/22, including a thousand
      touches re-arming the timer at most once and no timer running while idle. Two
      instances now (5 minutes, 1 hour), fed by the same touches.
- [x] Idle rules, pure and tested — `lib/idleLoopCore.ts`, 25/25.
- [x] `hooks/useIdleAwareLoop` owns `loop` in AppVideo, FeedVideo and ReelVideo.
      Previews opt in with `whenIdle: 'pause'` / `idleBehavior="pause"`; reels opt in
      to the hour clock with `leanBack`. Manual trim loops pause at trimEnd while
      idle; FeedVideo's self-heal stands down while idle.
- [x] A player handed to a surface while already idle is checked on arrival — its
      play() can land before the listener attaches.
- [x] **Keep-awake is left on.** Releasing it at idle locks the screen almost at once
      and would have cut off live streams and long posts mid-watch. Paused and
      finished videos don't hold the screen anyway.
- [x] **Moving stills** — `components/PreviewStills.tsx` + `lib/previewFrames.ts`
      (frame times, 14/14 tests: spread across the trim window or whole video, whole
      seconds for cache hits, never past the end — Cloudflare answers that with a
      400). Live check: 16/16 frame URLs for the real posts return images, ~60 KB
      each. Posts without a stored thumbnail now get Cloudflare's poster frame.
      `GridVideo` and the explore player pool are deleted. Explore previews no
      longer count as views (nothing reports watch time).
- [x] **Rejected: Cloudflare animated GIFs.** Unbilled, but measured on real posts a
      3-second GIF at 360p was ~3 MB, 4 seconds at 480p 8–9 MB, first generation up
      to 9 s, and 640p is refused outright (HTTP 400). Even the smallest loop worth
      showing — 2 seconds at 240p, 8 fps, visibly blurry at tile size — came to
      ~1 MB with a 3.3–3.7 s first load.
- [x] **Lean-back hour** — `LEAN_BACK_IDLE_MS` (was `TV_IDLE_MS`) drives reels
      auto-scroll (ReelVideo + the landscape overlay), the AirPlay "Still watching?",
      and a new guard on Cast autoplay-next, which had no limit at all.
- [x] Covered screens stop their previews: `ExploreGrid` and `TVVideoList` gated on
      focus; TV ad tiles also pause while the ad viewer is open.
- [x] Post viewer video gated on focus (it played under pushed screens).
- [x] tsc clean in app code.

**Not built — near-free real video loops, if stills ever feel too still.** Real video
cannot loop for free, but it can come close: give each post a 5-second Cloudflare
clip (`POST /stream/clip` with `clippedFromVideoUID`, `startTimeSeconds`,
`endTimeSeconds`), enable its MP4 download, and loop that MP4 with expo-video's
`useCaching` (1 GB LRU cache on the phone). Each phone pays ~5 seconds of delivery the
first time it shows a given preview — about $1 per 12,000 first views, e.g. ~$4/month
for 1,000 users who each see 50 different previews — and every loop and revisit after
that plays from the phone. It has to be MP4: expo-video "cannot" cache HLS on iOS, so
looping the existing stream bills every pass. Costs of building it: a clip job per
post plus a backfill, clip deletion alongside the post, teaching `stream-sweep` that
clips are not orphans, and bringing a video player back into the grid. **Owner's
decision (2026-09-10): keep the stills.**

**Dev builds narrate.** Previews go idle after **1 minute** and lean-back after
**2 minutes** (production: 5 minutes, 1 hour), announced at startup by
`[presence] dev build`. Every decision logs the playhead — `[idle] preview paused at
106.5s of 181s` … `resumed at 106.5s` — hour-clock surfaces are tagged
`(hour clock)`, and `⚠ preview STILL PLAYING while idle` appears if anything slips
past. **Read device results off the Metro log.** Fully restart the app first: a hot
reload leaves stale presence clocks logging.

**Dev builds also hold the screen awake by themselves** — `expo/src/launch/withDevTools`
calls `useKeepAwake` under `__DEV__` — so whether the phone auto-locks once a video
stops can only be seen on a production (TestFlight) build.

**Verified on a device (iPhone, dev build, 2026-09-10):**
- [x] **Explore video previews paused and resumed in place** (181s clip 106.5s →
      106.5s; 705s post 106.3s → 106.4s) and stayed paused through ~3 idle minutes
      (174.7s → 174.7s, tripwire silent). *Superseded by moving stills, but it proved
      the idle rules that feed, profile and TV tiles still use.*
- [x] **A video you open finishes its pass, then stops** — a 181s reel went on from
      58.8s to `stopped at 180.9s`, no repeat, no auto-advance while idle. Unlocking
      restarted it and the pager moved to the next reel.
- [x] **Covered screens** — before the fix, both Explore previews were caught playing
      behind that reel (paused at 91.5s and 92.1s while it stood at 58.8s). After it,
      the idle edge logged only `opened video finishing its pass at 58.9s`.
      *Explore attempt history: attempt 1, "it still loops", no `[presence]` line —
      under the 5-minute threshold, so dev builds now use 1 minute. Attempt 2, the
      rule was "finish the current pass" for everything, and a multi-minute preview's
      pass is the whole video. Previews now pause.*
- [x] **Reels hands-free ride the hour clock** — a 181s reel left untouched logged
      nothing at the 1-minute mark (the old rule stopped reels there), then
      `LEAN-BACK IDLE` at 2 minutes with the reel at 117.7s (`finishing its pass …
      (hour clock)`), and stopped at 180.9s.
- [x] **Moving stills** — the owner saw them on device, asked whether previews could
      loop as video for free, and chose to keep the stills.

**Still to verify on a device:**
- [ ] **On the TestFlight build:** a video you opened keeps the screen on to its end,
      then the phone auto-locks.
- [ ] Home feed autoplay pauses and resumes in place.
- [ ] A touch inside the **comments sheet over a reel** counts as presence. Touches
      inside RN `Modal`s are expected to bubble to the root observer, but that is
      unproven on device; if they don't, add `markInteraction` to CommentsSheet.
- [ ] AirPlay "Still watching?" appears and Keep watching resumes the right item;
      Cast stops rolling after the (dev: 2-minute) mark.
- [ ] Watch uid `7bb324123566a2c228e9635d15915a6d` in Stream after release. It is a
      30-day rolling figure, so it will not fall at once — it should stop climbing
      faster than views × 11.8 once users are on 1.0.3.

**Known limit.** A live stream has no end to finish, so a phone left on one stays
awake until the broadcast ends — as on other live apps. If that ever shows on the
bill, reuse the "Still watching?" prompt for live.

## Video editor, part 1 — timed captions and emoji (built 2026-09-10)

**Owner decisions, 2026-09-10:** the editor comes before the reliability batch, and
the overlays are **drawn by Laybell, not burned into the file** — a video saved to a
phone or shared outside the app carries none of them.

Built on the caption system vertical videos already had (StickerLayer →
`posts.captions`, drawn by the feed and reels). What it lacked was WHEN.

**Built and verified in code (commit `dd4678e`):**
- [x] **Timing** — `lib/stickerTiming.ts`, pure, 32/32 tests including a
      2,000-caption round trip. Seconds on the published video's clock; an open side
      means "from the start" / "to the end"; within a quarter second of an edge snaps
      to it; half a second minimum.
- [x] **Editor** — `components/VideoStickerEditor.tsx` + `components/StickerTimeline.tsx`.
      The clip plays behind the captions (it showed a still poster). The timeline
      scrubs the posted window over a filmstrip; the selected caption's bar sets when
      it shows, and the video follows the end being dragged. A caption added mid-clip
      starts at the playhead. Emoji tray (the data model supported emoji; nothing
      could add one). Only captions on screen at the playhead are shown, so the editor
      plays back like the app. 20-caption cap. Clips the player cannot open (iOS
      `ph://`) fall back to the poster with a working timeline.
- [x] **Publish split** — captions covering the whole clip go to `posts.captions`,
      which every version draws; timed ones go to **`posts.timed_captions`**. A
      separate column because 1.0.1/1.0.2 draw `posts.captions` whole: a timed caption
      stored there would sit on those apps for the entire video over every other one.
      Older apps show the video without the timed captions instead. A physically cut
      upload shifts the times back by the trim; the insert retries without the column
      if PostgREST has not seen it.
- [x] **`supabase/sql/post_timed_captions.sql` APPLIED to production 2026-09-10** —
      column is jsonb, shape check present, 0 rows. Additive; live apps never touch it.
- [x] **Playback** — `components/TimedStickers` + `lib/playbackClock` in the feed, the
      reel viewer and the post viewer, which never showed captions at all. Re-renders
      only when a caption enters or leaves.
- [x] **Adjacent fixes** — a vertical clip's caption text now goes through the
      objectionable-text gate (it never did); caption ids are time-stamped (a draft
      restored in a later session could reuse one).
- [x] New strings in all ten locales; tsc clean; the dev server builds it.
- [x] **Device fix 1 — camera-roll clips play** (`5652a90`). The first test was a black
      screen: a camera-roll pick is a file:// URL into the Photos store that the player opens
      but cannot read (`lib/upload.ts` ensureLocalFile documents it). The editor plays
      ensureLocalFile's copy — the same file the upload makes, already there from the prewarm
      (10 ms). ensureLocalFile now allows one copy per destination at a time; AppVideo gained
      `retryLoadErrors` / `onLoadError`.
- [x] **Device fix 2 — the whole clip shows** (`926459c`). "Pretty zoomed in": the editor
      filled the screen the way reels do. It now fits the clip (contain); captions are
      screen-relative everywhere, so they still land on the same spot.

**Verified on a device (iPhone, dev build, 2026-09-10):**
- [x] The editor plays the picked clip, whole and uncropped, after the two fixes above.
- [x] The controls work — in the owner's words, "the elements work pretty well", and the
      fitted clip "looks better now".

**Still to verify on a device — pick up here:**
- [ ] Timing in detail: a caption added mid-clip starts at the playhead; dragging its bar's
      ends moves the video to that frame; it disappears outside its window.
- [ ] Emoji from the tray; move, pinch, drop on the trash.
- [ ] Post it, then check the feed, the reel viewer and the post viewer: captions come and go
      on cue. It is a real post — delete it afterwards if it was only a test.
- [ ] A long clip trimmed to a window: timing still lines up after upload.

**Not in part 1:** horizontal clips (their band captions are unchanged), stories,
and anything that re-encodes — speed, voiceover, burned-in export. Those need a new
native video library and the owner's explicit yes (`docs/VIDEO_EDITOR_PLAN.md`).

## Video editor, part 2 — the song's part and the sound mix (built 2026-09-11)

**Owner request, 2026-09-11:** let a song's volume be set against the video's own
volume so both can be heard, and let a video use a chosen part of a song instead of
always its beginning.

**How it behaves:** a video post with a song (not a music video) gets a **Sound** row
in the composer. Its editor plays the clip with the song, lets you drag across the
song to choose the part that plays, and has two volume sliders — the song, and the
video's own sound. In the app the song starts at that part when the video starts,
goes back to it every time the video loops, and follows the video when it is
scrubbed; the one sound button mutes both. A post published without it sounds
exactly as before (song at full volume, video silent), and so does every post on
1.0.1/1.0.2, which never read the new columns.

**Built and verified in code:**
- [x] **Rules** — `lib/songMix.ts`, pure, 27/27 tests (defaults, clamping, the latest
      start that still fills the video, where the song should be while the video
      plays, wraps, column rounding inside the database check). `lib/waveformBars.ts`
      moved out of ImmersivePlayer; a test proves every song draws the same bars.
- [x] **`supabase/sql/post_song_mix.sql` APPLIED to production 2026-09-11** —
      `song_start_sec`, `song_volume`, `video_volume` (real, nullable) and the
      `posts_song_mix_range` check, verified. Additive; live apps never touch them.
      The upload queue retries without them if PostgREST has not seen them.
- [x] **Editor** — `components/SongMixEditor.tsx`: the clip from its app-storage copy
      (`hooks/usePlayableClip`), the song through the ambient player, a synthetic
      waveform strip with a window the length of the posted clip, JS sliders (no
      native module), a mute toggle. Saved per song — pick another song and it starts
      fresh. Drafts keep it.
- [x] **Song player** (`contexts/PostMusicContext`) — `playSong(host, song, url, mix)`
      sets the level and part. A mixed song follows its video through
      `lib/playbackClock` (back in line on every loop or scrub back, drift past 2.5 s
      corrected) and returns to its part at its end instead of 0:00. **Seeks run only
      on a loaded source and never overlap a song change** — iOS raises an exception
      when seeking an item that is not ready, which would crash the app.
- [x] **Fixed on the way:** two posts in a row sharing a song, the second landed while
      the song was still loading → that load was aborted and the second post stayed
      silent. The load now carries on for the post you are on.
- [x] **Video volume** — FeedVideo, ReelVideo and AppVideo take `volume`; pooled
      players reset it on every hand-off, so one post's mix never leaks into the next.
      Wired into the feed, reels (including the landscape overlay, which now reports
      its position) and the post viewer.
- [x] 9 new strings in all ten locales; tsc clean in app code; the dev server builds it.

**Still to verify on a device — pick up here:**
- [ ] Composer: a vertical video + a song → **Sound** → clip and song play together;
      dragging the song strip restarts both at the new part; both sliders change the
      sound live; Save shows e.g. "From 0:42 · song 80% · video 30%".
- [ ] Post it, then check the feed, the reel viewer and the post viewer: the song starts
      at its part, the video's own sound plays at its level, both return to the start
      on every loop, and the sound button mutes both. Delete the post if it was a test.
- [ ] An older song post (no mix) sounds exactly as before.
- [ ] Scroll between two posts that use the same song.
- [ ] With your own track in the mini-player a mixed post stays quiet; close the track
      and its song starts at its part.
- [ ] A long clip trimmed to a window: the part lines up with the trimmed start.

**Not in part 2:** image and slideshow posts (no video sound to balance — their song
goes to the main player), stories, and a mix burned into the file.

## Video editor, part 3 — one studio for everything (built 2026-09-11)

**Owner request, 2026-09-11:** instead of separate screens, one extra interface that
shows up after the content is chosen — the way Arrange appears before the share page
for a slideshow — with the music selector, the volume controls and the screen caption
all on it.

**How it behaves:** picking a video (and trimming it, when it is long) now opens
**Edit video**, a full-screen editor, before the share page. The clip plays with the
timeline along the bottom and a column of tools on the right:
- **Text** and **Emoji** — captions placed on the clip and timed, as in part 1. On a
  horizontal clip, Text opens its letterbox band captions.
- **Music** — add, change or remove the song, and the "This is a music video" switch.
- **Sound** — the song's part and the two volume sliders from part 2 (hidden for a
  music video, whose song never plays).
- **Cover** — the cover frame picker.

Next goes to the share page; Back returns to the picker (or to Trim). On the share page
a video's Music field became a **Video** field that shows the song and leads back into
the studio; the music-video switch, the Sound row and the caption row are gone from
there. Images and slideshows are unchanged.

**Built and verified in code:**
- [x] `components/VideoStudio.tsx` is the studio; `components/SoundControls.tsx` holds
      the song strip and volume slider. `components/VideoStickerEditor.tsx` and
      `components/SongMixEditor.tsx` are deleted — their behaviour lives on in the
      studio unchanged (captions, emoji, timing, the song's part, the levels).
- [x] **A full-screen Modal, although it is a composer step.** The tab bar is an overlay
      that every tab screen is laid out above, so a step drawn inside the tab cannot
      reach the bottom of the screen — and captions are placed against the whole
      screen, the way the reel viewer draws them.
- [x] Flow: pick → Trim (long clips) → studio → details, and details' Back returns to
      the studio. The upload prewarm starts at the studio, and the user's own track
      stops there so the song preview can play.
- [x] Captions and the mix are handed back on Back/Next, so dragging re-renders the
      studio, not the composer; the song, the music-video switch, the cover and band
      captions update the post at once. A mix reaches the post only if it was set.
- [x] Strings under `videoStudio.*` in all ten locales (`studio.*` belongs to the live
      Studio); the sound editor's three unused strings removed; tsc clean in app code;
      the dev server builds it.

**Still to verify on a device — pick up here** (replaces part 2's composer check):
- [ ] Pick a vertical video → **Edit video** opens full screen: clip playing, tools on
      the right, timeline at the bottom.
- [ ] Text: tap the clip to add a caption and time it on the timeline; Emoji adds from
      the tray; drag one onto the trash.
- [ ] Music: add a song (it plays with the clip), change it, remove it. Flip "This is a
      music video": the song clears, the picker offers only your songs, Sound goes.
- [ ] Sound: drag the song strip (both restart at the new part); both sliders change the
      sound live; the top speaker button mutes.
- [ ] Cover: pick a frame; it shows on the share page.
- [ ] Next → the share page shows **Video** with the song; tapping it (or Back) returns
      to the studio with everything still there.
- [ ] A horizontal video: Text opens the band caption editor, and there is no Emoji.
- [ ] A long video: Trim → studio; captions and the song's part line up with the
      trimmed window.
- [ ] Post one, then run part 2's playback checks (feed, reels, post viewer).

## Video editor, part 3 — polish after the first studio test (2026-09-11)

**Owner feedback:** a good start; the caption timer did not work (the caption showed
throughout the video); the Music button should open the song list straight away rather
than an "Add music" button; choosing a song should go straight to the sound editor; and
the song list should sort into All, Liked (with a like button on each song) and Yours.

**Fixed and built:**
- [x] **Caption timing.** The editor kept the selected caption on screen even while the
      clip played, so it could still be grabbed — and a caption stays selected after it
      is added, so it never left. Now captions come and go with their timing while the
      clip plays, exactly as in the app; paused, the selected one stays on screen, drawn
      faint outside its window. The timing itself was always saved correctly.
- [x] **The Music menu is the song list.** `components/SongBrowser.tsx`, taken out of the
      song picker: tabs **All · Liked · Yours**, search, preview, and a heart on every
      song that likes the actual song (`lib/songLike` — the same write as the player's
      heart: the like, the badge, the artist's notification). The attached song sits on
      top with Sound and remove; the music-video switch stays in this menu.
- [x] **Choosing a song opens Sound** — its part and both levels, straight away. A music
      video's song never plays, so choosing one just closes the menu.
- [x] The sheet picker (images, slideshows, stories) is now a sheet around the same
      browser, so it has the new tabs and hearts too. **Saved was replaced by Yours**
      there, following the requested categories.
- [x] Yours lists your own public songs — a private song's audio would not play for
      anyone watching the post. Music-video mode keeps its one list of songs you made or
      are credited on.
- [x] 2 new strings × 10 locales; tsc clean in app code; the dev server builds it.

**Still to verify on a device:**
- [ ] Add a caption, drag its bar to part of the clip and press play: it shows only
      there. Pause outside its window: it shows faint and can still be moved.
- [ ] Music opens straight to the list; All / Liked / Yours switch; search works; the
      heart likes a song (it then appears under Liked, and liked on the song's page).
- [ ] Tap a song: Sound opens with it playing against the clip; drag the part; set both
      levels.
- [ ] The picker on an image post shows the same tabs and hearts.

## Video editor, part 3 — second polish pass (2026-09-11)

**Owner feedback:** Saved back as a fourth tab; Sound only when a song is actually
attached (not with no song, and not for a music video); no Emoji button; and the cover
button did not work — no frame could be chosen from the video — and felt unfinished.

**Fixed and built:**
- [x] **Saved is the fourth tab** (All · Liked · Yours · Saved), in the studio and in
      the sheet picker. Long tab labels shrink a little rather than truncate.
- [x] **Sound shows only while a song plays over the clip.** Removing the song, or
      switching on "This is a music video", takes the tool away and closes its panel.
- [x] **No Emoji button.** Emoji can still be typed into a caption from the keyboard,
      and emoji captions already in a draft still show and can be moved and timed.
- [x] **Cover, rebuilt inside the studio.** Why no frame could be chosen: the old cover
      sheet decoded its frames from the picked camera-roll URI, which iOS will not let
      the app read — the same wall as the editor's first black screen — so its frame
      strip never appeared. The Cover panel works from the app-storage copy the clip
      plays from: drag (or tap) along a filmstrip of the posted window and the whole
      screen shows that exact frame; let go and it becomes the cover. "From camera roll"
      picks a photo instead. The Cover button shows the current cover, and the share
      page's cover square opens this panel. `components/ThumbnailPickerModal.tsx` is
      deleted; the frames come from `hooks/useFilmstrip`, shared with the caption
      timeline, so the cover strip reuses frames the timeline already made.
- [x] Unused strings removed (the emoji button's and two of the studio's); tsc clean in
      app code; the dev server builds it.

**Still to verify on a device:**
- [ ] Tabs read All · Liked · Yours · Saved, and Saved lists your saved songs.
- [ ] No song → no Sound button; add a song → Sound appears; turn on music video → it goes.
- [ ] Cover: the strip fills with frames; dragging shows each frame full screen; letting
      go sets the cover and the button's thumbnail updates; "From camera roll" works; the
      share page shows the chosen cover, and tapping it opens this panel.

## Scheduled posts, re-editing and posting polish (built 2026-09-11)

**Owner request, 2026-09-11:** schedule posts, re-edit, and other touches that make
posting enjoyable. **Owner decisions:** anyone can schedule, up to 30 days ahead;
editing covers everything but the uploaded file; apply the database change once it is
built and reviewed.

**How it behaves:**
- **Scheduling.** The share page's **Post now** button opens a menu — Post now, or
  Schedule for later, which opens a day-and-time picker; Share becomes Schedule. A scheduled post is saved hidden
  and goes live on the minute, run by the server, so the phone can be off. Whoever it
  tags, mentions, credits or uses a song from is notified when it goes live, not before.
  The author gets a local "Your post is live" reminder. A spotlight goes live the
  moment it attaches, so a post with one cannot be scheduled.
- **Scheduled** (a bar on the picker, and a Settings row) lists waiting posts:
  **Post now**, **Change time**, **Edit**, **Delete**.
- **Re-editing.** Edit post (the ⋯ menu) now covers the caption (counter, @mentions),
  tagged people or a track's credits, genre, visibility, the song on a photo or
  slideshow, mature, GIFs in comments or downloads, a film's title, a track's cover and
  category, and a scheduled post's time. **Edit video** reopens the studio on the posted
  video: on-screen text and its timing, music, sound mix and cover. Only what changed is
  written; closing with changes asks first; the screen you return to shows the edit at once.
- **Posting.** A photo or track that posts ends on a celebration card (View post, Share,
  Done) instead of a toast; videos keep their upload toast, because they can still fail.
  A Share / "Schedule for …" button closes the form. Closing the composer with something
  picked asks to discard or save a draft. Drafts now keep mature, sound consent, music
  video, the cover frame, album and communities.

**Built and verified:**
- [x] **Time rules** — `lib/schedule.ts`, pure, 28/28 tests (the 5-minute grid, 10-minute
      earliest pick, the 30-day limit, local midnights across a clock change, 12/24-hour
      by language, "Today"/"Tomorrow").
- [x] **`supabase/sql/post_scheduling.sql` APPLIED to production 2026-09-11.**
      `posts.publish_at` (null = live) + a partial index; restrictive policy **"Scheduled
      posts hidden until publish"** (author-exempt, by time, so a late job never delays a
      post); `publish_scheduled_posts()` every minute (cron `publish-scheduled-posts`, runs
      as postgres like every other job; execute revoked from public, anon and
      authenticated by name). It moves the post to its publish time and writes the
      mention, tag and song-used notifications and pushes the app would have.
- [x] **Preflight against production:** every object it relies on exists; the four
      posts triggers do not fire on the publisher's update; no view and no user-callable
      definer function hands out post lists; posts is in the realtime publication, which
      applies RLS. **Rolled-back end-to-end test against production: 11/11** — hidden
      signed out and from another account, visible to its author, published with feed
      time = publish time, visible once live, one mention + one tag notification and one
      queued push, and nobody told twice on a re-run. The first cron runs succeeded.
- [x] Client: inline and video paths insert `publish_at` (never retried without it) and
      skip their own mentions, tags, song-used and badge bump; the video isn't pinned to
      Home; drafts keep the time (a lapsed one is dropped).
- [x] **The author's own scheduled posts are filtered out of 30 queries** — feeds,
      search, charts, the song picker, studio radio, albums, Featured, Page layout,
      private posts, profiles, and the Spotlight and Shop pickers (no paying to promote
      a post nobody can see). **Rule: any new list of posts filters `publish_at is null`.**
- [x] **Re-edit:** `app/edit-post/[id].tsx` rewritten; the studio plays the posted stream
      (`hooks/usePlayableClip` passes http through) with Cloudflare thumbnails for the
      timeline, cover strip and chosen cover (`hooks/useFilmstrip`, unbilled); newly
      involved people are notified once, on live posts only; `lib/postEdits` updates Home,
      pinned posts, Explore, profile, reels and the post viewer.
- [x] **Fixed on the way:** the mature switch never reached a video post.
- [x] Strings (`schedule.*`, `editPost.*`, `celebrate.*`, `compose.*`) in all ten
      locales; tsc clean in app code; the dev server builds it.

**Known and accepted:**
- Followers' in-app "posted" banner listens for new rows only, so it stays quiet when a
  scheduled post goes live (its notifications and pushes do go out).
- The Posts badge counts a public scheduled post before it is live (`get_badge_state`).
- On 1.0.1/1.0.2 an author's own scheduled posts show in their feeds; nobody else's app
  ever shows them.
- Editing doesn't change a post's communities or album.

**Still to verify on a device** (test posts are real — delete them afterwards):
- [ ] Schedule a photo ~15 minutes out: celebration says Scheduled; the Scheduled (1)
      bar appears; the post is not in your feed or profile; at the time it appears at the
      top of Home, the tagged/mentioned test account gets its push, and your phone shows
      "Your post is live".
- [ ] Schedule a video: it uploads, is not pinned to Home, and goes live on time.
- [ ] Scheduled screen: Change time, Post now (live within a minute), Edit, Delete.
- [ ] Picker: day chips, wheels snap, AM/PM in English and 24-hour in German, the
      too-soon and 30-day messages.
- [ ] Edit a live video → Edit video: the posted clip plays, frames fill the timeline and
      the cover strip, change text timing, song, sound and cover; Save → the post viewer
      shows it at once.
- [ ] Edit a photo: a new @mention notifies once; tag someone; song; genre; visibility;
      close with changes → Discard / Keep editing.
- [ ] Edit a track: cover art, category, credits, downloads.
- [ ] Composer: the bottom Share / Schedule button; the celebration after a photo or
      track (View post, Share); close with media picked → discard or save a draft; a
      resumed draft keeps mature and communities.

## The share page, reorganised (2026-09-11, owner feedback)

**Owner request:** drop the video's "Edit video" field (Back already returns to the
studio) and put Communities there; put Post now/Schedule and Public/Private side by side,
more iOS-styled; fold the mature-content and GIF switches under a less emphasised
Advanced settings.

**Built:**
- [x] A video's right column is now **Genre** and **Community** (compact "Add"); the Video
      field is gone. Photos and slideshows keep Genre and Music, with Community full width.
- [x] **Who sees it** and **when it goes up** are two menu buttons side by side — an
      iOS-coloured symbol, the choice and a short line under it, and the ⌃⌄ glyph. Each
      opens an iOS-style pull-down menu (`components/PullDownMenu.tsx`, pure JS) from the
      button: Public / Friends only with a tick, and Post now / Schedule for later (or
      Change time), which opens the picker once the menu has closed. A community post
      locks the first, a spotlighted post the second.
- [x] **Advanced settings** — a small grey header that folds open to an iOS inset card:
      Mature content and Allow GIFs (a track: Allow downloads and Mature content), each
      with an ⓘ for its explanation. A dot on the closed header means one of them is off
      its default. A track's sound-use consent stays in view, outside the fold: it is the
      legal basis for others using the song.
- [x] 8 new strings in all ten locales; the replaced styles removed; tsc clean in app
      code; the dev server builds it.
- [x] **Second pass (owner feedback):** the two buttons are rounder and filled with their
      symbol's colour (blue Public, green Friends only, orange Post now, indigo
      Scheduled) with white text and a soft shadow of the same colour; the line under
      each may wrap to two lines rather than cut off, and both stay one height. Advanced
      settings got an icon and a slightly larger, darker label. The header's Share
      became a pill that fits its word — "Schedule" was breaking into "Schedu / le"
      because that slot was a fixed 64 pt — brand orange for Share, indigo with a
      calendar once a time is set.
- [x] **Third pass:** the symbols on the two buttons stand on their own (no circle
      behind them), and the bottom "Schedule for …" button stays black on light / white
      on dark — indigo there as well was too much purple.
- [x] **Fourth pass:** the header's Share / Schedule pill is black on light / white on
      dark too, so both send buttons match. This replaces the 2026-08-28 rule that Share
      wore the brand colour.

**Still to verify on a device:**
- [ ] Header: "Schedule" sits on one line in its pill and the title stays centred (also in
      Russian, the longest).
- [ ] Video: the right column shows Genre and Community, no Video field; Back returns to
      the studio with everything kept.
- [ ] The two buttons sit side by side and don't truncate badly in English and German;
      each menu opens from its button (the right one toward the left), ticks the current
      choice, and Schedule for later opens the picker (iOS: after the menu has gone).
- [ ] Add a community: the visibility button locks to Public.
- [ ] Advanced settings opens and closes smoothly; turning Mature on shows the dot when
      closed; the ⓘ explanations open.

## Save to camera roll — the finished video (built 2026-09-11, needs a new build)

**Owner request, 2026-09-11:** let people save their video to the camera roll, as a switch
in Advanced settings that is on by default. **Owner's decision:** save the FINISHED video —
trimmed, with its song and captions — which JS cannot write, so this release adds the
app's first native module (`modules/laybell-video-export`). Offered and declined: saving
the picked clip only (no native code, but a camera-roll pick is already in the camera
roll).

**How it behaves:** a video post's Advanced settings show **Save to camera roll** (on). On
Share, the app asks for "Add to Photos" once, beside the switch that wants it; without
permission the post goes up regardless and a toast says why there is no copy. The
finished video starts at once, beside the upload, and **works quietly** (the owner's call
after the second device test): nothing on screen while it saves or when it's done — a
toast appears only if a copy couldn't be made. iOS stops an export when the app leaves
the foreground: that copy starts again when the app is back (three tries in all), and
one that fails with the app open gets one more try. One video at a time; the post never
waits on it and a failed copy never touches the post.

**What the saved video contains:**
- The posted window of the ORIGINAL clip (not the compressed upload), up to 1920 px on
  its longest side, H.264/AAC.
- The song from its part, repeating that part to the end, at the song's level; the
  video's own sound at its level — the same defaults the app plays a song post with
  when no mix was set. A music video keeps its own soundtrack.
- A vertical video's captions, timed exactly as in the app: the clip is cut into
  stretches where the same captions show (`lib/exportPlan.ts`, 23/23 tests), and each
  stretch's captions are drawn once into a frame-sized transparent image by the app's
  own caption renderer (`components/CaptionCaptureHost`, mounted under the navigator so
  nothing shows) and laid over the video for that stretch. Positions follow the reel
  viewer: the part of the video a phone screen shows, filled.

**Built:**
- [x] `modules/laybell-video-export` — `getVideoInfo`, `captureView`, `exportVideo`.
      iOS: AVMutableComposition + AVVideoCompositionCoreAnimationTool (timed layers) +
      AVMutableAudioMix, AVAssetExportSession (the iOS 18 export call behind
      #available). Android: Media3 Transformer **1.8.0** (the release expo-video and
      expo-audio pin): Presentation, one BitmapOverlay composing the images (Media3 allows
      15 overlays and samples each on every pixel), ChannelMixingAudioProcessor levels, the
      song as a looping sequence, HDR tone-mapped to SDR on API 29+. No FFmpeg.
- [x] Optional require (`requireOptionalNativeModule` from 'expo'): on any build without
      the module the switch simply isn't shown. Autolinking resolves it on both
      platforms.
- [x] `lib/videoExport.ts` (permission, queue, song download, caption images, export,
      save, retries, cleanup), `components/VideoSavedToast`, queued by the composer at
      Share, drafts keep the switch, films never offer it, its strings in all ten locales.
- [x] `app.json`: the photo-library add permission now reads "save your videos and
      stories" (it said stories only) — a native change, part of the same rebuild.
- [x] tsc clean in app code; the dev server builds it. **The Swift and Kotlin have NOT
      been compiled** — no Xcode or Android SDK on the machine they were written on. An
      independent line-by-line review against the installed Expo Modules sources, the
      Media3 1.8.0 source and Apple's API reference found no compile errors; its runtime
      notes were applied (a song's picture track dropped on Android, an empty clip-audio
      track left out on iOS, caption PNGs encoded off the main thread).
- [x] **iOS compiles:** development build `4765eb17-adfa-4752-8dd8-8c82b88211d8` (EAS,
      2026-09-11) finished on the first attempt with the module in it. Android has not
      been built yet — its first build is the Kotlin's first compile.

**Known limits:**
- A horizontal video with band captions is saved as a vertical (9:16) video, its captions
  in the bands; without captions it keeps its own shape. A build whose exporter lacks
  `videoFit` saves no copy of one with captions.
- Films (Premium+, past 9 minutes) don't offer it — too long to re-encode on a phone.
- iOS stops an export when the app goes to the background; it starts over when the app is
  back (three tries in all), so a long video saves fastest with Laybell left open.
- Android encodes a portrait video as landscape plus a rotation flag (Media3's default);
  galleries honour the flag.

**Before testing: a new development build** (done 2026-09-11: `4765eb17`) — native code and
`app.json` changed, so an older dev client won't have it (the switch stays hidden there):

```bash
eas build --profile development --platform ios
```

**Device test 1 (2026-09-11, dev build `4765eb17`): no video reached Photos**, and not one
`[save-video]` line reached the Metro log, so the cause is not proven. Three weak spots
could each explain it; all are fixed in JS, which that dev build picks up from Metro:
- **It started too late.** The copy waited for the upload's row insert — by then the
  person has often left the app to look in Photos, and iOS stops an export in the
  background. It now starts at Share, beside the upload, and starts again on return.
- **Captions that change mid-clip made it wait forever.** Each caption image is a mount
  in `CaptionCaptureHost`. The next image's request arrived before the last one's
  unmount rendered, so the two shared a render: the view stayed in place at the same
  layout, never reported a layout again, and never captured. Every image is now its own
  mount (a key), and an image not back within 15 seconds fails the attempt out loud.
- **Nothing said anything.** Saving showed nothing until the end, a denied permission
  was silent, and only failures were logged. Now a "Saving…" toast, a toast for denied
  permission, and every step under `[save-video]` in the dev log: whether the exporter is
  in the build (at launch), the decision at Share, permission, clip, captions, song,
  export time, outcome.

**Device test 2 (2026-09-11): saved.** The video reached Photos. The owner then asked
for no "Saving" popup — just save it when the switch is on. Now silent: the "Saving…"
and "Saved" toasts and their strings are gone, and only a failure speaks.

**Still to verify on a device (new dev build):**
- [x] A video posted with the switch on reaches Photos (device test 2).
- [ ] A vertical video with timed captions and a song: nothing shows while it saves, and
      Photos has the video — trimmed, captions appearing and leaving on cue in the right
      places, the song at its part and level, the video's own sound at its level.
- [ ] Leave Laybell mid-save and come back: it starts again and still saves.
- [ ] Caption looks: fonts, pills ("boxy"), neon glow and shadows match the app, no dark
      fringes around soft edges (Android), nothing upside down (iOS).
- [ ] A clip recorded sideways or upside down comes out upright.
- [ ] No song; a music video; a long clip trimmed to a window; an HDR iPhone clip.
- [ ] Deny "Add to Photos": the post still goes up; a toast says why there's no copy.
- [ ] Switch off: no copy. A resumed draft keeps the switch.
- [ ] Nothing flashes on screen while the caption images are drawn.

## Horizontal videos — captions in the letterbox bands (built 2026-09-11)

**Owner request, 2026-09-11:** edit horizontal videos the way vertical ones are edited,
but only allow text in the top and bottom areas — the black bands around a landscape
clip in the upright reel. Turned sideways, the video plays full screen with no text.

**How it behaves:** the studio's Text tool works on a horizontal clip as it does on a
vertical one — tap to add, type with the same fonts, colours and backgrounds, drag,
pinch, rotate, drop on the trash, and time each caption on the timeline — except that a
caption lives inside the top or the bottom band. It's kept there live while it's dragged
(past the middle of the picture it moves to the other band), and shrunk if it won't fit.
A tap in a band adds a caption there; a tap on the picture plays and pauses. The bands
are outlined while there are no captions yet and while one is dragged, with the rotate
pill the reel parks above the picture. The old one-bubble band editor is gone.

**Every phone, same placement:** a band caption's height is stored inside its band, not
down the screen, and every surface fits it into the band the phone at hand leaves —
moved in from the edges, shrunk if needed — so it never lands on the picture. A band a
phone has no room for (an iPhone SE leaves no bottom band on a 16:9 clip) shows nothing;
the studio moves such captions to the other band for editing.

**Storage and older apps:** band captions go in `posts.timed_captions` (each with a
`band`), timed or not — never `posts.captions`, which 1.0.1 and 1.0.2 draw over the feed
card of ANY video. For those apps, publishing also writes one bubble per band
(`top_caption` / `bottom_caption`) from the whole-video captions, top to bottom as lines,
dressed like the first; 1.0.3 draws the band captions and never those bubbles. Timed band
captions don't reach older apps. Older posts and drafts with only bubbles open in the
studio as band captions. No server change.

**Built:**
- [x] `lib/bandCaptions.ts` — the zones (moved from `components/TopCaption`), which band a
      tap or a drag belongs to, fitting a caption into a band, band ↔ screen positions,
      the bubble for older apps and back. **60/60 tests.** `lib/stickerTiming.ts` gained
      `timingForPublish` (the split's timing rule, in order); its 32 tests still pass.
- [x] `components/StickerLayer.tsx` — an optional `constrain`, applied while a sticker is
      dragged or pinched and whenever it's laid out. Only the horizontal studio passes it,
      so stories and vertical clips are unchanged.
- [x] `components/VideoStudio.tsx` — the horizontal Text tool, taps, band outlines, hint.
- [x] `components/BandStickers.tsx` and `TimedStickers` `bandRatio` — the reel draws band
      captions, timed like any other; every other surface skips them.
- [x] Composer, drafts, the edit screen and the upload queue: band captions in
      `timed_captions`, bubbles for older apps, old bubbles converted for editing.
      `components/TopCaptionEditor.tsx` and its 3 strings removed; `videoStudio.bandHint`
      added in all ten locales. tsc clean; the dev server builds it.
- [x] An independent review found three problems, all fixed: opening and closing the
      studio rewrote an older post's captions and marked the edit unsaved (untouched
      captions now go back exactly as they came); the bubble for older apps could grow
      onto the picture on a small phone (now at most two rows at its default size, cut
      short with an ellipsis); and a video with no recorded shape was edited as vertical
      but shown as horizontal (the edit screen now assumes 16:9, like every viewer).

**Device test 1 (2026-09-11):** the owner reports the editor and the upright reel work and
look right, with two problems, both fixed:
- **A thin flickering line above and below the picture** in the upright reel. The poster
  sits under the player for the handoff, and was drawn `contain` across the whole screen:
  wherever it was a hair taller than the video (a chosen cover, a re-encoded frame) it
  peeked out at the picture's edges. It's now cut to the picture's own rectangle, a point
  short at the top and bottom (`app/reel/[id].tsx`). JS only. The sideways overlay was
  never affected: its player hides the poster once the first frame shows.
- **The saved copy had the song but not the captions** — they live in the bands, outside
  the picture. A horizontal clip with band captions is now saved as a VERTICAL video,
  1080×1920: the clip across the middle and the captions in the bands, as the app shows it
  upright (`exportBandZone`: a margin from the frame's edges and a gap from the picture,
  each caption keeping its place inside its band; 5 more tests, 72/72). Without captions
  it keeps its own shape. (A horizontal copy with the captions over the picture was built
  in between on a mistyped instruction, and taken back out.) The exporter had to learn to
  FIT a clip in a frame (iOS stretched it; Android already letterboxed), so the module
  gained `videoFit` and `canFitVideo()` — **native: a new development build**. A build
  without them saves no copy of such a clip (the owner's other option: not at all), never
  a stretched picture or one without its captions.
- **Device test 2 (dev build `847a40c8`): the copy was black, with the right sound.** A
  dev-only diagnostic sent this machine, over the LAN, the caption image and frames from
  test exports: the caption image was right (transparent, captions in the bands), the
  upright export WITHOUT captions was right, and every export WITH them — upright or in
  the clip's own shape — was black, picture and captions alike. So iOS's
  `AVVideoCompositionCoreAnimationTool` drew nothing, and a vertical video with captions
  would have saved black too. Captions now go on in a second pass with Core Image, over the
  finished picture file, and caption images are drawn 8-bit (a wide-colour phone drew
  them 16-bit). Native: dev build `4aeda204`, compiled first try. **Device test 3: works** —
  a horizontal video with captions saved upright, its captions in the bands, its song mixed in.

**Still to verify on a device (JS only — the current dev build picks it up):**
- [ ] The upright reel of a horizontal video: no line above or below the picture, while
      it plays and before the first frame.
- [x] **Dev build `4aeda204`:** a horizontal video with band captions and a song saves as a
      vertical video — the clip across the middle, the captions in the bands where they
      were placed and timed as in the app, the song at its part and level. One without
      captions saves as it is.
- [ ] A horizontal clip in the studio: Text adds a caption in the top band; a tap in the
      bottom band adds one there; a tap on the picture pauses; dragging keeps captions in
      the bands (past the middle they switch band); a big pinch stops at the band's size.
- [ ] Timing on a horizontal clip: captions come and go on cue, in the studio and the reel.
- [ ] Posted: the reel shows the captions where they were placed; turning the phone
      sideways hides them; the home feed card shows none.
- [ ] Re-edit that post: the captions come back where they were; leaving without changes
      doesn't ask to discard.
- [ ] An older horizontal post with bubbles opens in the studio as captions, and saving
      writes them back.
- [ ] The App Store build (1.0.2) viewing a new horizontal post: the bubbles show in the
      bands; the feed card shows no text.

## Archived posts — hidden everywhere but the archive (2026-09-11)

**Owner report, 2026-09-11:** archived posts showed up in the reels feed. An archived post
should show nowhere except its author's archive.

**Cause:** archiving was enforced only in app code, query by query
(`supabase/sql/post_archive.sql`), and the reels feed query never had the filter — in every
app version.

**Fix:**
- [x] **Server, APPLIED 2026-09-11:** `supabase/sql/post_archive_visibility.sql` — a
      restrictive, author-exempt policy on `posts`, like the scheduled-post and takedown
      ones: an archived post is invisible to everyone but its author, on every surface and
      in every app already installed. Tested first against production in a rolled-back
      transaction, 8/8: visible while live; hidden signed out and from another account once
      archived; that account can't change it; its author still sees it and can restore it;
      visible to others again once restored.
- [x] The reels feed skips archived posts, so an author's own don't play there either (the
      policy lets authors read their own).
- [x] The author's own lists: an audit of every post query found eleven more that could
      show you your own archived posts, all now filtered — reposts of your posts, the
      Reposts tab on both profiles, album shelves and tracklists, the song picker's search,
      the shop's post picker, notifications about the post, the Scheduled list, Spotlight
      campaign cards (the post reads as unavailable), Home's pinned just-posted posts, and
      offline downloads (purged at the next online check). No security-definer function,
      view or edge function hands posts to viewers without the filter.

**Consequences, by design:** to everyone else an archived post is as good as deleted until
it's restored — it drops out of feeds, profiles, playlists, saves and shared links, and an
archived song stops playing on other people's videos that use it.

**Still to verify on a device:**
- [ ] Archive a video: gone from the reels feed, the home feed and explore, and from another
      account's view of your profile; there in your archive; back everywhere once restored.

## Record in the composer — the story camera (built 2026-09-11)

**Owner request, 2026-09-11:** record a video in Laybell "in a capturing interface identical
to the story capturer", and go from there to the video editor.

**Built (JS only — no new dev build):**
- [x] **One camera, two ways in.** The story camera's capture screen moved out of
      `app/(tabs)/story-camera.tsx` whole, into `components/CaptureCamera.tsx`: the shutter
      (tap = photo, hold = video, tap again to stop), pinch and slide-to-zoom, tap to focus,
      double-tap to flip, flash and torch, the 3 s / 10 s timer, the ultra-wide lens, the
      front camera's screen flash and the recording bar. The story screen wraps it with its
      editor, so the two cameras can't drift apart.
- [x] **The composer's camera tile** (the first cell of the photo grid) opens that camera
      instead of the system camera, which only took photos. A recording goes straight to the
      video editor, through the trimmer first only if it runs past the window (the same rule
      as Next), and stops at 3 minutes. In a slideshow it becomes the next slide and stops at
      whatever the 60-second video budget has left. A photo is picked as before (a slide in a
      slideshow).
- [x] **One camera view at a time.** The story camera stays mounted on its page, and on
      Android two live camera views break each other: expo-camera's `active` is iOS-only, and
      each view binds and unbinds through CameraX's process-wide `unbindAll()`, never
      re-binding by itself. Left alone, the story camera would sit black after the composer's
      closed. Only the newest open camera holds a view; the story camera gets its view back
      150 ms after the composer's camera closes.

**Device test 1 (2026-09-11, owner): "I tested it and it works."** The camera tile opens the
camera and a recording goes straight into the video editor.

**Not reported item by item, so still worth a look before release:**
- [ ] Posting a recording (captions, music, cover), and Save to camera roll saving it.
- [ ] Take a photo from the tile: it's picked in the composer, as before.
- [ ] Slideshow mode: a recording is added as a slide and stops at the budget left.
- [ ] X and the library button both close the camera back to the grid.
- [ ] Afterwards, swipe to the story camera: live, not black. Take a photo and record a story
      as before (its code moved).
- [ ] Recording pauses a playing song, as in stories; the editor's sound plays normally
      after a recording.

## Owner, not code
- [ ] **Cloudflare budget alert** (Billing → Billable usage → Create budget alert),
      e.g. $10/month, so the next leak is an email instead of a surprise.
- [ ] **Play listing** still says Laybell TV works by turning the phone sideways.

## Carried over from 1.0.2 — the reliability batch, queued behind the editor
- [ ] Android 1.0.2 still unsubmitted — needs the Play service-account key
      (`docs/PLAY_SERVICE_ACCOUNT.md`).
- [ ] Realtime screens still depend on the publication alone — the slow poll is owed.
- [ ] Prune dead push tokens (Expo `DeviceNotRegistered` receipts are never read).
- [ ] Play build warnings: re-run the 16 KB ELF alignment check on the AAB,
      edge-to-edge deprecations, large-screen resizability.
