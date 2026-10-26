// ── Auto-DJ controller (Listen Mode, Phase A) ────────────────────────────────
// Plays a queue across the two DJ decks and mixes one track into the next on
// PLAY-OUT: preload the next track on the idle deck, then native equal-power
// crossfade + bass-swap as the current track ends (DjEngine.scheduleTransition).
// A manual skip is an instant hard-cut (no mix). See docs/AUTO_DJ_SPEC.md.
//
// Imports only TYPES from the engine, so this module is safe to load anywhere —
// the actual native DjEngine is created lazily by the caller (the Listen-mode
// context) and handed in.
import type { DjEngine } from './DjEngine';
import type { DeckId } from './constants';

export type AutoDjTrack = { id: string; title: string; artist: string; url: string };

type Listener = {
  onTrack?: (track: AutoDjTrack | null, index: number) => void;
  onMixing?: (mixing: boolean) => void;
};

const TRANSITION_S = 10;   // crossfade length (and how much runway triggers it)
const TICK_MS = 250;

const clampIdx = (i: number, len: number) => Math.max(0, Math.min(len - 1, i));

export class AutoDjController {
  private engine: DjEngine;
  private queue: AutoDjTrack[] = [];
  private index = 0;
  private live: DeckId = 'a';
  private transitioning = false;
  private preloadedIdx = -1;            // queue index currently loaded on the idle deck
  private tick: ReturnType<typeof setInterval> | null = null;
  private promoteTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.engine.crossfade(0);          // full A
    this.engine.a.setBassNow(0);
    this.engine.b.setBassNow(0);
    const t = this.queue[this.index];
    if (!t) return;
    await this.engine.a.load(t.url);
    if (startPosS > 0.1) this.engine.a.seek(startPosS);
    this.engine.a.play();
    this.emitTrack();
    this.preloadNext();
    this.startTick();
  }

  private startTick() { this.stopTick(); this.tick = setInterval(() => this.onTick(), TICK_MS); }
  private stopTick() { if (this.tick) { clearInterval(this.tick); this.tick = null; } }

  private onTick() {
    if (this.paused || this.transitioning) return;
    const liveDeck = this.engine.deck(this.live);
    const dur = liveDeck.durationS;
    if (dur <= 0) return;
    const remaining = dur - liveDeck.position();
    const hasNext = this.index + 1 < this.queue.length;
    if (hasNext && this.preloadedIdx === this.index + 1 && remaining <= TRANSITION_S && remaining > 0.25) {
      this.beginTransition();
    } else if (!hasNext && remaining <= 0.2) {
      this.stop(); // queue finished on the last track
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
    this.engine.scheduleTransition(this.live, inc, len);
    if (this.promoteTimer) clearTimeout(this.promoteTimer);
    this.promoteTimer = setTimeout(() => this.promote(), len * 1000);
  }

  private promote() {
    const old = this.live;
    this.live = this.idle();
    this.index += 1;
    this.engine.deck(old).pause();       // the outgoing track has played out
    this.engine.deck(old).setBassNow(0);
    this.engine.crossfade(this.live === 'a' ? 0 : 1);
    this.transitioning = false;
    this.promoteTimer = null;
    this.emitMixing(false);
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
    } catch { this.preloadedIdx = -1; } // undecodable → it'll just be skipped
  }

  /** Manual skip — instant hard-cut (no mix). Uses the preloaded deck when ready. */
  async skipNext(): Promise<void> {
    if (this.index + 1 >= this.queue.length) { this.stop(); return; }
    const inc = this.idle();
    const usePreloaded = this.preloadedIdx === this.index + 1;
    this.cancelTransition();
    if (usePreloaded) {
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
    if (this.promoteTimer) { clearTimeout(this.promoteTimer); this.promoteTimer = null; }
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
