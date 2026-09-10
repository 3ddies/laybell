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
Video is kinder to your battery and data: a clip that keeps looping now stops once your phone has been put down for a few minutes, and picks straight back up when you return. Laybell TV also checks in after an hour of autoplay with nobody tapping.

Plus fixes and polish throughout.
```

---

## App Store — "What's New in This Version" (≤4000 chars)

```
VIDEO THAT KNOWS WHEN YOU HAVE STEPPED AWAY

A looping video used to keep your screen awake and keep playing for as long as the phone was left on it — using battery and data with nobody watching. Now, once your phone has sat untouched for a few minutes, the clip finishes the play it is on and stops, and your phone is free to lock. Touch the screen and it picks straight back up. Nothing you are actually watching gets cut off partway.

Laybell TV over AirPlay does the same for autoplay: after an hour without a tap, it asks whether you are still watching instead of playing on to an empty room.

A video you open no longer keeps playing underneath another screen you open on top of it.
```

---

# STATUS

## The headline fix — unattended video

**Why this release exists this early.** On 2026-09-10 the Cloudflare bill showed
$7 in 7 days, projecting $30. One 11.8-minute post had delivered **8,075 minutes in
30 days against 44 views**. Cause: a playing video keeps the phone's screen awake,
so a looping one never lets the phone lock, the app never backgrounds, and it
streams in the foreground forever. Full write-up in the commit and in
`lib/presenceCore.ts`.

⚠️ **The leak is still live on 1.0.1 and 1.0.2.** No OTA — only this build fixes it.
Every day before 1.0.3 is approved, any device left on a looping video keeps
billing. Shipping this soon is the mitigation.

**Built and verified in code:**
- [x] Presence clock, pure and fake-clock tested — 22/22, including a thousand
      touches re-arming the timer at most once and no timer running while idle.
- [x] `hooks/useIdleAwareLoop` owns `loop` + keep-awake in AppVideo, FeedVideo,
      ReelVideo and GridVideo; manual trim loops pause at trimEnd while idle; the
      FeedVideo/GridVideo self-heals stand down while idle.
- [x] Post viewer video gated on focus (it played under pushed screens).
- [x] AirPlay TV "Still watching?" after 60 minutes untouched, ten locales.
- [x] tsc clean; iOS and Android bundles export.

**Still to verify ON A DEVICE — none of this has run on hardware yet:**
- [ ] Open a looping video post and leave the phone untouched. After 5 minutes
      the console prints `[presence] IDLE`; the clip finishes its current pass and
      STOPS, and the screen is then allowed to auto-lock. Touch → `[presence] back`
      and it resumes. Do the same on the home feed and on a reel.
- [ ] A touch inside the **comments sheet over a reel** counts as presence. Touches
      inside RN `Modal`s are expected to bubble to the root observer, but that is
      unproven on device; if they don't, add `markInteraction` to CommentsSheet.
- [ ] A long video is **not** cut off mid-play when the 5 minutes elapse — it
      finishes, then stops.
- [ ] AirPlay "Still watching?" appears and Keep watching resumes the right item.
      60 minutes is a long wait: temporarily lower `TV_IDLE_MS` in a dev build.
- [ ] Watch uid `7bb324123566a2c228e9635d15915a6d` in Stream after release. It is a
      30-day rolling figure, so it will not fall at once — it should stop climbing
      faster than views × 11.8 once users are on 1.0.3.

## Owner, not code
- [ ] **Cloudflare budget alert** (Billing → Billable usage → Create budget alert),
      e.g. $10/month, so the next leak is an email instead of a surprise.

## Carried over from 1.0.2
- [ ] Android 1.0.2 still unsubmitted — needs the Play service-account key
      (`docs/PLAY_SERVICE_ACCOUNT.md`).
- [ ] Realtime screens still depend on the publication alone — the slow poll is owed.
