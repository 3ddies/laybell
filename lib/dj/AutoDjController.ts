// ── Auto-DJ controller (Listen Mode) ─────────────────────────────────────────
// Plays a queue across the two DJ decks and MORPHS one track into the next on
// play-out, so it sounds like one long coordinated radio mix rather than two
// songs overlapping. A manual skip is an instant hard-cut (no mix). See
// docs/AUTO_DJ_SPEC.md.
//
// How a transition is built (beginTransition):
//   • Beat grids for both tracks are analysed offline on preload (cached).
//   • If both read confidently and the tempos are within ±AUTO_MAX_STRETCH, the
//     incoming deck is tempo-matched and started PHASE-LOCKED to the outgoing's
//     current beat — so the beats land together ("beatmatch").
//   • The engine then runs a native-scheduled "morph": an equal-power volume
//     crossfade plus a staggered 3-band EQ hand-off (bass swaps mid-blend; mids/
//     highs cross-blend over the whole phrase). Blend length = 16 beats.
//   • If the grids aren't confident, it falls back to the SAME morph without
//     tempo/phase matching — still far smoother than a plain crossfade, never
//     worse than a wrong beatmatch.
//   • After the blend, the new (now live) deck eases back to its natural tempo.
//
// Imports only TYPES from the engine, so this module is safe to load anywhere.
import type { DjEngine } from './DjEngine';
import type { DeckId } from './constants';
import {
  AUTO_BLEND_BEATS,
  AUTO_BLEND_DEFAULT_S,
  AUTO_BLEND_MIN_S,
  AUTO_BLEND_MAX_S,
  AUTO_BEAT_MIN_CONFIDENCE,
  AUTO_MAX_STRETCH,
  AUTO_POST_RESTORE_S,
  AUTO_MID_DUCK,
  AUTO_HIGH_DUCK,
} from './constants';
import { type BeatGrid } from './beatGrid';

export type AutoDjTrack = { id: string; title: string; artist: string; url: string; cover?: string | null };

type Listener = {
  onTrack?: (track: AutoDjTrack | null, index: number) => void;
  onMixing?: (mixing: boolean) => void;
};

const TICK_MS = 250;
const clampIdx = (i: number, len: number) => Math.max(0, Math.min(len - 1, i));
const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const log = (...a: unknown[]) => { if (__DEV__) console.log('[auto-dj]', ...a); };

export class AutoDjController {
  private engine: DjEngine;
  private queue: AutoDjTrack[] = [];
  private index = 0;
  private live: DeckId = 'a';
  private transitioning = false;
  private preloadedIdx = -1;            // queue index currently loaded on the idle deck
  private grids = new Map<string, BeatGrid>(); // beat grid by track id (cached)
  private tick: ReturnType<typeof setInterval> | null = null;
  private promoteTimer: ReturnType<typeof setTimeout> | null = null;
  private restoreTimer: ReturnType<typeof setInterval> | null = null;
  private liveStretched = false;        // the soon-to-be-live deck was tempo-stretched
  private paused = false;
  private listener: Listener = {};

  constructor(engine: DjEngine) { this.engine = engine; }

  setListener(l: Listener) { this.listener = l; }
  get currentIndex() { return this.index; }
  get isMixing() { return this.transitioning; }
  private idle(): DeckId { return this.live === 'a' ? 'b' : 'a'; }

  /** Start `queue` from `index`, optionally at a position (hand-off from the normal player).
   *  Loads the current track on the live deck and preloads the next on the idle deck. */
  async start(queue: AutoDjTrack[], index = 0, startPosS = 0): Promise<void> {
    this.queue = queue;
    this.index = clampIdx(index, queue.length);
    this.live = 'a';
    this.paused = false;
    this.engine.crossfade(0);
    this.engine.a.resetEqNow();
    this.engine.b.resetEqNow();
    const t = this.queue[this.index];
    if (!t) return;
    await this.engine.a.load(t.url);
    if (startPosS > 0.1) this.engine.a.seek(startPosS);
    this.engine.a.play();
    log('started', { idx: this.index, dur: this.engine.a.durationS.toFixed(1), n: queue.length });
    this.emitTrack();
    this.computeGrid('a', t.id);
    this.preloadNext();
    this.startTick();
  }

  private startTick() { this.stopTick(); this.tick = setInterval(() => this.onTick(), TICK_MS); }
  private stopTick() { if (this.tick) { clearInterval(this.tick); this.tick = null; } }
  private clearPromote() { if (this.promoteTimer) { clearTimeout(this.promoteTimer); this.promoteTimer = null; } }
  private clearRestore() { if (this.restoreTimer) { clearInterval(this.restoreTimer); this.restoreTimer = null; } }

  /** Blend length for the given outgoing grid: 16 beats, clamped; default if unknown. */
  private estimateBlendS(gOut?: BeatGrid): number {
    if (gOut && gOut.confidence >= AUTO_BEAT_MIN_CONFIDENCE && gOut.bpm > 0) {
      return clampN(AUTO_BLEND_BEATS * (60 / gOut.bpm), AUTO_BLEND_MIN_S, AUTO_BLEND_MAX_S);
    }
    return AUTO_BLEND_DEFAULT_S;
  }

  private onTick() {
    if (this.paused || this.transitioning) return;
    const liveDeck = this.engine.deck(this.live);
    const dur = liveDeck.durationS;
    if (dur <= 0) return;
    const remaining = dur - liveDeck.position();
    const hasNext = this.index + 1 < this.queue.length;
    if (!hasNext) { if (remaining <= 0.2) this.stop(); return; }
    if (this.preloadedIdx === this.index + 1) {
      const outId = this.queue[this.index]?.id;
      const estBlend = this.estimateBlendS(outId ? this.grids.get(outId) : undefined);
      if (remaining <= estBlend && remaining > 1) { this.beginTransition(); return; }
    }
    if (remaining <= 0.4) void this.hardAdvance(); // ending without a ready blend → don't stall
  }

  private beginTransition() {
    const inc = this.idle();
    const liveDeck = this.engine.deck(this.live);
    const incDeck = this.engine.deck(inc);
    const outId = this.queue[this.index]?.id;
    const inId = this.queue[this.index + 1]?.id;
    const gOut = outId ? this.grids.get(outId) : undefined;
    const gIn = inId ? this.grids.get(inId) : undefined;

    this.clearRestore();
    this.transitioning = true;
    this.emitMixing(true);

    // Pre-duck the incoming so the morph can ramp it UP into the mix.
    incDeck.setBassNow(-1);
    incDeck.setEq('mid', AUTO_MID_DUCK);
    incDeck.setEq('high', AUTO_HIGH_DUCK);
    incDeck.setFilter(0);
    incDeck.setTempo(1);

    let blendS = this.estimateBlendS(gOut);
    let matched = false;

    if (
      gOut && gIn &&
      gOut.confidence >= AUTO_BEAT_MIN_CONFIDENCE &&
      gIn.confidence >= AUTO_BEAT_MIN_CONFIDENCE
    ) {
      // Pick the incoming octave (½/1/2×) whose tempo best matches the outgoing within range.
      const target = gOut.bpm;
      const cands = [gIn.bpm * 0.5, gIn.bpm, gIn.bpm * 2];
      let best: { bpm: number; ratio: number } | null = null;
      let bestErr = Infinity;
      for (const b of cands) {
        if (b <= 0) continue;
        const ratio = target / b;
        const err = Math.abs(1 - ratio);
        if (ratio >= 1 - AUTO_MAX_STRETCH && ratio <= 1 + AUTO_MAX_STRETCH && err < bestErr) {
          best = { bpm: b, ratio };
          bestErr = err;
        }
      }
      if (best) {
        incDeck.setTempo(best.ratio); // incoming's REAL bpm now equals the outgoing's
        // Phase-lock: start the incoming at the same fractional beat position the outgoing is at.
        const periodOut = 60 / gOut.bpm;
        const sinceGrid = liveDeck.position() - gOut.firstBeatS;
        const phaseFrac = ((sinceGrid % periodOut) + periodOut) % periodOut / periodOut;
        const periodIn = 60 / best.bpm;
        let off = gIn.firstBeatS + phaseFrac * periodIn; // first strong beat + matching phase
        if (!(off >= 0)) off = phaseFrac * periodIn;
        incDeck.seek(off);
        blendS = clampN(AUTO_BLEND_BEATS * periodOut, AUTO_BLEND_MIN_S, AUTO_BLEND_MAX_S);
        matched = true;
      }
    }
    if (!matched) incDeck.seek(gIn?.firstBeatS ?? 0);

    // Fit the blend inside the remaining runway with a small tail.
    const remaining = liveDeck.durationS - liveDeck.position();
    blendS = Math.min(blendS, remaining - 0.3);
    if (!(blendS > 0.5)) { this.transitioning = false; this.emitMixing(false); void this.hardAdvance(); return; }

    incDeck.play();
    this.engine.scheduleMorph(this.live, inc, blendS);
    this.liveStretched = matched;
    log('mixing', {
      from: this.live, to: inc, blendS: +blendS.toFixed(1), matched,
      outBpm: gOut ? +gOut.bpm.toFixed(1) : null, inBpm: gIn ? +gIn.bpm.toFixed(1) : null,
    });

    this.clearPromote();
    this.promoteTimer = setTimeout(() => this.promote(), blendS * 1000 + 120);
  }

  private promote() {
    this.clearPromote();
    const old = this.live;
    const inc = this.idle();
    this.live = inc;
    this.index += 1;

    const oldDeck = this.engine.deck(old);
    oldDeck.pause();           // the outgoing track has played out
    oldDeck.resetEqNow();      // flatten for reuse (cancels any in-flight ramps)
    oldDeck.setFilter(0);
    oldDeck.setTempo(1);

    const liveDeck = this.engine.deck(this.live);
    liveDeck.resetEqNow();     // the ramps brought it to flat; make sure + cancel schedules
    this.engine.crossfade(this.live === 'a' ? 0 : 1);

    if (this.liveStretched && Math.abs(liveDeck.tempoRate - 1) > 0.001) this.startTempoRestore(this.live);
    this.liveStretched = false;

    this.transitioning = false;
    this.emitMixing(false);
    this.emitTrack();
    log('promoted → live', this.live, 'idx', this.index);
    this.preloadNext();
  }

  /** After a beatmatched blend, ease the (now live) deck from its stretched tempo back to 1.0. */
  private startTempoRestore(id: DeckId) {
    this.clearRestore();
    const deck = this.engine.deck(id);
    const from = deck.tempoRate;
    if (Math.abs(from - 1) < 0.001) return;
    const steps = 24;
    let i = 0;
    this.restoreTimer = setInterval(() => {
      i++;
      deck.setTempo(from + (1 - from) * (i / steps));
      if (i >= steps) { deck.setTempo(1); this.clearRestore(); }
    }, (AUTO_POST_RESTORE_S * 1000) / steps);
  }

  /** The track ended before a blend was ready — advance now (instant via the preloaded deck,
   *  else load on the live deck). */
  private async hardAdvance() {
    if (this.index + 1 >= this.queue.length) { this.stop(); return; }
    this.clearPromote();
    this.clearRestore();
    this.transitioning = false;
    this.emitMixing(false);
    const inc = this.idle();
    log('hard-advance', { preloaded: this.preloadedIdx, want: this.index + 1 });
    if (this.preloadedIdx === this.index + 1) {
      this.engine.deck(this.live).pause();
      this.engine.deck(this.live).resetEqNow();
      this.engine.deck(this.live).setTempo(1);
      const d = this.engine.deck(inc);
      d.resetEqNow();
      d.setTempo(1);
      d.seek(0);
      d.play();
      this.engine.crossfade(inc === 'a' ? 0 : 1);
      this.live = inc;
      this.index += 1;
    } else {
      this.index += 1;
      this.engine.crossfade(this.live === 'a' ? 0 : 1);
      const d = this.engine.deck(this.live);
      d.resetEqNow();
      d.setTempo(1);
      await d.load(this.queue[this.index].url);
      d.play();
      this.computeGrid(this.live, this.queue[this.index].id);
    }
    this.emitTrack();
    this.preloadNext();
  }

  private async preloadNext() {
    const nextIdx = this.index + 1;
    if (nextIdx >= this.queue.length) { this.preloadedIdx = -1; return; }
    const idle = this.idle();
    try {
      const d = this.engine.deck(idle);
      await d.load(this.queue[nextIdx].url);
      d.resetEqNow();
      d.setTempo(1);
      this.preloadedIdx = nextIdx;
      log('preloaded', nextIdx, 'on', idle);
      this.computeGrid(idle, this.queue[nextIdx].id);
    } catch (e) { this.preloadedIdx = -1; log('preload FAILED', nextIdx, e); }
  }

  /** Analyse + cache the beat grid for a loaded deck (once per track id). Synchronous CPU
   *  (~100ms), run with plenty of headroom before the transition. */
  private computeGrid(id: DeckId, trackId: string) {
    if (!trackId || this.grids.has(trackId)) return;
    try {
      const g = this.engine.deck(id).beatGrid();
      if (g) {
        this.grids.set(trackId, g);
        log('grid', { bpm: +g.bpm.toFixed(1), conf: +g.confidence.toFixed(2), firstBeat: +g.firstBeatS.toFixed(2) });
      } else {
        log('grid: none');
      }
    } catch (e) { log('grid FAILED', e); }
  }

  /** Manual skip — instant hard-cut (no mix). Mid-blend, finish the blend immediately. */
  async skipNext(): Promise<void> {
    if (this.transitioning) { this.clearPromote(); this.promote(); return; }
    if (this.index + 1 >= this.queue.length) { this.stop(); return; }
    await this.hardAdvance();
  }

  pause() {
    this.paused = true;
    this.engine.deck(this.live).pause();
    if (this.transitioning) this.engine.deck(this.idle()).pause();
  }
  resume() {
    this.paused = false;
    this.engine.deck(this.live).play();
    if (this.transitioning) this.engine.deck(this.idle()).play();
  }

  stop() {
    this.clearPromote();
    this.clearRestore();
    this.stopTick();
    if (this.transitioning) { this.transitioning = false; this.emitMixing(false); }
    this.engine.a.pause();
    this.engine.b.pause();
  }

  /** Live position + duration, for a now-playing scrubber. */
  position(): { pos: number; dur: number } {
    const d = this.engine.deck(this.live);
    return { pos: d.position(), dur: d.durationS };
  }

  private emitTrack() { this.listener.onTrack?.(this.queue[this.index] ?? null, this.index); }
  private emitMixing(m: boolean) { this.listener.onMixing?.(m); }
}
