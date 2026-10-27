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
  type AudioBuffer,
  type AudioBufferSourceNode,
  type GainNode,
  type BiquadFilterNode,
  type DelayNode,
  type AudioNode,
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
const LP_OPEN_HZ = 20000; // lowpass fully open ≈ no effect
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

  // Loop + cues (seconds).
  private loopOn = false;
  private loopStartS = 0;
  private loopEndS = 0;
  cues: Array<number | null> = [null, null, null, null];

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

  /** Decode a song URL (or local path) into this deck, stopped at 0. */
  async load(url: string): Promise<void> {
    this.stopSource();
    this.playing = false;
    this.pausedAt = 0;
    this.loopOn = false;
    this.cues = [null, null, null, null];
    const buf = await this.ctx.decodeAudioData(url);
    this.buffer = buf;
    this.durationS = buf.duration;
  }

  /** `n` normalized waveform peak bars (0..1), or null if nothing is loaded. */
  peaks(n = 400): Float32Array | null {
    return this.buffer ? computePeaks(this.buffer, n) : null;
  }

  /** Current playback position in seconds. */
  position(): number {
    if (!this.playing) return this.pausedAt;
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
  }

  toggle(): void { this.playing ? this.pause() : this.play(); }

  seek(sec: number): void {
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

  /** Ramp the low EQ to `toKnob` between startT and endT (the auto-mix bass swap). Native,
   *  so it stays smooth and survives the app backgrounding. */
  rampBass(toKnob: number, startT: number, endT: number): void {
    this.eqLow.gain.setValueAtTime(this.eqLow.gain.value, startT);
    this.eqLow.gain.linearRampToValueAtTime(eqKnobToDb(clamp(toKnob, -1, 1)), endT);
  }

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
  /** FX: muffle this deck away (open → dark lowpass) as it exits — "sinking into the distance". */
  sweepOutDark(startT: number, durS: number): void { this.rampFilterLowpass(LP_OPEN_HZ, 350, startT, durS); }
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
    this.channelGain.gain.cancelScheduledValues(this.ctx.currentTime); // clear any stutter gating
    this.channelGain.gain.value = clamp(v, 0, 1);
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
    this.a.dispose();
    this.b.dispose();
    try { await this.ctx.close(); } catch { /* noop */ }
    try { await AudioManager.setAudioSessionActivity(false); } catch { /* noop */ }
    this.ready = false;
  }
}
