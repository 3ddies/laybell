# Laybell Auto-DJ (Listen Mode) — spec (v0, 2026-10-26)

Automatic, live-DJ-style transitions between songs while in **Listen Mode** — the engine
mixes one track into the next (fade + EQ bass-swap, then beat/tempo matching) the way a DJ
would, but with zero user effort. Stems directly from the DJ Booth engine
(`lib/dj/DjEngine.ts`, docs/DJ_BOOTH_SPEC.md). Deferred-nothing; this is the pre-build spec.

> **Status: SPEC — awaiting approval of the plan + the gating decisions below.** No playback
> re-routing happens until approved. Builds on the already-shipped native engine (no new
> native dep for Phase A).

---

## 0. Decisions I need

1. **Route Listen-mode playback through the audio engine** (two decks) instead of
   react-native-track-player, *while Auto-DJ is on*? This is required — track-player can't
   hold two songs blended at once — and it's the one real re-architecture. (Recommended: yes.)
2. **Auto-DJ = an explicit toggle inside Listen Mode** (a small "Auto-mix" switch), default
   **ON**? Or always-on whenever Listen Mode is active? (Recommended: a toggle, default on.)
3. **Phase A first** (blend only: fade + EQ swap, always reliable), **Phase B** adds BPM
   beatmatch (riskier DSP)? (Recommended: yes.)
4. Lock-screen / background playback during Auto-DJ runs through the engine's own
   notification manager instead of track-player's — acceptable? (It has one; needs a
   robustness pass.)

Nothing is built until #1–#3 are answered.

---

## 1. What it does

In Listen Mode, songs don't hard-cut or gap — as the current track **plays out** (reaches
its natural end), the next one is already loaded on the other deck and is **mixed in**:
- **Phase A:** an equal-power **crossfade** with a **bass/EQ swap** (drop the outgoing low
  end as the incoming comes up, so the overlap never muddies) over ~8–12s.
- **Phase B:** **beatmatch** — nudge the incoming track's tempo to the outgoing's and align
  the downbeats, so the two lock in rhythm before the handover.

**Only on play-out.** A skip, a pause, jumping to another track, or reaching the end of the
queue does a **quick clean cut** — never a stretched auto-mix. (Owner requirement.)

---

## 2. The architecture reality (why #1 matters)

Laybell has **three** audio systems today, and only one may own the output at a time:
- **react-native-track-player** (`contexts/AudioContext.tsx`, `lib/trackPlayerService.ts`) —
  the main music queue + lock-screen/background. Listen Mode plays its queue here
  (`startListenMix()` → `playQueue()`).
- **PostMusicContext** — one `AudioPlayer` for song-over-video in the feed.
- **the DJ engine** — react-native-audio-api, two decks, able to blend.

Track-player **cannot** crossfade two songs (one track at a time). So Auto-DJ **must** run
the Listen-mode queue through the DJ engine's two decks. Plan:
- A **persistent Auto-DJ controller** (a context/singleton, not the per-screen booth engine)
  owns one `DjEngine` while Auto-DJ is active.
- Entering Auto-DJ: hand the currently-playing Listen track from track-player to **deck A**
  (resume at its current position), **pause track-player**, and claim the audio session.
- Leaving Auto-DJ / Listen Mode: fade the engine out, hand the current track + position
  **back to track-player**, release the session. This hand-off must be seamless — it's the
  trickiest integration (and the one the [[audio-session-hazard]] note warns about).
- The engine drives the **lock screen** via its `PlaybackNotificationManager`.

---

## 3. Phase A — the blend (reliable, no analysis)

- **Preload:** when a track starts on the live deck, immediately decode the **next** queue
  item's URL onto the idle deck (decode takes a second or two — do it with ~20s of runway).
- **Play-out trigger:** poll the live deck's `position()` vs `durationS`; when within the
  **transition window** (last ~12s, tunable), start the mix. (A short track just plays fully,
  then a quick fade.)
- **The mix:**
  1. Start the idle deck (incoming) at low volume.
  2. **Crossfade** the engine's equal-power crossfader from live→idle over the window.
  3. **EQ bass-swap:** ramp the outgoing deck's LOW EQ down and the incoming's up through the
     overlap, so only one track owns the sub at a time (the move that makes it sound *mixed*,
     not just faded).
  4. At the end, the incoming deck is the new "live" deck; the old one stops + is freed; the
     queue index advances; preload the *next* track.
- **Skip/seek/pause:** cancel any in-progress transition, hard-cut to the target, no mix.
- Entirely built on the existing engine (gain, biquad EQ, crossfader) — **no new native dep.**

## 4. Phase B — beatmatch (the DJ magic, the hard part)

- **BPM + downbeat detection:** offline analysis on the decoded buffer (onset-energy flux →
  autocorrelation/comb-filter over 70–180 BPM), run once per track and **cached by song id**.
  Analyze a 30–60s window, heavily downsampled, to keep it fast.
- **Match:** set the incoming deck's `playbackRate` so its BPM equals the outgoing's current
  effective BPM, and offset its start so the downbeats align at the overlap. Pitch moves with
  tempo (vinyl-style) — fine for small matches; true key/harmonic matching is out of scope.
- **Honesty about limits:**
  - Detection is imperfect (half/double-time, variable tempo) — only beatmatch when the
    estimate is **confident**; otherwise fall back to Phase-A crossfade.
  - The booth's ±8% tempo cap can't bridge, say, 120↔150 BPM. Either widen the range for
    Auto-DJ (more pitch drift) or only beatmatch tracks already close in tempo; large deltas
    fall back to a plain blend. (Real keylock would fix this — deferred, see booth spec.)
- Laybell's lane (producer beats / hip-hop, steady 4/4) is where this shines.

---

## 5. Listen-Mode UX
- An **"Auto-mix"** toggle in the Listen Mode UI (the header that already fades the tab bar).
- When on: the now-playing UI gets a subtle "mixing…" state during a transition; the
  waveform/scrubber keeps working on the live deck.
- Manual controls (play/pause/skip) still work and always take priority (= clean cut).
- Off → playback falls straight back to the normal track-player path.

## 6. Edge cases
- Very short tracks, tracks with hard/cold endings, spoken-word/no-outro → shorten or skip
  the window (just a quick fade).
- Single-item queue / last track → no transition.
- User skips mid-transition → cancel, hard-cut to the skip target.
- Call / other-app interruption → pause both decks, resume cleanly (engine
  `observeAudioInterruptions`).
- Leaving Listen Mode mid-transition → fade to the live deck, hand that track back to
  track-player at its position.
- A track that won't decode → skip it in the queue, log, keep playing.

## 7. Phased roadmap
- **Phase A:** Auto-DJ controller + engine routing + preload + play-out crossfade with EQ
  swap + the Listen-mode toggle + track-player hand-off + lock-screen. Ships on its own and
  already feels like a DJ set.
- **Phase B:** BPM/downbeat detection (cached) + beatmatch on top of the blend.
- **Later:** key/harmonic-aware next-track ordering; smarter transition points (mix out of an
  outro, into an intro) using section detection.

## 8. Open questions for the owner
1. Engine routing for Listen-mode playback (§0.1) — yes?
2. Auto-mix as a toggle, default on (§0.2)?
3. Phase A first, Phase B after (§0.3)?
4. Transition length default (~10s) and window — tune on device.
5. Is Auto-DJ free for everyone, or a Premium perk? (It's a "wow" feature — candidate perk.)

---

*Builds on `lib/dj/DjEngine.ts`; relates to [[stories-feature]]'s audio discipline,
[[audio-session-hazard]], [[listen-mode]], [[dj-remix-booth]].*
