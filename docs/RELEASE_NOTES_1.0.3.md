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
Video is kinder to your battery and data. Explore previews are now moving stills that use a fraction of the data. Other previews pause once your phone has been put down for a few minutes and carry on when you come back, and a video you opened plays to its end instead of looping with nobody watching. Reels and Laybell TV keep going hands-free for up to an hour.

Plus fixes and polish throughout.
```

---

## App Store — "What's New in This Version" (≤4000 chars)

```
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

**What Cloudflare actually bills** (Stream pricing + thumbnail docs, read
2026-09-10): $1 per 1,000 minutes of video delivered; "client-side preloading and
buffering is counted as billable delivery"; web/HLS delivery is "rounded to the
segment length" — 4 seconds for uploaded video; content replayed from the client's
cache is not billed. "Viewing animated thumbnails does not count toward billed
minutes delivered", and thumbnail images are not on the billed list at all.

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
      to 9 s, and 640p is refused outright (HTTP 400).
- [x] **Lean-back hour** — `LEAN_BACK_IDLE_MS` (was `TV_IDLE_MS`) drives reels
      auto-scroll (ReelVideo + the landscape overlay), the AirPlay "Still watching?",
      and a new guard on Cast autoplay-next, which had no limit at all.
- [x] Covered screens stop their previews: `ExploreGrid` and `TVVideoList` gated on
      focus; TV ad tiles also pause while the ad viewer is open.
- [x] Post viewer video gated on focus (it played under pushed screens).
- [x] tsc clean in app code.

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

**Still to verify on a device:**
- [ ] **Moving stills look right** — Explore tiles and the Laybell TV banner
      cross-fade and zoom; a post without a thumbnail shows a real poster; tapping
      opens the video.
- [ ] **Reels hands-free** — open a reel and don't touch: past the 1-minute mark it
      keeps auto-scrolling; at the 2-minute mark the log says `LEAN-BACK IDLE`, and the
      current reel finishes with `(hour clock)` and stops.
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

## Owner, not code
- [ ] **Cloudflare budget alert** (Billing → Billable usage → Create budget alert),
      e.g. $10/month, so the next leak is an email instead of a surprise.

## Carried over from 1.0.2
- [ ] Android 1.0.2 still unsubmitted — needs the Play service-account key
      (`docs/PLAY_SERVICE_ACCOUNT.md`).
- [ ] Realtime screens still depend on the publication alone — the slow poll is owed.
