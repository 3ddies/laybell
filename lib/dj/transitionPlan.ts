// ── Auto-DJ transition recipes ───────────────────────────────────────────────
// Picks a transition "recipe" for a specific pair based on how the outgoing song
// ENDS and how the incoming song STARTS (see beatGrid.ts classification). Most
// pairs get 'standard'; the special recipes trigger only on confident, distinctive
// cases (rare ones rarely) — each shaping the morph so the transition is FELT.
//
// A recipe only maps to knobs the engine already consumes — blend length and the
// front-load (how early the outgoing is fully out). The beat-lock + bass-layering
// are decided separately (by tempo compatibility), so they ride on top of any recipe.
// Pure data + a switch; no audio, safe to import anywhere.
import { AUTO_BLEND_BEATS, AUTO_BLEND_DEFAULT_S } from './constants';
import type { EndType, StartType } from './beatGrid';

export type TransitionPlan = {
  name: string;          // for the dev log
  blendBeats: number;    // blend length in beats when beatmatched
  blendDefaultS: number; // blend length in seconds when not
  completeFrac: number;  // front-load: hand-off finishes by this fraction of the blend, then outgoing is silent
};

const STANDARD_COMPLETE_FRAC = 0.8;

/** Choose the recipe for this pair. `matched` = the pair will beat-lock (lets a recipe lean longer). */
export function planTransition(end: EndType, start: StartType, matched: boolean): TransitionPlan {
  // NEVER mush two vocals (owner rule): the outgoing ends on vocals/thin AND the next starts with a
  // vocal/lyric → short, quick handoff so the two vocal lines barely overlap (a cut, not a long blend).
  if (end === 'sparse' && start === 'vocal') {
    return { name: 'vocal-clash (quick)', blendBeats: 8, blendDefaultS: 6, completeFrac: 0.5 };
  }
  // Cold hard stop into a beat drop → a punchy "slam": shorter, the incoming drops in sooner. Still
  // front-loaded enough that the outgoing is clean, not a raw cut.
  if (end === 'cold' && start === 'drop') {
    return { name: 'cold→drop (slam)', blendBeats: 12, blendDefaultS: 8, completeFrac: 0.62 };
  }
  // Ending thin (vocals/ambience) → bring the next track IN UNDER the tail. Long overlap so the new
  // groove establishes while the old vocal finishes. Classic radio move.
  if (end === 'sparse') {
    return { name: 'beat-under-vocal', blendBeats: 28, blendDefaultS: 16, completeFrac: 0.85 };
  }
  // Fade-out outro → don't fight it: a long, gentle blend that lets the outgoing ring through its fade.
  if (end === 'fade') {
    return { name: 'fade-out', blendBeats: 28, blendDefaultS: 16, completeFrac: 0.9 };
  }
  // Soft, building intro on the incoming → start it early and let it build under the outgoing.
  if (start === 'soft') {
    return { name: 'soft-intro', blendBeats: 28, blendDefaultS: 16, completeFrac: 0.85 };
  }
  // A beat/drop intro into a normal ending → keep it a touch tighter so the drop lands with impact.
  if (start === 'drop') {
    return { name: 'drop-align', blendBeats: 20, blendDefaultS: 11, completeFrac: 0.78 };
  }
  // Bread and butter.
  return {
    name: 'standard',
    blendBeats: AUTO_BLEND_BEATS,
    blendDefaultS: AUTO_BLEND_DEFAULT_S,
    completeFrac: STANDARD_COMPLETE_FRAC,
  };
}
