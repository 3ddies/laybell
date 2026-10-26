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
} from 'react-native-audio-api';
import { TEMPO_MIN, TEMPO_MAX, AUTO_MID_DUCK, AUTO_HIGH_DUCK, type EqBand, type DeckId } from './constants';
import { analyzeBeatGrid, type BeatGrid } from './beatGrid';

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
const MORPH = {
  bassOutStart: 0.35, bassOutEnd: 0.52, // outgoing low: flat → kill
  bassInStart: 0.48, bassInEnd: 0.66,   // incoming low: kill → flat (just after)
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

  constructor(id: DeckId, ctx: AudioContext, master: GainNode) {
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

    // Wire the permanent chain once.
    this.eqLow.connect(this.eqMid);
    this.eqMid.connect(this.eqHigh);
    this.eqHigh.connect(this.filter);
    this.filter.connect(this.channelGain);
    this.channelGain.connect(this.crossGain);
    this.crossGain.connect(master);
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

  /** Estimate this track's beat grid (BPM + phase) from the decoded buffer, or null. */
  beatGrid(): BeatGrid | null {
    if (!this.buffer) return null;
    try {
      const sr = (this.buffer as unknown as { sampleRate?: number }).sampleRate ?? this.ctx.sampleRate;
      return analyzeBeatGrid(this.buffer.getChannelData(0), sr);
    } catch {
      return null;
    }
  }

  /** Filter knob in [-1,1]: <0 lowpass (darker), >0 highpass (thinner), 0 = open. */
  setFilter(knob: number): void {
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
  setVolume(v: number): void { this.channelGain.gain.value = clamp(v, 0, 1); }

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
  private ready = false;

  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.a = new Deck('a', this.ctx, this.master);
    this.b = new Deck('b', this.ctx, this.master);
    this.crossfade(0.5);
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
   *  on the audio thread (smooth + survives backgrounding). */
  scheduleCross(fromId: DeckId, toId: DeckId, t0: number, durS: number): void {
    const from = this.deck(fromId);
    const to = this.deck(toId);
    const N = 64;
    const outCurve = new Float32Array(N);
    const inCurve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = i / (N - 1);
      outCurve[i] = Math.cos((x * Math.PI) / 2);       // 1 → 0
      inCurve[i] = Math.cos(((1 - x) * Math.PI) / 2);  // 0 → 1
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
  scheduleMorph(fromId: DeckId, toId: DeckId, blendS: number): void {
    const t0 = this.ctx.currentTime;
    const from = this.deck(fromId);
    const to = this.deck(toId);
    const at = (frac: number) => t0 + frac * blendS;

    this.scheduleCross(fromId, toId, t0, blendS);

    // Low: quick swap around the midpoint — only one track holds the sub at a time.
    from.rampEq('low', 0, -1, at(MORPH.bassOutStart), at(MORPH.bassOutEnd));
    to.rampEq('low', -1, 0, at(MORPH.bassInStart), at(MORPH.bassInEnd));
    // Mid: incoming rises early, outgoing fades late.
    to.rampEq('mid', AUTO_MID_DUCK, 0, t0, at(MORPH.midInEnd));
    from.rampEq('mid', 0, AUTO_MID_DUCK, at(MORPH.midOutStart), t0 + blendS);
    // High: a touch ahead of the mids.
    to.rampEq('high', AUTO_HIGH_DUCK, 0, t0, at(MORPH.highInEnd));
    from.rampEq('high', 0, AUTO_HIGH_DUCK, at(MORPH.highOutStart), t0 + blendS);
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
