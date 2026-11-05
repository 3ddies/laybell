// ── DJ Booth audio engine ────────────────────────────────────────────────────
// Phase-1 two-deck engine built on react-native-audio-api (Software Mansion's
// Web Audio API for RN — a NATIVE module, so this only runs in a dev/production
// build that bundled it, never in Metro against an old build). See
// docs/DJ_BOOTH_SPEC.md.
//
// Signal path, per deck:
//   source → eqLow → eqMid → eqHigh → filter → channelGain → crossGain → master → out
// Only `source` is recreated per play/seek, because a buffer may be set on a
// source node ONLY ONCE (Web Audio rule) — so a seek/cue is "stop the old source,
// spawn a new one starting at the new offset". The rest of the chain is permanent.
//
// Tempo is `playbackRate` (pitch moves WITH tempo — authentic vinyl varispeed).
// Independent keylock is deferred (the library's pitchCorrection has an open iOS
// realtime bug) — see the spec.
import {
  AudioContext,
  AudioManager,
  AudioRecorder,
  FileFormat,
  FileDirectory,
  IOSAudioQuality,
  BitDepth,
  FlacCompressionLevel,
  type AudioBuffer,
  type AudioBufferSourceNode,
  type GainNode,
  type BiquadFilterNode,
  type DelayNode,
  type AudioNode,
  type RecorderAdapterNode,
} from 'react-native-audio-api';
import {
  TEMPO_MIN, TEMPO_MAX, AUTO_MID_DUCK, AUTO_HIGH_DUCK, AUTO_MATCH_BASS_DUCK, AUTO_MATCH_BASS_SHARE,
  type EqBand, type DeckId,
} from './constants';
import { analyzeBeatGrid, analyzeEnding, analyzeStart, type BeatGrid, type EndType, type StartType } from './beatGrid';

// EQ knob travel: full kill at the bottom, a modest boost at the top (DJ mixers
// boost less than they cut — a +6 is already loud, a -26 is effectively "off").
const EQ_KILL_DB = -26;
const EQ_BOOST_DB = 6;
// Filter sweep bounds. A single biquad that is a lowpass for the "left" half of
// the knob (darker) and a highpass for the "right" half (thinner); dead-centre is
// a wide-open lowpass = bypass.
const LP_OPEN_HZ = 22000; // lowpass fully open ≈ no effect (above the top octave → neutral is transparent)
const LP_MIN_HZ = 180;    // darkest lowpass
const HP_MIN_HZ = 20;     // highpass just opening = no effect
const HP_MAX_HZ = 9000;   // thinnest highpass
const clamp =(v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
// Exponential map t∈[0,1] → [from,to] (frequencies feel linear to the ear in log space).
const expMap = (t: number, from: number, to: number) => from * Math.pow(to / from, clamp(t, 0, 1));
// EQ knob [-1,1] → dB: <0 scales toward kill, >0 toward boost.
const eqKnobToDb = (k: number) => (k < 0 ? k * -EQ_KILL_DB : k * EQ_BOOST_DB);

// Auto-DJ morph EQ choreography, as fractions of the blend length. The bass hands
// off quickly around the midpoint (only one track owns the sub at a time → no mud);
// mids/highs cross-blend across the whole phrase (incoming rises early, outgoing
// leaves late), highs slightly ahead of mids. Tune by ear.
// Echo-out FX (shared delay bus). Feedback < 1 so it always decays (no runaway).
const ECHO_SEND = 0.5;      // how much of the deck feeds the delay
const ECHO_FEEDBACK = 0.45; // delay repeat decay (~5 audible repeats)
const ECHO_RETURN = 0.85;   // delay bus → master level when engaged
const ECHO_TAIL_S = 2.5;    // ring-out before the bus turns fully off
// Reverb-WASH variant of the same bus: a short delay + high (still <1) feedback is a dense, lush
// ambience tail. Kept subtle so it sits UNDER the mix (won't muddy).
const WASH_DELAY_S = 0.09;
const WASH_FEEDBACK = 0.7;
const WASH_RETURN = 0.32;
const WASH_SEND = 0.4;

const MORPH = {
  // completeFrac: the whole hand-off (volume + EQ) finishes by this fraction of the blend;
  // the outgoing is then SILENT for the rest, so a loud/abrupt ending can't snap through.
  // (Energy-end anchoring does the main abrupt-cut work; this is the safety margin.)
  completeFrac: 0.8,
  // UNMATCHED: quick bass swap — one track owns the sub (two un-synced kicks would clash → mud).
  bassOutStart: 0.35, bassOutEnd: 0.52, // outgoing low: flat → kill
  bassInStart: 0.48, bassInEnd: 0.66,   // incoming low: kill → flat (just after)
  // MATCHED (beat-locked): the outgoing anchors the sub through a long shared window while the
  // incoming kick layers IN (tucked, rising); the outgoing bows out late. Locked kicks reinforce.
  mBassOutStart: 0.62, mBassOutEnd: 0.9,
  midInEnd: 0.55,  midOutStart: 0.45,   // incoming mid rises over [0,.55]; outgoing falls over [.45,1]
  highInEnd: 0.45, highOutStart: 0.55,  // highs a touch earlier than mids
} as const;

// Down-sample a decoded track into `n` normalized peak bars (0..1) for the waveform.
// One pass over channel 0 — done once per load, so the O(samples) cost is fine.
function computePeaks(buffer: AudioBuffer, n: number): Float32Array {
  const data = buffer.getChannelData(0);
  const per = Math.max(1, Math.floor(data.length / n));
  const peaks = new Float32Array(n);
  let overall = 0;
  for (let i = 0; i < n; i++) {
    let max = 0;
    const start = i * per;
    const end = Math.min(data.length, start + per);
    for (let j = start; j < end; j++) { const a = Math.abs(data[j]); if (a > max) max = a; }
    peaks[i] = max;
    if (max > overall) overall = max;
  }
  if (overall > 0) for (let i = 0; i < n; i++) peaks[i] /= overall;
  return peaks;
}

// One deck: owns its permanent EQ/filter/gain chain and spawns short-lived source
// nodes for playback. Position is derived from the context clock, not polled from
// native, so it stays exact across tempo changes.
export class Deck {
  readonly id: DeckId;
  private readonly ctx: AudioContext;

  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;

  // Permanent chain.
  private readonly eqLow: BiquadFilterNode;
  private readonly eqMid: BiquadFilterNode;
  private readonly eqHigh: BiquadFilterNode;
  private readonly filter: BiquadFilterNode;
  private readonly channelGain: GainNode; // the up-fader (per-deck volume)
  readonly crossGain: GainNode;           // driven by the engine's crossfader
  readonly echoSend: GainNode;            // tap into the shared echo bus (0 = off)

  // Transport state.
  private playing = false;
  private pausedAt = 0;        // seconds into the track when paused
  private startedAtCtx = 0;    // ctx.currentTime at the last source start
  private startOffset = 0;     // buffer offset at the last source start
  private tempo = 1;
  private reversing = false;   // true while a reverse/rewind one-shot is playing
  private reverseStartPos = 0; // forward position (s) the reverse began at
  private channelVol = 1;      // the up-fader's INTENDED level, so FX gating restores to it (not a gated 0)

  // Loop + cues (seconds).
  private loopOn = false;
  private loopStartS = 0;
  private loopEndS = 0;
  cues: Array<number | null> = [null, null, null, null];

  // Beat grid (BPM + phase), computed once per load from the decoded PCM. Powers the
  // Pro booth's BPM readout, SYNC, and beat-synced loops. Null when analysis is
  // inconclusive — the UI then falls back to time-based behaviour. Pure-JS (beatGrid.ts).
  grid: BeatGrid | null = null;

  durationS = 0;

  constructor(id: DeckId, ctx: AudioContext, master: GainNode, echoBus: AudioNode) {
    this.id = id;
    this.ctx = ctx;

    this.eqLow = ctx.createBiquadFilter();
    this.eqLow.type = 'lowshelf';
    this.eqLow.frequency.value = 120;
    this.eqMid = ctx.createBiquadFilter();
    this.eqMid.type = 'peaking';
    this.eqMid.frequency.value = 1000;
    this.eqMid.Q.value = 0.9;
    this.eqHigh = ctx.createBiquadFilter();
    this.eqHigh.type = 'highshelf';
    this.eqHigh.frequency.value = 4000;

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = LP_OPEN_HZ; // bypassed

    this.channelGain = ctx.createGain();
    this.crossGain = ctx.createGain();
    this.echoSend = ctx.createGain();
    this.echoSend.gain.value = 0; // echo off until a transition engages it

    // Wire the permanent chain once.
    this.eqLow.connect(this.eqMid);
    this.eqMid.connect(this.eqHigh);
    this.eqHigh.connect(this.filter);
    this.filter.connect(this.channelGain);
    this.channelGain.connect(this.crossGain);
    this.crossGain.connect(master);
    // Parallel tap into the shared echo bus (pre-crossfade, so the echo stays strong as the dry fades).
    this.channelGain.connect(this.echoSend);
    this.echoSend.connect(echoBus);
  }

  get isPlaying() { return this.playing; }
  get hasTrack() { return this.buffer !== null; }
  get tempoRate() { return this.tempo; }
  get loopActive() { return this.loopOn; }
  /** Detected tempo in BPM (grid × current playback rate), or null if unknown. Pro booth readout. */
  get bpm(): number | null { return this.grid ? this.grid.bpm * this.tempo : null; }
  /** The active loop as buffer-second bounds, or null — drives the Pro waveform loop highlight. */
  get loopWindow(): { startS: number; endS: number } | null {
    return this.loopOn && this.loopEndS > this.loopStartS ? { startS: this.loopStartS, endS: this.loopEndS } : null;
  }

  /** Beatmatch THIS deck to `other` by nudging playback rate so their tempos line up, within the
   *  ±8% pitch range (authentic varispeed — no key-mangling time-stretch). Picks the 1×/½×/2×
   *  multiple closest to no-change. Returns 'locked' (an exact match fits the range), 'near'
   *  (clamped best-effort — the two are too far apart to lock), or 'unavailable' (no beat grid on
   *  one side). Tempo-only in v1 — phase alignment is deferred. */
  syncTo(other: Deck): 'locked' | 'near' | 'unavailable' {
    if (!this.grid || !other.grid || this.grid.bpm <= 0 || other.grid.bpm <= 0) return 'unavailable';
    const target = other.grid.bpm * other.tempo; // the other deck's CURRENT effective tempo
    const base = target / this.grid.bpm;          // ratio that matches it at 1×
    const cands = [base, base * 2, base / 2];     // allow half-/double-time locks
    let best: number | null = null;
    let bestDist = Infinity;
    for (const r of cands) {
      if (r >= TEMPO_MIN && r <= TEMPO_MAX) {
        const d = Math.abs(r - 1);
        if (d < bestDist) { bestDist = d; best = r; }
      }
    }
    if (best != null) { this.setTempo(best); return 'locked'; }
    const closest = cands.reduce((a, b) => (Math.abs(b - 1) < Math.abs(a - 1) ? b : a));
    this.setTempo(clamp(closest, TEMPO_MIN, TEMPO_MAX)); // too far to truly lock — get as close as ±8% allows
    return 'near';
  }

  /** Loop `beats` of the track from the current position, snapped to the beat grid when there is
   *  one (falls back to ~½s per "beat" otherwise). Uses the same loop machinery as the Simple
   *  booth's loop button, so clearLoop() turns it off the same way. */
  beatLoop(beats: number): void {
    const period = this.grid && this.grid.beatPeriodS > 0 ? this.grid.beatPeriodS : 0.5;
    let start = this.position();
    if (this.grid && this.grid.beatPeriodS > 0) {
      // Snap the loop-in to the nearest grid beat so the loop sits musically, not mid-beat.
      const k = Math.round((start - this.grid.firstBeatS) / period);
      const snapped = this.grid.firstBeatS + k * period;
      if (snapped >= 0 && snapped <= this.durationS) start = snapped;
    }
    this.setLoop(start, beats * period);
  }

  /** Decode a song URL (or local path) into this deck, stopped at 0. */
  async load(url: string): Promise<void> {
    this.stopSource();
    this.playing = false;
    this.pausedAt = 0;
    this.loopOn = false;
    this.reversing = false;
    this.cues = [null, null, null, null];
    const buf = await this.ctx.decodeAudioData(url);
    this.buffer = buf;
    this.durationS = buf.duration;
    // One-time beat-grid read for the Pro booth. Best-effort — a null just disables
    // sync + beat-loops for this track (the deck still plays and loops by time).
    try {
      const sr = (buf as unknown as { sampleRate?: number }).sampleRate ?? this.ctx.sampleRate;
      this.grid = analyzeBeatGrid(buf.getChannelData(0), sr);
    } catch { this.grid = null; }
  }

  /** `n` normalized waveform peak bars (0..1), or null if nothing is loaded. */
  peaks(n = 400): Float32Array | null {
    return this.buffer ? computePeaks(this.buffer, n) : null;
  }

  /** Current playback position in seconds. */
  position(): number {
    if (!this.playing) return this.pausedAt;
    if (this.reversing) {
      // Playhead runs BACKWARD during a reverse, matching the audio.
      const r = this.reverseStartPos - (this.ctx.currentTime - this.startedAtCtx) * this.tempo;
      return clamp(r, 0, this.durationS || r);
    }
    let p = this.startOffset + (this.ctx.currentTime - this.startedAtCtx) * this.tempo;
    if (this.loopOn && this.loopEndS > this.loopStartS) {
      const len = this.loopEndS - this.loopStartS;
      if (p >= this.loopEndS) p = this.loopStartS + ((p - this.loopStartS) % len);
    }
    return clamp(p, 0, this.durationS || p);
  }

  play(): void {
    if (!this.buffer || this.playing) return;
    this.spawnSource(this.pausedAt);
    this.playing = true;
  }

  pause(): void {
    if (!this.playing) return;
    this.pausedAt = this.position();
    this.stopSource();
    this.playing = false;
    this.reversing = false;
  }

  toggle(): void { this.playing ? this.pause() : this.play(); }

  seek(sec: number): void {
    this.reversing = false;
    const to = clamp(sec, 0, this.durationS);
    if (this.playing) {
      this.stopSource();
      this.spawnSource(to);
    } else {
      this.pausedAt = to;
    }
  }

  setTempo(rate: number): void {
    const r = clamp(rate, TEMPO_MIN, TEMPO_MAX);
    if (this.playing && this.source) {
      // Re-anchor so position() stays continuous across the rate change.
      this.startOffset = this.position();
      this.startedAtCtx = this.ctx.currentTime;
      this.source.playbackRate.value = r;
    }
    this.tempo = r;
  }

  /** EQ knob in [-1,1]: -1 = full kill, 0 = flat, +1 = full boost. */
  setEq(band: EqBand, knob: number): void {
    const node = band === 'low' ? this.eqLow : band === 'mid' ? this.eqMid : this.eqHigh;
    node.gain.value = eqKnobToDb(clamp(knob, -1, 1));
  }

  /** Set the low EQ immediately — used to pre-cut the incoming deck's bass for a swap. */
  setBassNow(knob: number): void { this.eqLow.gain.value = eqKnobToDb(clamp(knob, -1, 1)); }

  private eqNode(band: EqBand): BiquadFilterNode {
    return band === 'low' ? this.eqLow : band === 'mid' ? this.eqMid : this.eqHigh;
  }

  /** Ramp one EQ band from `fromKnob` to `toKnob` over [startT, endT] on the audio thread.
   *  The explicit start value anchors the ramp (held before startT). Auto-DJ morph. */
  rampEq(band: EqBand, fromKnob: number, toKnob: number, startT: number, endT: number): void {
    const g = this.eqNode(band).gain;
    g.cancelScheduledValues(startT);
    g.setValueAtTime(eqKnobToDb(clamp(fromKnob, -1, 1)), startT);
    g.linearRampToValueAtTime(eqKnobToDb(clamp(toKnob, -1, 1)), endT);
  }

  /** Cancel any scheduled EQ ramps and flatten all three bands NOW (clean deck reuse). */
  resetEqNow(): void {
    const now = this.ctx.currentTime;
    for (const n of [this.eqLow, this.eqMid, this.eqHigh]) {
      n.gain.cancelScheduledValues(now);
      n.gain.value = 0;
    }
  }

  /** Analyse this track once: beat grid (BPM + phase), where its audio truly ends (trailing
   *  silence trimmed) + whether that end is abrupt, and how it ends/starts (for the transition
   *  recipe). Null if nothing loaded. */
  analyze(): {
    grid: BeatGrid | null; endS: number; abrupt: boolean; endType: EndType; startType: StartType;
    dbg: { endLow: number; endCrest: number; startLoud: number; startLow: number; startCrest: number };
  } | null {
    if (!this.buffer) return null;
    try {
      const data = this.buffer.getChannelData(0);
      const sr = (this.buffer as unknown as { sampleRate?: number }).sampleRate ?? this.ctx.sampleRate;
      const grid = analyzeBeatGrid(data, sr);
      const end = analyzeEnding(data, sr);
      const start = analyzeStart(data, sr);
      return {
        grid,
        endS: end.endS > 0 ? Math.min(end.endS, this.durationS) : this.durationS,
        abrupt: end.abrupt, endType: end.endType, startType: start.startType,
        dbg: { endLow: end.outroLow, endCrest: end.outroCrest, startLoud: start.loud, startLow: start.low, startCrest: start.crest },
      };
    } catch {
      return null;
    }
  }

  /** Exponential lowpass-frequency sweep over [startT, startT+durS] (natural to the ear). Used for
   *  the transition FX: darken the outgoing as it leaves, or open the incoming up as it arrives. */
  rampFilterLowpass(fromHz: number, toHz: number, startT: number, durS: number): void {
    this.filter.type = 'lowpass';
    const a = clamp(fromHz, 50, LP_OPEN_HZ);
    const b = clamp(toHz, 50, LP_OPEN_HZ);
    const N = 64;
    const curve = new Float32Array(N);
    for (let i = 0; i < N; i++) curve[i] = a * Math.pow(b / a, i / (N - 1));
    this.filter.frequency.cancelScheduledValues(startT);
    this.filter.frequency.setValueCurveAtTime(curve, startT, durS);
  }
  /** FX: muffle this deck away (open → `toHz` lowpass) as it exits — "sinking into the distance".
   *  A higher toHz (e.g. ~1200) is a gentler darkening, for a subtle garnish. */
  sweepOutDark(startT: number, durS: number, toHz = 350): void { this.rampFilterLowpass(LP_OPEN_HZ, toHz, startT, durS); }
  /** FX: open this deck up (dark lowpass → open) as it arrives — a filter-up build. */
  sweepInOpen(startT: number, durS: number): void { this.rampFilterLowpass(450, LP_OPEN_HZ, startT, durS); }

  /** FX: highpass "riser" — thin the deck out (open → 2.5kHz HP) as it leaves, building tension
   *  into the next drop. */
  sweepOutThin(startT: number, durS: number): void {
    this.filter.type = 'highpass';
    const f = this.filter.frequency;
    const now = this.ctx.currentTime;
    f.cancelScheduledValues(now);
    f.setValueAtTime(20, now); // open HP (no effect) until the sweep starts
    const N = 64;
    const a = 20;
    const b = 2500;
    const curve = new Float32Array(N);
    for (let i = 0; i < N; i++) curve[i] = a * Math.pow(b / a, i / (N - 1));
    f.setValueCurveAtTime(curve, startT, durS);
  }

  /** FX: tape-stop — spin this deck's playback rate down to a near-halt over durS (the classic
   *  "powering down" pitch drop). The deck is paused shortly after by promote. */
  brake(startT: number, durS: number): void {
    if (!this.source) return;
    const p = this.source.playbackRate;
    p.cancelScheduledValues(startT);
    p.setValueAtTime(Math.max(0.05, this.tempo), startT);
    p.linearRampToValueAtTime(0.04, startT + durS);
  }

  /** FX: beat-stutter — rhythmically gate this deck's level on/off `count` times at `periodS` each
   *  (a glitchy chop), then restore. Beat-synced when the caller passes a beat-fraction period. */
  stutter(startT: number, periodS: number, count: number): void {
    const per = 6;
    const N = Math.max(2, count * per);
    const curve = new Float32Array(N);
    for (let i = 0; i < N; i++) curve[i] = (i % per) / per < 0.5 ? 1 : 0; // on half, off half each slice
    const dur = count * periodS;
    const g = this.channelGain.gain;
    g.cancelScheduledValues(startT);
    g.setValueCurveAtTime(curve, startT, dur);
    g.setValueAtTime(1, startT + dur + 0.001); // restore full after the chop
  }

  /** Booth FX: tape-stop — spin the live source down to a halt over durS, then pause at the
   *  point the stop began, so a re-play resumes cleanly at normal tempo. No-op if not playing. */
  tapeStop(durS = 0.8): void {
    if (!this.playing || !this.source) return;
    const startPos = this.position();
    const now = this.ctx.currentTime;
    const p = this.source.playbackRate;
    p.cancelScheduledValues(now);
    p.setValueAtTime(Math.max(0.05, this.tempo), now);
    p.linearRampToValueAtTime(0.03, now + durS);
    setTimeout(() => {
      if (!this.playing) return;
      this.stopSource();
      this.playing = false;
      this.pausedAt = startPos;
    }, (durS + 0.05) * 1000);
  }

  /** Booth FX: tape-start — wind the deck UP to full speed from a near-stop (the "power on" spin-up).
   *  Starts the deck if it was paused. Minor: the waveform playhead runs slightly ahead during the
   *  ~durS wind-up (position tracks the set tempo, not the ramped source rate) — cosmetic. */
  tapeStart(durS = 0.7): void {
    if (!this.buffer) return;
    if (!this.playing) this.play();
    if (!this.source) return;
    const now = this.ctx.currentTime;
    const p = this.source.playbackRate;
    p.cancelScheduledValues(now);
    p.setValueAtTime(0.08, now);
    p.linearRampToValueAtTime(this.tempo, now + durS);
  }

  /** Booth FX: beat-roll — a short rhythmic gate (on/off chops) of this deck's level, restoring to
   *  the CURRENT volume after (so it respects the up-fader). `count` chops of `periodS` each.
   *  Built from DISCRETE setValueAtTime steps, NOT setValueCurveAtTime: two overlapping value CURVES
   *  throw a native error (that's what crashed the app on a double-tap). cancelScheduledValues +
   *  setValueAtTime is always safe to re-fire, so a re-tap just cleanly restarts the gate. */
  roll(periodS = 0.11, count = 8): void {
    const g = this.channelGain.gain;
    // Restore to the up-fader's INTENDED level — NOT g.value. On a rapid re-tap, reading the live
    // gain can catch an "off" slice (0), which then poisons every step and freezes the deck silent.
    const base = this.channelVol;
    const now = this.ctx.currentTime;
    try {
      g.cancelScheduledValues(now);
      for (let i = 0; i < count; i++) {
        const t0 = now + i * periodS;
        g.setValueAtTime(base, t0);              // on (first half of each slice)
        g.setValueAtTime(0, t0 + periodS * 0.5); // off (second half) — the chop
      }
      g.setValueAtTime(base, now + count * periodS); // restore full after the roll
    } catch {
      const t = this.ctx.currentTime;
      g.cancelScheduledValues(t);
      g.setValueAtTime(base, t); // never leave the deck gated/silent if scheduling fails
    }
  }

  /** Booth FX: reverse / rewind — play the last ~durS of audio BACKWARDS, then resume forward from
   *  where the rewind landed. Only a short recent SEGMENT is reversed (≈1 MB, not the whole track),
   *  built sample-contiguous with the surrounding audio so the swap in and out is near-seamless.
   *  Re-tap is ignored while a reverse is running; no-op if not playing or too near the start. */
  reverse(durS = 1.4): void {
    if (!this.buffer || !this.playing || this.reversing) return;
    const pos = this.position();
    const sr = (this.buffer as unknown as { sampleRate?: number }).sampleRate ?? this.ctx.sampleRate;
    const ch = Math.max(1, (this.buffer as unknown as { numberOfChannels?: number }).numberOfChannels ?? 1);
    const posSample = Math.floor(pos * sr);
    const segLen = Math.min(Math.floor(durS * sr), posSample);
    if (segLen < 1024) return; // too near the start to rewind
    let seg: AudioBuffer;
    try {
      seg = this.ctx.createBuffer(ch, segLen, sr);
      const startSample = posSample - segLen;
      for (let c = 0; c < ch; c++) {
        const s = this.buffer.getChannelData(c);
        const d = seg.getChannelData(c);
        for (let i = 0; i < segLen; i++) d[i] = s[startSample + segLen - 1 - i];
      }
    } catch { return; } // createBuffer/getChannelData unsupported → skip the effect
    this.stopSource();
    const src = this.ctx.createBufferSource();
    src.buffer = seg;
    src.playbackRate.value = this.tempo;
    src.connect(this.eqLow);
    src.start(0, 0);
    this.source = src;
    this.startedAtCtx = this.ctx.currentTime;
    this.reversing = true;
    this.reverseStartPos = pos;
    const landed = clamp(pos - segLen / sr, 0, this.durationS);
    setTimeout(() => {
      if (!this.reversing) return; // interrupted by pause / seek / load
      this.reversing = false;
      if (!this.playing) return;
      this.stopSource();
      this.spawnSource(landed); // continue forward from where the rewind ended
    }, (segLen / sr) * 1000 / this.tempo);
  }

  /** Filter knob in [-1,1]: <0 lowpass (darker), >0 highpass (thinner), 0 = open. */
  setFilter(knob: number): void {
    this.filter.frequency.cancelScheduledValues(this.ctx.currentTime); // clear any FX sweep
    const k = clamp(knob, -1, 1);
    if (k < 0) {
      this.filter.type = 'lowpass';
      this.filter.frequency.value = expMap(1 + k, LP_MIN_HZ, LP_OPEN_HZ); // k=-1→min, k→0→open
    } else if (k > 0) {
      this.filter.type = 'highpass';
      this.filter.frequency.value = expMap(k, HP_MIN_HZ, HP_MAX_HZ);
    } else {
      this.filter.type = 'lowpass';
      this.filter.frequency.value = LP_OPEN_HZ;
    }
  }

  /** Channel (up-fader) volume 0..1. */
  setVolume(v: number): void {
    this.channelVol = clamp(v, 0, 1);
    this.channelGain.gain.cancelScheduledValues(this.ctx.currentTime); // clear any stutter/roll gating
    this.channelGain.gain.value = this.channelVol;
  }

  setLoop(startS: number, lengthS: number): void {
    this.loopStartS = clamp(startS, 0, this.durationS);
    this.loopEndS = clamp(startS + lengthS, this.loopStartS + 0.05, this.durationS);
    this.loopOn = true;
    if (this.source) {
      this.source.loopStart = this.loopStartS;
      this.source.loopEnd = this.loopEndS;
      this.source.loop = true;
    }
  }

  clearLoop(): void {
    this.loopOn = false;
    if (this.source) this.source.loop = false;
  }

  setCue(i: number): void { if (i >= 0 && i < this.cues.length) this.cues[i] = this.position(); }
  jumpCue(i: number): void {
    const c = this.cues[i];
    if (c == null) { this.setCue(i); return; } // empty slot → drop a cue here
    this.seek(c);
    if (!this.playing) this.play();
  }

  dispose(): void { this.stopSource(); this.buffer = null; }

  // ── internals ──────────────────────────────────────────────────────────────
  private spawnSource(atSec: number): void {
    if (!this.buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.tempo;
    if (this.loopOn) {
      src.loopStart = this.loopStartS;
      src.loopEnd = this.loopEndS;
      src.loop = true;
    }
    src.connect(this.eqLow);
    src.start(0, atSec);
    this.source = src;
    this.startedAtCtx = this.ctx.currentTime;
    this.startOffset = atSec;
  }

  private stopSource(): void {
    if (this.source) {
      try { this.source.stop(); } catch { /* already stopped */ }
      try { this.source.disconnect(); } catch { /* noop */ }
      this.source = null;
    }
  }
}

// The whole rig: one context, two decks, an equal-power crossfader into a master
// gain. One instance per booth screen; call init() before use and dispose() on exit.
export class DjEngine {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly a: Deck;
  readonly b: Deck;
  private readonly echoDelay: DelayNode;
  private readonly echoFeedback: GainNode;
  private readonly echoReturn: GainNode;
  private noiseBuf: AudioBuffer | null = null; // lazily-created white noise for the uplifter
  private ready = false;
  // Master-tap recorder for the Pro "Record & Post" flow (captures the live mix to a file).
  private recAdapter: RecorderAdapterNode | null = null;
  private recorder: AudioRecorder | null = null;
  private recording = false;

  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);

    // Shared echo bus (off until a transition engages it): send → delay → return → master, with a
    // capped feedback loop so it always decays.
    this.echoDelay = this.ctx.createDelay(1.0);
    this.echoFeedback = this.ctx.createGain();
    this.echoFeedback.gain.value = ECHO_FEEDBACK;
    this.echoReturn = this.ctx.createGain();
    this.echoReturn.gain.value = 0;
    this.echoDelay.connect(this.echoFeedback);
    this.echoFeedback.connect(this.echoDelay);
    this.echoDelay.connect(this.echoReturn);
    this.echoReturn.connect(this.master);

    this.a = new Deck('a', this.ctx, this.master, this.echoDelay);
    this.b = new Deck('b', this.ctx, this.master, this.echoDelay);
    this.crossfade(0.5);
  }

  /** Engage the echo bus on a deck from startT: feed its signal into the delay (with feedback).
   *  `wash` = a short-delay, high-feedback reverb-ish ambience instead of discrete repeats. */
  echoBegin(deckId: DeckId, delayS: number, startT: number, wash = false): void {
    const fb = wash ? WASH_FEEDBACK : ECHO_FEEDBACK;
    const ret = wash ? WASH_RETURN : ECHO_RETURN;
    const snd = wash ? WASH_SEND : ECHO_SEND;
    const dly = wash ? WASH_DELAY_S : clamp(delayS, 0.05, 0.9);
    this.echoFeedback.gain.cancelScheduledValues(startT);
    this.echoFeedback.gain.setValueAtTime(fb, startT);
    this.echoDelay.delayTime.cancelScheduledValues(startT);
    this.echoDelay.delayTime.setValueAtTime(dly, startT);
    const r = this.echoReturn.gain;
    r.cancelScheduledValues(startT);
    r.setValueAtTime(Math.max(0, r.value), startT);
    r.linearRampToValueAtTime(ret, startT + (wash ? 0.3 : 0.1));
    const s = this.deck(deckId).echoSend.gain;
    s.cancelScheduledValues(startT);
    s.setValueAtTime(0, startT);
    s.linearRampToValueAtTime(snd, startT + (wash ? 0.4 : 0.15));
  }

  /** Stop feeding the echo and let the tail ring out (feedback decay), then turn the bus off. */
  echoRelease(deckId: DeckId): void {
    const t = this.ctx.currentTime;
    const s = this.deck(deckId).echoSend.gain;
    s.cancelScheduledValues(t);
    s.setValueAtTime(Math.max(0, s.value), t);
    s.linearRampToValueAtTime(0, t + 0.08);
    const r = this.echoReturn.gain;
    r.cancelScheduledValues(t + 0.08);
    r.setValueAtTime(ECHO_RETURN, t + 0.08);
    r.linearRampToValueAtTime(0, t + ECHO_TAIL_S);
  }

  /** FX: white-noise UPLIFTER — a rising filtered-noise "whoosh" that swells over durS and cuts at
   *  the drop. A self-contained one-shot into master (doesn't touch the decks). Best-effort. */
  uplift(startT: number, durS: number): void {
    try {
      if (!this.noiseBuf) {
        const len = Math.floor(this.ctx.sampleRate * 2);
        const b = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = b.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        this.noiseBuf = b;
      }
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      const N = 48;
      const a = 400;
      const b2 = 6000;
      const curve = new Float32Array(N);
      for (let i = 0; i < N; i++) curve[i] = a * Math.pow(b2 / a, i / (N - 1));
      hp.frequency.setValueCurveAtTime(curve, startT, durS); // sweep up = rising whoosh
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, startT);
      g.gain.linearRampToValueAtTime(0.35, startT + durS); // swell up
      g.gain.linearRampToValueAtTime(0, startT + durS + 0.12); // cut at the drop
      src.connect(hp);
      hp.connect(g);
      g.connect(this.master);
      src.start(startT);
      src.stop(startT + durS + 0.25);
      setTimeout(() => { try { src.disconnect(); hp.disconnect(); g.disconnect(); } catch { /* noop */ } }, (durS + 0.6) * 1000);
    } catch { /* uplifter is best-effort */ }
  }

  /** FX: reverb BLOOM on a deck — a short dense wash that blooms up then pulls back over durS, so an
   *  incoming track makes a lush entrance and then tightens. Self-scheduled (no timers). */
  washBloom(deckId: DeckId, startT: number, durS: number): void {
    this.echoFeedback.gain.cancelScheduledValues(startT);
    this.echoFeedback.gain.setValueAtTime(WASH_FEEDBACK, startT);
    this.echoDelay.delayTime.cancelScheduledValues(startT);
    this.echoDelay.delayTime.setValueAtTime(WASH_DELAY_S, startT);
    const r = this.echoReturn.gain;
    r.cancelScheduledValues(startT);
    r.setValueAtTime(Math.max(0, r.value), startT);
    r.linearRampToValueAtTime(WASH_RETURN, startT + 0.3); // bloom up
    r.linearRampToValueAtTime(0, startT + durS);          // pull back as it establishes
    const s = this.deck(deckId).echoSend.gain;
    s.cancelScheduledValues(startT);
    s.setValueAtTime(0, startT);
    s.linearRampToValueAtTime(WASH_SEND, startT + 0.3);
    s.linearRampToValueAtTime(0, startT + durS * 0.8);
  }

  /** Immediately silence the echo bus (hard cut / teardown). */
  echoReset(): void {
    const t = this.ctx.currentTime;
    this.echoReturn.gain.cancelScheduledValues(t); this.echoReturn.gain.value = 0;
    this.echoFeedback.gain.cancelScheduledValues(t); this.echoFeedback.gain.value = ECHO_FEEDBACK; // restore (wash changes it)
    this.a.echoSend.gain.cancelScheduledValues(t); this.a.echoSend.gain.value = 0;
    this.b.echoSend.gain.cancelScheduledValues(t); this.b.echoSend.gain.value = 0;
  }

  deck(id: DeckId): Deck { return id === 'a' ? this.a : this.b; }

  // ── Pro-booth FX (manual one-shot "throws") ──────────────────────────────────
  // Thin, UI-friendly wrappers over the transition DSP above, so the booth fires an effect with
  // just a deck id (no scheduling maths). All are momentary / self-terminating and safe to re-fire;
  // the Pro UI also debounces each pad so a rapid double-tap can't stack overlapping curves.
  private fxDelayS(deckId: DeckId): number {
    const p = this.deck(deckId).grid?.beatPeriodS;
    return p && p > 0 ? clamp(p / 2, 0.05, 0.9) : 0.25; // a half-beat echo when the tempo is known
  }
  /** Echo "throw": feed the deck into the delay for ~a beat, then let the tail ring out. */
  fxEcho(deckId: DeckId): void {
    this.echoBegin(deckId, this.fxDelayS(deckId), this.ctx.currentTime);
    setTimeout(() => { try { this.echoRelease(deckId); } catch { /* disposed */ } }, 850);
  }
  /** Reverb bloom: a short lush wash that swells then pulls back (self-contained). */
  fxReverb(deckId: DeckId): void { this.washBloom(deckId, this.ctx.currentTime, 2.2); }
  /** Riser: a rising filtered-noise whoosh into the drop (engine-level, into master). */
  fxRiser(): void { this.uplift(this.ctx.currentTime, 2.0); }
  /** Chop: a beat-synced rhythmic gate — reuses the SAFE discrete-step roll (never curve-based). */
  fxChop(deckId: DeckId): void {
    const p = this.deck(deckId).grid?.beatPeriodS;
    this.deck(deckId).roll(p && p > 0 ? p / 4 : 0.12, 8);
  }
  /** Filter sweeps: darken (lowpass down) or open back up over ~1.6s. */
  fxSweepDown(deckId: DeckId): void { try { this.deck(deckId).sweepOutDark(this.ctx.currentTime, 1.6); } catch (e) { console.warn('[dj] fxSweepDown', e); } }
  fxSweepUp(deckId: DeckId): void { try { this.deck(deckId).sweepInOpen(this.ctx.currentTime, 1.6); } catch (e) { console.warn('[dj] fxSweepUp', e); } }

  // ── Record the master mix (Pro "Record & Post") ──────────────────────────────
  get isRecording(): boolean { return this.recording; }

  /** Start capturing the booth's master output to an .m4a file. No-op if already recording.
   *  Returns WHY it couldn't start so the UI can say the right thing: 'denied' (recording
   *  permission refused), 'unsupported' (this build lacks the recorder native code) or 'failed'
   *  (anything else — logged for diagnosis). The adapter is a parallel tap, so the master still
   *  reaches the speakers while recording. */
  async startRecording(lossless = false): Promise<'ok' | 'denied' | 'unsupported' | 'failed'> {
    if (this.recording) return 'ok';
    // The native recorder needs RECORD permission even when tapping the app's own output —
    // without a granted status, start() fails. Ask up front (a no-op once already granted).
    try {
      let status = await AudioManager.checkRecordingPermissions();
      if (status !== 'Granted') status = await AudioManager.requestRecordingPermissions();
      if (status !== 'Granted') return 'denied';
    } catch { /* older native without the permission API — fall through and try anyway */ }
    try {
      if (typeof (this.ctx as unknown as { createRecorderAdapter?: unknown }).createRecorderAdapter !== 'function') {
        return 'unsupported'; // this build predates the recorder APIs (no OTA → needs a rebuild)
      }
      // The booth runs the session as 'playback' (output only, no input), so the native
      // recorder's audio engine cannot start ("Failed to start audio engine for recording").
      // Switch to 'playAndRecord' (output stays on the speaker) and re-activate before
      // starting; stopRecording() restores 'playback'.
      try {
        // 'videoRecording' mode keeps FULL-FIDELITY capture. 'default'/voice modes let iOS
        // apply AGC + downsample to a voice-grade rate, which muffles music — the likely cause
        // of the low-quality posts. defaultToSpeaker keeps the mix on the loudspeaker.
        AudioManager.setAudioSessionOptions({
          iosCategory: 'playAndRecord', iosMode: 'videoRecording', iosOptions: ['defaultToSpeaker', 'allowBluetoothA2DP'],
        });
        await AudioManager.setAudioSessionActivity(true);
      } catch { /* best-effort — try to record anyway */ }
      try { console.warn('[dj] rec start', { ctxRate: this.ctx.sampleRate, devRate: AudioManager.getDevicePreferredSampleRate() }); } catch { /* noop */ }
      if (!this.recAdapter) {
        this.recAdapter = this.ctx.createRecorderAdapter();
        this.master.connect(this.recAdapter);
      }
      if (!this.recorder) {
        this.recorder = new AudioRecorder();
        this.recorder.connect(this.recAdapter);
      }
      const fileRes = this.recorder.enableFileOutput({
        format: lossless ? FileFormat.Wav : FileFormat.M4A, // WAV = bit-exact (no re-encode), bigger files
        directory: FileDirectory.Cache,
        fileNamePrefix: 'laybell-dj',
        channelCount: 2, // stereo — the mono default was half the quality loss
        preset: {
          bitRate: 320000,                 // 320 kbps AAC — the max meaningful for AAC-LC (ignored for WAV/PCM)
          sampleRate: this.ctx.sampleRate, // match the engine's mix rate (no resample)
          bitDepth: BitDepth.Bit16,        // 16-bit PCM for WAV — transparent for an already-lossy source
          iosQuality: IOSAudioQuality.Max,
          flacCompressionLevel: FlacCompressionLevel.L5, // unused for M4A/WAV; sane default
        },
      });
      if (fileRes && (fileRes as { status?: string }).status === 'error') console.warn('[dj] enableFileOutput', fileRes);
      const res = await this.recorder.start();
      if (res.status !== 'success') { console.warn('[dj] recorder.start() returned', res); return 'failed'; }
      this.recording = true;
      return 'ok';
    } catch (e) {
      console.warn('[dj] startRecording error', e);
      this.recording = false;
      return 'failed';
    }
  }

  /** Stop recording and return the written file + its duration (seconds), or null on failure. */
  async stopRecording(): Promise<{ uri: string; durationS: number } | null> {
    if (!this.recorder || !this.recording) return null;
    this.recording = false;
    try {
      const res = await this.recorder.stop();
      console.warn('[dj] rec stop', res); // FileInfo: paths/size(MB)/duration(s) → real bitrate
      // Back to output-only now that we're done capturing input.
      try { AudioManager.setAudioSessionOptions({ iosCategory: 'playback', iosMode: 'default', iosOptions: [] }); } catch { /* noop */ }
      if (res.status !== 'success') return null;
      const path = res.paths?.[0];
      if (!path) return null;
      const uri = path.startsWith('file://') || path.startsWith('http') ? path : `file://${path}`;
      return { uri, durationS: res.duration ?? 0 };
    } catch {
      return null;
    }
  }

  /** Claim the iOS audio session for exclusive playback and resume the context. */
  async init(): Promise<void> {
    if (this.ready) return;
    try {
      AudioManager.setAudioSessionOptions({ iosCategory: 'playback', iosMode: 'default', iosOptions: [] });
      await AudioManager.setAudioSessionActivity(true);
      // Pause both decks cleanly if a call / another app interrupts us.
      AudioManager.observeAudioInterruptions(true);
    } catch { /* session setup is best-effort; playback still works in most cases */ }
    try { await this.ctx.resume(); } catch { /* noop */ }
    this.ready = true;
  }

  /** x in [0,1]: 0 = full deck A, 1 = full deck B, equal-power in between. */
  crossfade(x: number): void {
    const t = clamp(x, 0, 1);
    this.a.crossGain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.b.crossGain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.a.crossGain.gain.value = Math.cos(t * Math.PI / 2);
    this.b.crossGain.gain.value = Math.cos((1 - t) * Math.PI / 2);
  }

  /** Equal-power volume crossfade from one deck to the other over [t0, t0+durS], scheduled
   *  on the audio thread (smooth + survives backgrounding). `completeFrac` < 1 finishes the
   *  cross by that fraction of durS (outgoing hits 0, incoming full) and holds — so the
   *  outgoing is silent for the remainder, masking a loud/abrupt ending. */
  scheduleCross(fromId: DeckId, toId: DeckId, t0: number, durS: number, completeFrac = 1): void {
    const from = this.deck(fromId);
    const to = this.deck(toId);
    const cf = clamp(completeFrac, 0.1, 1);
    const N = 96;
    const outCurve = new Float32Array(N);
    const inCurve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const xe = Math.min(1, (i / (N - 1)) / cf); // reach the ends by fraction cf, then hold
      outCurve[i] = Math.cos((xe * Math.PI) / 2);       // 1 → 0
      inCurve[i] = Math.cos(((1 - xe) * Math.PI) / 2);  // 0 → 1
    }
    from.crossGain.gain.cancelScheduledValues(t0);
    to.crossGain.gain.cancelScheduledValues(t0);
    from.crossGain.gain.setValueCurveAtTime(outCurve, t0, durS);
    to.crossGain.gain.setValueCurveAtTime(inCurve, t0, durS);
  }

  /** The Auto-DJ "radio morph": over `blendS` seconds starting now, equal-power the volume
   *  across AND hand off the frequency bands (see MORPH) so one song melts into the next
   *  instead of merely overlapping. The incoming deck must already be PLAYING, pre-ducked
   *  (bass killed, mid/high at AUTO_*_DUCK). All ramps run on the audio thread. */
  scheduleMorph(fromId: DeckId, toId: DeckId, blendS: number, matched = false, completeFrac: number = MORPH.completeFrac): void {
    const t0 = this.ctx.currentTime;
    const from = this.deck(fromId);
    const to = this.deck(toId);
    const wS = completeFrac * blendS;           // the whole hand-off happens within this window;
    const at = (frac: number) => t0 + frac * wS; // EQ fractions are relative to it (then the outgoing is silent)

    this.scheduleCross(fromId, toId, t0, blendS, completeFrac);

    // Low — the "drums belong together" lever.
    if (matched) {
      // Locked kicks reinforce: the outgoing anchors the sub through a long shared window, the
      // incoming kick layers in — tucked UNDER the anchor (to AUTO_MATCH_BASS_SHARE, not full flat,
      // so two locked kicks can't double into boom) — then the outgoing bows out late.
      to.rampEq('low', AUTO_MATCH_BASS_DUCK, AUTO_MATCH_BASS_SHARE, t0, at(MORPH.mBassOutEnd));
      from.rampEq('low', 0, -1, at(MORPH.mBassOutStart), at(MORPH.mBassOutEnd));
    } else {
      // Unmatched: quick swap around the midpoint — only one track holds the sub at a time.
      from.rampEq('low', 0, -1, at(MORPH.bassOutStart), at(MORPH.bassOutEnd));
      to.rampEq('low', -1, 0, at(MORPH.bassInStart), at(MORPH.bassInEnd));
    }
    // Mid: incoming rises early, outgoing fades late.
    to.rampEq('mid', AUTO_MID_DUCK, 0, t0, at(MORPH.midInEnd));
    from.rampEq('mid', 0, AUTO_MID_DUCK, at(MORPH.midOutStart), t0 + wS);
    // High: a touch ahead of the mids.
    to.rampEq('high', AUTO_HIGH_DUCK, 0, t0, at(MORPH.highInEnd));
    from.rampEq('high', 0, AUTO_HIGH_DUCK, at(MORPH.highOutStart), t0 + wS);
  }

  setMasterVolume(v: number): void { this.master.gain.value = clamp(v, 0, 1); }

  async dispose(): Promise<void> {
    try { if (this.recording && this.recorder) await this.recorder.stop(); } catch { /* noop */ }
    this.recording = false;
    this.a.dispose();
    this.b.dispose();
    try { await this.ctx.close(); } catch { /* noop */ }
    try { await AudioManager.setAudioSessionActivity(false); } catch { /* noop */ }
    this.ready = false;
  }
}
