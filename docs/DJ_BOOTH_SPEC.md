# Laybell DJ Remix Booth — spec (v0, 2026-10-26)

A fun, easy-mobile DJ booth: take a song from Laybell, drop it on a deck, and mix/effect
it like a real DJ rig — but with a touch-first UI that a non-DJ can pick up in seconds.
Deferred past 1.0.9 by decision; this is the pre-build spec, not code.

> **Status: SPEC — awaiting the one gating decision below.** No native module gets added
> and no deck code gets written until the owner approves the engine (it's a native dep →
> a rebuild, no OTA).

---

## 0. The one decision I need from you

**Approve `react-native-audio-api` (Software Mansion) as the audio engine?**
It's a **new native dependency**, so per our rule ([[local-native-modules]]) I won't add it
without your yes, and because there's **no OTA**, the first DJ-booth build is a native
rebuild. Everything below assumes a yes. If you'd rather validate the feel with **zero new
native code first**, there's a WebView/Web-Audio prototype path (see §3) — slower and worse
long-term, but it needs nothing native. My recommendation: go straight to
`react-native-audio-api`.

Two smaller decisions, which we can settle as we go:
- **Song source for v1** — Laybell catalog + your own uploads only (recommended), *not*
  arbitrary external/copyrighted songs (a licensing minefield). "Any song" = any song *in
  Laybell*.
- **Scope of v1** — the MVP in §4, or a smaller "one deck + filter + FX" toy first.

---

## 1. What it is

- Two **decks** (A / B). Load any Laybell song onto each.
- A big **crossfader** to blend between them.
- Per-deck **3-band EQ** (low / mid / high kill-and-boost) and a **filter** knob (low-pass ⇄
  high-pass sweep — the classic DJ "filter" move).
- **Tempo** control (speed the track up/down).
- **Loop** a section; **hot cues** to jump around.
- **FX pads**: echo/delay, reverb, maybe a flanger.
- A **waveform** per deck so you can see what's coming.
- **Record the mix** and post it to Laybell as a set (the payoff — DJing that doesn't leave
  the app).

The design brief is "a decked-out booth that still feels easy on a phone." That tension is
the whole product: pro depth, toy-simple surface. §6 is how.

---

## 2. Engine: `react-native-audio-api`

A Web Audio API-compatible **native** audio engine for React Native by Software Mansion.
Same `AudioContext` / node graph you'd write for the browser, running on native
AVAudioEngine (iOS) / Oboe-AAudio (Android) for low latency.

Why it fits:
- It gives us exactly the nodes a DJ rig is built from (see §5): gain, biquad filters,
  delay, convolver (reverb), stereo panner, and `AudioBufferSourceNode` for deck playback
  with `playbackRate` + looping.
- **AudioWorklets** (JS on the audio thread via worklets) for anything custom (e.g. the jog
  wheel) without dropping to C++.
- Expo-friendly: `npx expo install react-native-audio-api` + its **Expo config plugin**
  (permissions + background audio). **Dev build only** (native code — not Expo Go), which
  we already use.

Costs / caveats (all verified 2026-10-26):
- **Native dependency → a rebuild.** New Architecture only; our app is on New Arch, good.
  Pin the SDK-54-compatible version via `expo install`.
- **Independent keylock pitch is NOT reliable yet.** `pitchCorrection` exists but has an
  open iOS bug (steady periodic tone at any `playbackRate ≠ 1` in realtime). So for v1,
  tempo = `playbackRate`, which moves **pitch with tempo** — i.e. authentic *vinyl
  varispeed*. That's a feature, not a bug, for an MVP; true keylock (tempo without pitch)
  is a later phase and may need a native time-stretch core (e.g. a Rust/C++ TurboModule,
  ~13 ms latency) if the library's isn't fixed by then.
- **Scratch** has no off-the-shelf RN solution; it's direct playback-position control driven
  by the jog gesture — doable via a worklet, but it's a later-phase feature, not MVP.
- **Recording the master out** — need to confirm the capture path (a tap node / offline
  render). Treat "record & post the mix" as a phase-2 verify-first item.

### The audio-session hazard
The booth owns audio while it's open (like the studio). On enter: pause the feed video +
`PostMusicContext`. On exit: restore them. `react-native-audio-api` manages its own session;
we must make sure (a) it doesn't silently deactivate the shared iOS session and mute
everything on the way out ([[audio-session-hazard]]), and (b) interruptions (a call, another
app) pause cleanly. This is the same discipline the live studio already follows
([[studio-broadcast]]).

---

## 3. Alternative (if you want zero new native code first)

**WebView + the browser's Web Audio API** (via `expo-dom` or `react-native-webview`): build
the whole engine in a webview, RN chrome around it. Pros: no new native *audio* module, fast
to prototype, cross-platform identical. Cons: higher latency, awkward audio-session
integration, loading big audio files into the webview, and an RN↔webview bridge for every
knob. Fine to **prototype the UX**, wrong for the shipping product. I'd only take this route
if you want to feel the UI before committing to the native dep — otherwise skip it.

---

## 4. Phased roadmap

**Phase 1 — MVP ("it's a DJ booth")**
- Two decks, load a Laybell song onto each (decode to an in-memory buffer).
- Transport: play / pause / cue, set + jump to **hot cues**.
- **Crossfader** (two gain nodes + an equal-power curve).
- **3-band EQ** per deck (lowshelf + peaking + highshelf biquads) with kill.
- **Filter** knob per deck (one biquad swept LP⇄HP).
- **Tempo** via `playbackRate` (±8%, vinyl-style; pitch moves with it — noted).
- **Loop** (set in/out, `loopStart`/`loopEnd`).
- Waveform per deck (peaks drawn from the decoded buffer) with a playhead.

**Phase 2 — "it's fun"**
- **FX**: delay/echo (delay node + feedback), reverb (convolver + IR), filter-FX pads.
- **Record the mix** → save, and **post it to Laybell** as a set (ties into the existing
  posting/music flow — this is the feature's real hook).
- Beat grid + manual **tempo-nudge** sync.

**Phase 3 — "it's pro"**
- **Scratch / jog wheel** (gesture-driven playback-position control via a worklet).
- **Keylock** (independent tempo/pitch) — once the library fixes it, or via a native
  time-stretch core.
- **Auto-BPM detect + sync**, quantized loops/cues.

Ship Phase 1 as its own release moment ("1.x — the DJ Booth"); iterate.

---

## 5. Feature → node map (Phase 1/2)

| DJ control | Web Audio node(s) |
|---|---|
| Deck playback | `AudioBufferSourceNode` (per deck), `loop` + `loopStart/End` |
| Seek / hot cue | stop + restart source at `offset` (buffer sources are one-shot) |
| Tempo | `source.playbackRate` |
| Channel volume / crossfader | `GainNode` per deck → equal-power crossfade |
| 3-band EQ | 3× `BiquadFilterNode` (lowshelf, peaking, highshelf) |
| Filter sweep | `BiquadFilterNode` (type LP/HP, `frequency` on a knob) |
| Echo / delay | `DelayNode` + feedback `GainNode` |
| Reverb | `ConvolverNode` (impulse-response buffer) |
| Master out + record | context destination; capture tap (phase-2 verify) |
| Scratch (phase 3) | AudioWorklet reading buffer position from the jog gesture |

---

## 6. The UI (easy-mobile)

The point of difference. Principles:
- **Two decks stacked** (portrait) or side-by-side (landscape), each a waveform + a jog
  wheel + the 3 EQ knobs + filter.
- **One big crossfader** across the middle — the first thing a newcomer touches.
- **Big, forgiving touch targets.** Knobs are vertical drag (not twist); FX are tap-pads.
- **Progressive disclosure** — the surface shows play, crossfade, filter, and FX pads;
  EQ/loop/cue live one tap deeper so the default screen isn't a 747 cockpit.
- **Haptics** on cue/loop/FX (expo-haptics) for tactile feel.
- Reanimated for 60fps knob/waveform motion; the waveform is Skia (already in the app).
- A **guided first-run** ("tap play on both, slide the crossfader") so a non-DJ gets a win in
  10 seconds.

---

## 7. Laybell integration
- **Song source**: the Laybell catalog + the user's own uploads (reuse the song picker /
  `songs-on-posts` plumbing). A DJ mix of another artist's track is a remix — consistent with
  the existing remix/songs features.
- **The payoff**: record a set → **post it** (reuse the audio-post flow), credited to the
  source artists (reuse song-features credits). This is what makes the booth a *Laybell*
  feature and not a toy.
- Tier-gating: candidate perk for Premium / Premium+ (like other studio features) — owner's
  call later.

---

## 8. Open questions for the owner
1. **Engine approval** (§0) — yes to `react-native-audio-api` (native dep + rebuild)?
2. Song source = Laybell catalog + own uploads only for v1? (recommended)
3. v1 scope = the §4 MVP, or a smaller one-deck toy first?
4. Is "record & post the mix" a must-have for the first ship, or a fast-follow?
5. Free for everyone, or a Premium perk?

Nothing is built until #1 is answered.

---

*Sources for the engine assessment:*
- react-native-audio-api docs — https://docs.swmansion.com/react-native-audio-api/docs/fundamentals/introduction/
- Expo config plugin — https://docs.swmansion.com/react-native-audio-api/docs/other/audio-api-plugin/
- keylock/pitch realtime bug — https://github.com/software-mansion/react-native-audio-api/issues/1259
- Expo: real-time audio with native code — https://expo.dev/blog/real-time-audio-processing-with-expo-and-native-code
