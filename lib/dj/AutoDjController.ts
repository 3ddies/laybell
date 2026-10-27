// ── Auto-DJ controller (Listen Mode) ─────────────────────────────────────────
// Plays a queue across the two DJ decks and MORPHS one track into the next on
// play-out, so it sounds like one long coordinated radio mix rather than two
// songs overlapping. A manual skip is an instant hard-cut (no mix). See
// docs/AUTO_DJ_SPEC.md.
//
// How a transition is built (beginTransition):
//   • Each track is analysed once on preload (cached): its beat grid (BPM +
//     phase) AND where its audio truly ends (trailing silence trimmed) + whether
//     that ending is abrupt.
//   • If both grids read confidently and the tempos are within ±AUTO_MAX_STRETCH,
//     the incoming deck is tempo-matched and started PHASE-LOCKED to the
//     outgoing's current beat ("beatmatch").
//   • The engine runs a native-scheduled "morph": equal-power volume crossfade +
//     a staggered 3-band EQ hand-off. Blend length = 16 beats.
//   • The blend is anchored to the outgoing track's TRUE audio end (not the file
//     length), so it's faded out before the song actually stops — no snap-off.
//     Cold/abrupt endings get extra headroom.
//   • If grids aren't confident, it falls back to the SAME morph without tempo/
//     phase matching — smoother than a crossfade, never a wrong beatmatch.
//   • After the blend the new (now live) deck eases back to its natural tempo.
//
// Imports only TYPES from the engine, so this module is safe to load anywhere.
import type { DjEngine } from './DjEngine';
import type { DeckId } from './constants';
import {
  AUTO_BLEND_MIN_S,
  AUTO_BLEND_MAX_S,
  AUTO_MIN_PLAY_S,
  AUTO_BEAT_MIN_CONFIDENCE,
  AUTO_MAX_STRETCH,
  AUTO_MATCH_HOLD_FRAC,
  AUTO_MATCH_GLIDE_END_FRAC,
  AUTO_END_GUARD_S,
  AUTO_END_GUARD_ABRUPT_S,
  AUTO_MID_DUCK,
  AUTO_HIGH_DUCK,
  AUTO_MATCH_BASS_DUCK,
  AUTO_EFFECT_CLEAR_MS,
} from './constants';
import { type BeatGrid, type EndType, type StartType } from './beatGrid';
import { planTransition, type TransitionPlan } from './transitionPlan';

export type AutoDjTrack = { id: string; title: string; artist: string; url: string; cover?: string | null };
type TrackAnalysis = { grid: BeatGrid | null; endS: number; abrupt: boolean; endType: EndType; startType: StartType };

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
  private analysis = new Map<string, TrackAnalysis>(); // by track id (cached)
  private tick: ReturnType<typeof setInterval> | null = null;
  private promoteTimer: ReturnType<typeof setTimeout> | null = null;
  private restoreTimer: ReturnType<typeof setInterval> | null = null;
  private echoActive = false;           // an echo-out tail is engaged on `echoDeck`
  private echoDeck: DeckId | null = null;
  private garnishIdx = 0;               // rotates the fallback garnish so plain transitions vary
  private paused = false;
  private userActedAt = 0;              // wall-clock of the last user scrub/skip — gates opportunistic effects
  private adGate: (() => boolean) | null = null; // "an ad is due AND eligible" — hold the transition so the break lands clean
  private listener: Listener = {};

  constructor(engine: DjEngine) { this.engine = engine; }

  setListener(l: Listener) { this.listener = l; }
  /** Install a predicate that returns true when an audio-ad break is due AND there's eligible
   *  inventory. While it's true the opportunistic transition is held back so the song plays out to a
   *  clean hard-advance (the break then fires on that clean boundary — see AudioContext). Owner's
   *  rule: "let the full song finish without the effect so the ad can play, or when a user skips". */
  setAdGate(fn: (() => boolean) | null) { this.adGate = fn; }
  get currentIndex() { return this.index; }
  get isMixing() { return this.transitioning; }
  private idle(): DeckId { return this.live === 'a' ? 'b' : 'a'; }
  private gridOf(trackId?: string): BeatGrid | undefined { return trackId ? this.analysis.get(trackId)?.grid ?? undefined : undefined; }

  /** The outgoing track's true audio end (trailing silence trimmed), falling back to the file
   *  length. The blend is anchored here, not to durationS. */
  private effectiveEnd(deckId: DeckId, trackId?: string): number {
    const dur = this.engine.deck(deckId).durationS;
    const a = trackId ? this.analysis.get(trackId) : undefined;
    return a && a.endS > 0 && a.endS <= dur ? a.endS : dur;
  }

  /** Start `queue` from `index`, optionally at a position (hand-off from the normal player).
   *  Loads the current track on the live deck and preloads the next on the idle deck. */
  async start(queue: AutoDjTrack[], index = 0, startPosS = 0): Promise<void> {
    this.queue = queue;
    this.index = clampIdx(index, queue.length);
    this.live = 'a';
    this.paused = false;
    this.resetDecksAndFx(); // clean slate — no leftover EQ/filter/tempo/echo from a prior run
    this.engine.crossfade(0);
    const t = this.queue[this.index];
    if (!t) return;
    await this.engine.a.load(t.url);
    if (startPosS > 0.1) this.engine.a.seek(startPosS);
    this.engine.a.play();
    log('started', { idx: this.index, dur: this.engine.a.durationS.toFixed(1), n: queue.length });
    this.emitTrack();
    this.computeAnalysis('a', t.id);
    this.preloadNext();
    this.startTick();
  }

  private startTick() { this.stopTick(); this.tick = setInterval(() => this.onTick(), TICK_MS); }
  private stopTick() { if (this.tick) { clearInterval(this.tick); this.tick = null; } }
  private clearPromote() { if (this.promoteTimer) { clearTimeout(this.promoteTimer); this.promoteTimer = null; } }
  private clearRestore() { if (this.restoreTimer) { clearInterval(this.restoreTimer); this.restoreTimer = null; } }

  /** Fully reset both decks + the echo bus + timers to a neutral state. The single source of truth
   *  for "no stuck EQ/filter/tempo/gate/echo", used on start and stop so no prior state can leak into
   *  a new session or linger after one — robustness for any song or interaction. */
  private resetDecksAndFx() {
    this.clearPromote();
    this.clearRestore();
    for (const id of ['a', 'b'] as DeckId[]) {
      const d = this.engine.deck(id);
      d.resetEqNow();
      d.setFilter(0);
      d.setVolume(1);
      d.setTempo(1);
    }
    this.engine.echoReset();
    this.echoActive = false;
    this.echoDeck = null;
  }

  /** Can these two tracks beat-lock? Returns the chosen incoming tempo (octave-folded) + ratio,
   *  or null (→ EQ-blend fallback). Shared by the trigger and the transition so they agree. */
  private bestMatch(gOut?: BeatGrid, gIn?: BeatGrid): { bpm: number; ratio: number } | null {
    if (!gOut || !gIn || gOut.confidence < AUTO_BEAT_MIN_CONFIDENCE || gIn.confidence < AUTO_BEAT_MIN_CONFIDENCE) return null;
    const target = gOut.bpm;
    const cands = [gIn.bpm * 0.5, gIn.bpm, gIn.bpm * 2];
    let best: { bpm: number; ratio: number } | null = null;
    let bestErr = Infinity;
    for (const b of cands) {
      if (b <= 0) continue;
      const ratio = target / b;
      const err = Math.abs(1 - ratio);
      if (ratio >= 1 - AUTO_MAX_STRETCH && ratio <= 1 + AUTO_MAX_STRETCH && err < bestErr) { best = { bpm: b, ratio }; bestErr = err; }
    }
    return best;
  }

  /** The recipe for the current outgoing→incoming pair (how it ends / how the next one starts). */
  private planFor(outId?: string, inId?: string, matched?: boolean): TransitionPlan {
    const aOut = outId ? this.analysis.get(outId) : undefined;
    const aIn = inId ? this.analysis.get(inId) : undefined;
    const m = matched ?? !!this.bestMatch(aOut?.grid ?? undefined, aIn?.grid ?? undefined);
    return planTransition(aOut?.endType ?? 'standard', aIn?.startType ?? 'standard', m);
  }

  /** The recipe's blend length in seconds: beats × tempo when the outgoing grid is known, else the
   *  recipe's second-based default. Clamped. */
  private blendLenFor(plan: TransitionPlan, gOut?: BeatGrid): number {
    if (gOut && gOut.confidence >= AUTO_BEAT_MIN_CONFIDENCE && gOut.bpm > 0) {
      return clampN(plan.blendBeats * (60 / gOut.bpm), AUTO_BLEND_MIN_S, AUTO_BLEND_MAX_S);
    }
    return plan.blendDefaultS;
  }

  private onTick() {
    if (this.paused || this.transitioning) return;
    const liveDeck = this.engine.deck(this.live);
    const dur = liveDeck.durationS;
    if (dur <= 0) return;
    const pos = liveDeck.position();
    const hasNext = this.index + 1 < this.queue.length;
    if (!hasNext) { if (dur - pos <= 0.2) this.stop(); return; }
    const outId = this.queue[this.index]?.id;
    const inId = this.queue[this.index + 1]?.id;
    const remaining = this.effectiveEnd(this.live, outId) - pos; // time to the TRUE audio end
    const minPlay = Math.min(AUTO_MIN_PLAY_S, dur * 0.5); // let a track breathe before mixing out (short-track-safe)
    if (this.preloadedIdx === this.index + 1 && pos >= minPlay) {
      const estBlend = this.blendLenFor(this.planFor(outId, inId), this.gridOf(outId)); // recipe-aware trigger
      if (remaining <= estBlend && remaining > 1) {
        // The effect is opportunistic — it fires only when BOTH are clear:
        //   • the run-up was untouched (a recent scrub/skip means the user is in control, so don't
        //     force a possibly-rushed transition), and
        //   • no ad break is pending with eligible inventory (the owner's rule: let the song finish
        //     WITHOUT the effect so the break lands on a clean boundary — the ad fires at the
        //     hard-advance below, or on a manual skip).
        // When either fails, the track just plays out to the clean hard-advance (the effect
        // gracefully doesn't happen — it never fights the user or an incoming ad).
        const userClear = Date.now() - this.userActedAt >= AUTO_EFFECT_CLEAR_MS;
        const holdForAd = this.adGate?.() ?? false;
        if (userClear && !holdForAd) { this.beginTransition(); return; }
      }
    }
    if (remaining <= 0.4) void this.hardAdvance(); // at the audio end with no blend ready → don't stall
  }

  private beginTransition() {
    const inc = this.idle();
    const liveDeck = this.engine.deck(this.live);
    const incDeck = this.engine.deck(inc);
    const outId = this.queue[this.index]?.id;
    const inId = this.queue[this.index + 1]?.id;
    const aOut = outId ? this.analysis.get(outId) : undefined;
    const aIn = inId ? this.analysis.get(inId) : undefined;
    const gOut = aOut?.grid ?? undefined;
    const gIn = aIn?.grid ?? undefined;

    this.clearRestore();
    this.transitioning = true;
    this.emitMixing(true);

    // Pre-duck the incoming so the morph can ramp it UP into the mix. (Bass pre-duck is set
    // below, once we know whether this is a beat-locked blend.)
    incDeck.setEq('mid', AUTO_MID_DUCK);
    incDeck.setEq('high', AUTO_HIGH_DUCK);
    incDeck.setFilter(0);
    incDeck.setTempo(1);

    // Beat-lock? And which recipe fits how this song ENDS / how the next STARTS.
    const best = this.bestMatch(gOut, gIn);
    const matched = !!best;
    const plan = planTransition(aOut?.endType ?? 'standard', aIn?.startType ?? 'standard', matched);
    // WOW insurance + variety: an unclassified 'standard' pair (common with brand-new songs) still gets
    // a light, ROTATING garnish — so it's never a bare crossfade and consecutive plains differ.
    const garnish: 'dark' | 'wash' | null = plan.name === 'standard'
      ? (['dark', null, 'wash'] as const)[this.garnishIdx++ % 3]
      : null;
    let blendS = this.blendLenFor(plan, gOut);
    let matchRatio: number | null = null;

    if (best && gOut && gIn) {
      matchRatio = best.ratio;
      incDeck.setTempo(best.ratio); // incoming's REAL bpm now equals the outgoing's
      const periodOut = 60 / gOut.bpm;
      const sinceGrid = liveDeck.position() - gOut.firstBeatS;
      const phaseFrac = ((sinceGrid % periodOut) + periodOut) % periodOut / periodOut;
      const periodIn = 60 / best.bpm;
      let off = gIn.firstBeatS + phaseFrac * periodIn; // first strong beat + matching phase
      if (!(off >= 0)) off = phaseFrac * periodIn;
      incDeck.seek(off);
    } else {
      incDeck.seek(gIn?.firstBeatS ?? 0);
    }

    // Anchor the blend to the outgoing's TRUE audio end, with headroom so the fade is
    // complete before the song stops (more for cold/abrupt endings).
    const end = this.effectiveEnd(this.live, outId);
    const guard = aOut?.abrupt ? AUTO_END_GUARD_ABRUPT_S : AUTO_END_GUARD_S;
    const runway = end - liveDeck.position() - guard;
    blendS = Math.min(blendS, runway);
    if (!(blendS > 0.5)) { this.transitioning = false; this.emitMixing(false); void this.hardAdvance(); return; }

    // Matched → tuck the incoming kick (both locked kicks layer); unmatched → kill it (clean swap).
    incDeck.setBassNow(matched ? AUTO_MATCH_BASS_DUCK : -1);
    incDeck.play();
    this.engine.scheduleMorph(this.live, inc, blendS, matched, plan.completeFrac);
    if (matched && matchRatio) this.startMatchGlide(inc, matchRatio, blendS);

    // FX sweeps (recipe-driven). Timed off the hand-off window wS = completeFrac × blend.
    const fxT0 = this.engine.ctx.currentTime;
    const wS = plan.completeFrac * blendS;
    if (plan.outFilter) liveDeck.sweepOutDark(fxT0 + 0.4 * wS, 0.55 * wS); // darken the outgoing as it leaves
    if (plan.inFilter) incDeck.sweepInOpen(fxT0, 0.7 * wS);                // open the incoming up as it arrives
    if (plan.riser) liveDeck.sweepOutThin(fxT0 + 0.2 * wS, 0.7 * wS);      // highpass riser building into the drop
    if (plan.tapeStop) liveDeck.brake(fxT0 + 0.05, 0.5);                   // spin the outgoing down into the drop
    if (plan.stutter) {
      const beatS = gOut && gOut.bpm > 0 ? 60 / gOut.bpm : 0.5;
      liveDeck.stutter(fxT0 + 0.08, beatS / 4, 4);                         // one beat of 1/16 chops, beat-synced
    }
    if (plan.uplift) this.engine.uplift(fxT0 + 0.2 * wS, 0.6 * wS);        // white-noise whoosh building into the drop
    if (plan.bloom) this.engine.washBloom(inc, fxT0, 0.6 * blendS);        // incoming blooms in lush, then tightens
    if (garnish === 'dark') liveDeck.sweepOutDark(fxT0 + 0.45 * wS, 0.5 * wS, 1200); // gentle fallback darkening
    else if (garnish === 'wash' && !this.echoActive) {                     // or a subtle fallback wash tail
      this.engine.echoBegin(this.live, 0.09, fxT0 + 0.45 * blendS, true);
      this.echoActive = true;
      this.echoDeck = this.live;
    }
    if (plan.echoOut) {
      const delayS = gOut && gOut.bpm > 0 ? Math.min(0.6, 30 / gOut.bpm) : 0.35; // ~eighth note (60/bpm/2)
      this.engine.echoBegin(this.live, delayS, fxT0 + 0.5 * blendS);            // feed the last bars into the delay
      this.echoActive = true;
      this.echoDeck = this.live;
    } else if (plan.washOut) {
      this.engine.echoBegin(this.live, 0.09, fxT0 + 0.4 * blendS, true); // wash mode picks its own delay; lush ambience as it leaves
      this.echoActive = true;
      this.echoDeck = this.live;
    }

    log('mixing', {
      track: this.queue[this.index]?.title ?? '?',
      recipe: plan.name, outEnd: aOut?.endType ?? '?', inStart: aIn?.startType ?? '?',
      fx: [plan.outFilter && 'out-dark', plan.inFilter && 'in-open', plan.echoOut && 'echo', plan.washOut && 'wash',
        plan.tapeStop && 'tape-stop', plan.stutter && 'stutter', plan.riser && 'riser', plan.uplift && 'uplift',
        plan.bloom && 'bloom', garnish && `garnish-${garnish}`].filter(Boolean),
      from: this.live, to: inc, blendS: +blendS.toFixed(1), matched,
      ratio: matchRatio ? +matchRatio.toFixed(3) : null,
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
    // Echo-out: the dry stops, but its captured tail keeps repeating + decaying on the delay bus.
    if (this.echoActive && this.echoDeck) { this.engine.echoRelease(this.echoDeck); this.echoActive = false; this.echoDeck = null; }
    oldDeck.resetEqNow();      // flatten for reuse (cancels any in-flight ramps)
    oldDeck.setFilter(0);      // lowpass open (clears a riser's highpass too)
    oldDeck.setVolume(1);      // clears any stutter gating
    oldDeck.setTempo(1);       // clears a tape-stop (next spawn plays at 1×)

    const liveDeck = this.engine.deck(this.live);
    liveDeck.resetEqNow();     // the ramps brought it to flat; make sure + cancel schedules
    liveDeck.setFilter(0);     // open (clears any in-flight FX sweep)
    this.engine.crossfade(this.live === 'a' ? 0 : 1);

    // The match-glide already eased it back to natural during the blend; make sure it's exact.
    this.clearRestore();
    liveDeck.setTempo(1);

    this.transitioning = false;
    this.emitMixing(false);
    this.emitTrack();
    log('promoted → live', this.live, 'idx', this.index);
    this.preloadNext();
  }

  /** During a beatmatched blend: hold the locked tempo while both songs are prominent, then ease
   *  the incoming back to its NATURAL tempo over the latter part — while the outgoing is fading, so
   *  the pitch change is masked. No exposed post-blend slide, and the new track plays at its own
   *  pitch once it's solo. */
  private startMatchGlide(id: DeckId, fromRatio: number, blendS: number) {
    this.clearRestore();
    if (Math.abs(fromRatio - 1) < 0.001) return;
    const deck = this.engine.deck(id);
    const t0 = Date.now();
    const holdS = AUTO_MATCH_HOLD_FRAC * blendS;
    const glideS = Math.max(0.1, (AUTO_MATCH_GLIDE_END_FRAC - AUTO_MATCH_HOLD_FRAC) * blendS);
    this.restoreTimer = setInterval(() => {
      const el = (Date.now() - t0) / 1000;
      if (el < holdS) return;                              // hold the lock during the prominent overlap
      const p = Math.min(1, (el - holdS) / glideS);
      deck.setTempo(fromRatio + (1 - fromRatio) * p);      // ease to natural as the outgoing fades out
      if (p >= 1) { deck.setTempo(1); this.clearRestore(); }
    }, 80);
  }

  /** The track ended before a blend was ready — advance now (instant via the preloaded deck,
   *  else load on the live deck). */
  private async hardAdvance() {
    if (this.index + 1 >= this.queue.length) { this.stop(); return; }
    this.clearPromote();
    this.clearRestore();
    if (this.echoActive) { this.engine.echoReset(); this.echoActive = false; this.echoDeck = null; }
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
      try {
        await d.load(this.queue[this.index].url);
        d.play();
        this.computeAnalysis(this.live, this.queue[this.index].id);
      } catch (e) {
        // Bad URL / undecodable track → skip it rather than stalling in silence.
        log('hard-advance load FAILED — skipping track', this.index, e);
        void this.hardAdvance(); // advances past it, or stops if it was the last
        return;
      }
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
      this.computeAnalysis(idle, this.queue[nextIdx].id);
    } catch (e) { this.preloadedIdx = -1; log('preload FAILED', nextIdx, e); }
  }

  /** Analyse + cache a loaded deck's beat grid, true audio end, and end/start types (once per track
   *  id). The work is ~100-200ms of synchronous CPU, so it's DEFERRED off the load/render path — it's
   *  not needed until the transition (a whole song away), and this keeps entering Listen mode and
   *  preloading from blocking a frame. */
  private computeAnalysis(id: DeckId, trackId: string) {
    if (!trackId || this.analysis.has(trackId)) return;
    setTimeout(() => {
      if (this.analysis.has(trackId)) return;
      try {
        const a = this.engine.deck(id).analyze();
        if (a) {
          this.analysis.set(trackId, a);
          log('analysis', {
            track: this.queue.find((t) => t.id === trackId)?.title ?? '?',
            dur: +this.engine.deck(id).durationS.toFixed(1),
            endS: +a.endS.toFixed(1), end: a.endType, start: a.startType,
            bpm: a.grid ? +a.grid.bpm.toFixed(1) : null,
            conf: a.grid ? +a.grid.confidence.toFixed(2) : null,
            m: a.dbg, // raw measures (endLow/endCrest/startLoud/startLow/startCrest) for tuning
          });
        }
      } catch (e) { log('analysis FAILED', e); }
    }, 0);
  }

  /** Manual skip — instant hard-cut (no mix). Mid-blend, finish the blend immediately. */
  async skipNext(): Promise<void> {
    this.userActedAt = Date.now();
    if (this.transitioning) { this.clearPromote(); this.promote(); return; }
    if (this.index + 1 >= this.queue.length) { this.stop(); return; }
    await this.hardAdvance();
  }

  /** User scrub of the now-playing track. A core control — always available, never swallowed by the
   *  mix. Marks a user action so an imminent transition won't fight the scrub (see onTick). Ignored
   *  only mid-blend: a ≤~20s morph is in flight and seeking its outgoing deck would fight scheduled
   *  ramps — the scrubber frees up again the instant the blend completes. */
  seek(sec: number): void {
    if (this.transitioning) return;
    this.userActedAt = Date.now();
    const d = this.engine.deck(this.live);
    const dur = d.durationS;
    if (dur <= 0) return;
    d.seek(clampN(sec, 0, Math.max(0, dur - 0.1)));
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
    this.stopTick();
    if (this.transitioning) { this.transitioning = false; this.emitMixing(false); }
    this.engine.a.pause();
    this.engine.b.pause();
    this.resetDecksAndFx(); // clears timers, EQ/filter/tempo/gate, and the echo bus
  }

  /** Live position + duration, for a now-playing scrubber. */
  position(): { pos: number; dur: number } {
    const d = this.engine.deck(this.live);
    return { pos: d.position(), dur: d.durationS };
  }

  private emitTrack() { this.listener.onTrack?.(this.queue[this.index] ?? null, this.index); }
  private emitMixing(m: boolean) { this.listener.onMixing?.(m); }
}
