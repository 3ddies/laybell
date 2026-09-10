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
Video is kinder to your battery and data. Autoplaying previews now pause once your phone has been put down for a few minutes, and carry on from the same spot when you come back. A video you opened plays to its end instead of looping with nobody watching, and Laybell TV checks in after an hour of autoplay with nobody tapping.

Plus fixes and polish throughout.
```

---

## App Store — "What's New in This Version" (≤4000 chars)

```
VIDEO THAT KNOWS WHEN YOU HAVE STEPPED AWAY

Video used to keep playing for as long as a phone was left on it — looping over and over, holding the screen awake, and using battery and data with nobody watching. Now, once your phone has sat untouched for a few minutes, the previews that play on their own in Explore, your feed and on profiles pause right where they are, and carry on from the same spot the moment you touch the screen. A video you opened yourself plays to its end and stops there instead of starting over, so nothing you are actually watching gets cut off partway.

Laybell TV over AirPlay does the same for autoplay: after an hour without a tap, it asks whether you are still watching instead of playing on to an empty room.

Videos also no longer keep playing out of sight behind a screen you open on top of them — including the previews in Explore and the ads on Laybell TV.
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

**How it behaves.** Untouched for 5 minutes, each video does what its surface is:
- **Previews nobody opened** — Explore tiles and the Laybell TV banner, home-feed
  autoplay, profile loops, slideshow clips, inline TV tiles — **pause on the spot**,
  and resume from the same frame on a touch.
- **Videos somebody opened** — post viewer, reels, stories, live, ads — **finish what
  is playing** and do not repeat; a touch restarts one that ended. The screen stays
  on while it plays.

And whether anyone is touching or not, **autoplay runs only on the screen that is on
top** — nothing streams behind a screen opened over it.

**Built and verified in code:**
- [x] Presence clock, pure and fake-clock tested — 22/22, including a thousand
      touches re-arming the timer at most once and no timer running while idle.
- [x] Idle rules, pure and tested — `lib/idleLoopCore.ts`, 25/25: previews pause at
      once and resume in place; anything that starts a preview while idle is paused
      again; an opened video finishes, then restarts on return; a story that simply
      ended is never restarted.
- [x] `hooks/useIdleAwareLoop` owns `loop` in AppVideo, FeedVideo, ReelVideo and
      GridVideo. Previews opt in with `whenIdle: 'pause'` / `idleBehavior="pause"`.
      Manual trim loops pause at trimEnd while idle; the FeedVideo/GridVideo
      self-heals stand down while idle.
- [x] A player handed to a surface while already idle (pool reassignment, a banner
      swapping posts) is checked on arrival — its play() can land before the
      listener attaches.
- [x] **Keep-awake is left on.** The first version released it at idle, which locks
      the screen almost at once — the phone's own timeout has already run out by
      then — and would have cut off live streams and long posts mid-watch. Paused
      and finished videos don't hold the screen anyway, so the phone still locks.
- [x] **Covered screens stop their previews.** `ExploreGrid` (Explore tab, Saved,
      Communities) and `TVVideoList` had no focus gate; both now play only while
      their screen is focused, and TV ad tiles also pause while the ad viewer is
      open. Every other autoplay surface already had one (feed, profile grids,
      post, reel, story, live).
- [x] Post viewer video gated on focus (it played under pushed screens).
- [x] AirPlay TV "Still watching?" after 60 minutes untouched, ten locales.
- [x] tsc clean in app code.

**Dev builds narrate.** Idle comes after **1 minute** (production 5; TV asks after
2, production 60), announced at startup by `[presence] dev build`. Every decision
logs the playhead — `[idle] preview paused at 106.5s of 181s` … `[idle] preview
resumed at 106.5s of 181s` — and `⚠ preview STILL PLAYING while idle` appears if
anything slips past. **Read device results off the Metro log**, not off whether a
muted tile seemed to move. Fully restart the app first: a hot reload leaves stale
presence clocks logging.

**Dev builds also hold the screen awake by themselves** — `expo/src/launch/withDevTools`
calls `useKeepAwake` under `__DEV__` — so whether the phone auto-locks once a video
stops can only be seen on a production (TestFlight) build.

**Verified on a device (iPhone, dev build, 2026-09-10):**
- [x] **Explore previews pause and resume in place.** Two previews were playing: the
      181s clip paused at 106.5s and resumed at 106.5s; the 705s one (the leaking
      post's length) paused at 106.3s and resumed at 106.4s.
- [x] **…and stay paused over a long stretch.** Left untouched about 3 minutes: paused
      at 174.7s / 174.5s, resumed at exactly 174.7s / 174.5s, and the tripwire (it
      checks every 10s) never fired.
- [x] **A video you open finishes its pass, then stops.** A 181s reel: at the idle
      mark `finishing its pass at 58.8s`, then played on to `stopped at 180.9s` — no
      repeat, no auto-advance while idle. Unlocking restarted it, which the pager
      read as a wrap and moved to the next reel: what would have happened at the end
      with someone there.
- [x] **That same log exposed the covered-screen leak.** At the idle edge where the
      reel stood at 58.8s, both Explore previews paused at 91.5s and 92.1s — about
      33 seconds ahead of the reel they had opened. They had been playing behind it
      the whole time. Fixed above; not yet re-tested.
      *Explore attempt history: attempt 1, "it still loops" with no `[presence]`
      line — under the 5-minute production threshold, so dev builds now use 1
      minute. Attempt 2, the clock went idle on time, but the rule was "finish the
      current pass" for everything, and a multi-minute preview's current pass is the
      whole video. Previews now pause.*

**Still to verify on a device:**
- [ ] **The covered-screen fix.** Full restart → Explore → tap a video → don't touch.
      At the idle mark the log should show only `opened video finishing its pass` —
      **no `preview paused` lines** (there were two before the fix).
- [ ] **On the TestFlight build:** a video you opened keeps the screen on to its end,
      then the phone auto-locks; paused previews let it lock too.
- [ ] Home feed autoplay pauses and resumes in place.
- [ ] A touch inside the **comments sheet over a reel** counts as presence. Touches
      inside RN `Modal`s are expected to bubble to the root observer, but that is
      unproven on device; if they don't, add `markInteraction` to CommentsSheet.
- [ ] AirPlay "Still watching?" appears and Keep watching resumes the right item.
- [ ] Watch uid `7bb324123566a2c228e9635d15915a6d` in Stream after release. It is a
      30-day rolling figure, so it will not fall at once — it should stop climbing
      faster than views × 11.8 once users are on 1.0.3.

**Known limit.** A live stream has no end to finish, so a phone left on one stays
awake until the broadcast ends — as on other live apps. If that ever shows on the
bill, reuse the TV "Still watching?" prompt for live.

**Open question for the owner.** Idle handling covers a phone nobody is touching.
While someone IS browsing, a preview still streams for as long as its tile is on
screen — the 705s post included. Capping previews (say, loop the first 30–60s)
would cut delivery further, but grid autoplay counts toward views, so it is a
decision about view counting as much as cost.

## Owner, not code
- [ ] **Cloudflare budget alert** (Billing → Billable usage → Create budget alert),
      e.g. $10/month, so the next leak is an email instead of a surprise.

## Carried over from 1.0.2
- [ ] Android 1.0.2 still unsubmitted — needs the Play service-account key
      (`docs/PLAY_SERVICE_ACCOUNT.md`).
- [ ] Realtime screens still depend on the publication alone — the slow poll is owed.
