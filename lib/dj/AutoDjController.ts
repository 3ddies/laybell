// ── Auto-DJ controller (Listen Mode, Phase A) ────────────────────────────────
// Plays a queue across the two DJ decks and mixes one track into the next on
// PLAY-OUT: preload the next track on the idle deck, then crossfade + bass-swap as
// the current track ends. A manual skip is an instant hard-cut (no mix). See
// docs/AUTO_DJ_SPEC.md.
//
// The crossfade is driven on a fast interval with direct gain/EQ sets — the exact
// mechanism the booth's crossfader + EQ knobs already use (proven audible) — rather
// than native param curves, so there's nothing to go wrong silently.
//
// Imports only TYPES from the engine, so this module is safe to load anywhere.
import type { DjEngine } from './DjEngine';
import type { DeckId } from './constants';

export type AutoDjTrack = { id: string; title: string; artist: string; url: string; cover?: string | null };

type Listener = {
  onTrack?: (track: AutoDjTrack | null, index: number) => void;
  onMixing?: (mixing: boolean) => void;
};

const TRANSITION_S = 10;   // crossfade length (and the runway that triggers it)
const TICK_MS = 250;
const RAMP_MS = 30;        // crossfade step (~33Hz, smooth for a slow fade)

const clampIdx = (i: number, len: number) => Math.max(0, Math.min(len - 1, i));
const log = (...a: unknown[]) => { if (__DEV__) console.log('[auto-dj]', ...a); };

export class AutoDjController {
  private engine: DjEngine;
  private queue: AutoDjTrack[] = [];
  private index = 0;
  private live: DeckId = 'a';
  private transitioning = false;
  private preloadedIdx = -1;            // queue index currently loaded on the idle deck
  private tick: ReturnType<typeof setInterval> | null = null;
  private trans: ReturnType<typeof setInterval> | null = null;
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
    this.engine.a.setBassNow(0);
    this.engine.b.setBassNow(0);
    const t = this.queue[this.index];
    if (!t) return;
    await this.engine.a.load(t.url);
    if (startPosS > 0.1) this.engine.a.seek(startPosS);
    this.engine.a.play();
    log('started', { idx: this.index, dur: this.engine.a.durationS.toFixed(1), n: queue.length });
    this.emitTrack();
    this.preloadNext();
    this.startTick();
  }

  private startTick() { this.stopTick(); this.tick = setInterval(() => this.onTick(), TICK_MS); }
  private stopTick() { if (this.tick) { clearInterval(this.tick); this.tick = null; } }
  private clearTrans() { if (this.trans) { clearInterval(this.trans); this.trans = null; } }

  private onTick() {
    if (this.paused || this.transitioning) return;
    const liveDeck = this.engine.deck(this.live);
    const dur = liveDeck.durationS;
    if (dur <= 0) return;
    const remaining = dur - liveDeck.position();
    const hasNext = this.index + 1 < this.queue.length;
    if (!hasNext) { if (remaining <= 0.2) this.stop(); return; }
    if (this.preloadedIdx === this.index + 1 && remaining <= TRANSITION_S && remaining > 1) {
      this.beginTransition();
    } else if (remaining <= 0.4) {
      // Ending without a ready blend (preload late / short track) → don't stall, hard-advance.
      void this.hardAdvance();
    }
  }

  private beginTransition() {
    const inc = this.idle();
    const liveDeck = this.engine.deck(this.live);
    const len = Math.min(TRANSITION_S, Math.max(2, liveDeck.durationS - liveDeck.position()));
    this.transitioning = true;
    this.emitMixing(true);
    const incDeck = this.engine.deck(inc);
    incDeck.setBassNow(-1); // pre-cut the incoming bass for the swap
    incDeck.seek(0);
    incDeck.play();
    log('mixing', { from: this.live, to: inc, len: len.toFixed(1), idx: this.index });
    const startMs = Date.now();
    const lenMs = len * 1000;
    this.clearTrans();
    this.trans = setInterval(() => {
      const t = Math.min(1, (Date.now() - startMs) / lenMs);
      this.engine.crossfade(this.live === 'a' ? t : 1 - t);  // fade live → incoming
      this.engine.deck(this.live).setEq('low', -t);          // outgoing bass 0 → kill
      this.engine.deck(inc).setEq('low', -(1 - t));          // incoming bass kill → 0
      if (t >= 1) this.promote();
    }, RAMP_MS);
  }

  private promote() {
    this.clearTrans();
    const old = this.live;
    const inc = this.idle();
    this.live = inc;
    this.index += 1;
    this.engine.deck(old).pause();      // the outgoing track has played out
    this.engine.deck(old).setBassNow(0);
    this.engine.crossfade(this.live === 'a' ? 0 : 1);
    this.transitioning = false;
    this.emitMixing(false);
    this.emitTrack();
    log('promoted → live', this.live, 'idx', this.index);
    this.preloadNext();
  }

  /** The track ended before a blend was ready — advance now (instant via the preloaded deck,
   *  else load on the live deck). */
  private async hardAdvance() {
    if (this.index + 1 >= this.queue.length) { this.stop(); return; }
    this.clearTrans();
    this.transitioning = false;
    this.emitMixing(false);
    const inc = this.idle();
    log('hard-advance', { preloaded: this.preloadedIdx, want: this.index + 1 });
    if (this.preloadedIdx === this.index + 1) {
      this.engine.deck(this.live).pause();
      this.engine.deck(this.live).setBassNow(0);
      this.engine.deck(inc).setBassNow(0);
      this.engine.deck(inc).seek(0);
      this.engine.deck(inc).play();
      this.engine.crossfade(inc === 'a' ? 0 : 1);
      this.live = inc;
      this.index += 1;
    } else {
      this.index += 1;
      this.engine.crossfade(this.live === 'a' ? 0 : 1);
      this.engine.deck(this.live).setBassNow(0);
      await this.engine.deck(this.live).load(this.queue[this.index].url);
      this.engine.deck(this.live).play();
    }
    this.emitTrack();
    this.preloadNext();
  }

  private async preloadNext() {
    const nextIdx = this.index + 1;
    if (nextIdx >= this.queue.length) { this.preloadedIdx = -1; return; }
    const idle = this.idle();
    try {
      await this.engine.deck(idle).load(this.queue[nextIdx].url);
      this.engine.deck(idle).setBassNow(0);
      this.preloadedIdx = nextIdx;
      log('preloaded', nextIdx, 'on', idle);
    } catch (e) { this.preloadedIdx = -1; log('preload FAILED', nextIdx, e); }
  }

  /** Manual skip — instant hard-cut (no mix). */
  async skipNext(): Promise<void> {
    if (this.index + 1 >= this.queue.length) { this.stop(); return; }
    this.cancelTransition();
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

  private cancelTransition() {
    this.clearTrans();
    if (this.transitioning) {
      this.engine.deck(this.idle()).pause();
      this.transitioning = false;
      this.emitMixing(false);
    }
  }

  stop() {
    this.cancelTransition();
    this.stopTick();
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
