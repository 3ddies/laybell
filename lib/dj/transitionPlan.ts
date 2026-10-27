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
  outFilter?: boolean;   // FX: lowpass-sweep the OUTGOING dark as it leaves (sinks into the distance)
  inFilter?: boolean;    // FX: lowpass-sweep the INCOMING open as it arrives (a filter-up build)
  echoOut?: boolean;     // FX: echo/delay tail on the OUTGOING — its last bars repeat & decay out
  washOut?: boolean;     // FX: subtle reverb-wash ambience on the OUTGOING as it leaves
  tapeStop?: boolean;    // FX: tape-stop (spin-down) the OUTGOING into the drop
  stutter?: boolean;     // FX: beat-stutter the OUTGOING's last beat (beat-locked drops)
  riser?: boolean;       // FX: highpass riser on the OUTGOING, building into the drop
};

const STANDARD_COMPLETE_FRAC = 0.8;

/** Choose the recipe for this pair. `matched` = the pair will beat-lock (lets a recipe lean longer). */
export function planTransition(end: EndType, start: StartType, matched: boolean): TransitionPlan {
  // NEVER mush two vocals (owner rule): the outgoing ends on vocals/thin AND the next starts with a
  // vocal/lyric → short, quick handoff so the two vocal lines barely overlap (a cut, not a long blend).
  if (end === 'sparse' && start === 'vocal') {
    return { name: 'vocal-clash (quick)', blendBeats: 8, blendDefaultS: 6, completeFrac: 0.5 };
  }
  // Cold hard stop into a beat drop → a punchy "slam" with a TAPE-STOP: the outgoing spins down and
  // the incoming drops in. Iconic.
  if (end === 'cold' && start === 'drop') {
    return { name: 'tape-drop', blendBeats: 12, blendDefaultS: 8, completeFrac: 0.62, tapeStop: true };
  }
  // Cold ending into anything that isn't a drop or a soft build → echo the last bars OUT (delay tail
  // repeats + decays) while the next one comes in. A produced, distinctive exit.
  if (end === 'cold' && start !== 'soft') {
    return { name: 'cold-echo', blendBeats: 16, blendDefaultS: 11, completeFrac: 0.72, echoOut: true };
  }
  // Ending thin (vocals/ambience) → bring the next track IN UNDER the tail. Long overlap so the new
  // groove establishes while the old vocal finishes, washed in ambience. Classic radio move.
  if (end === 'sparse') {
    return { name: 'beat-under-vocal', blendBeats: 28, blendDefaultS: 16, completeFrac: 0.85, washOut: true };
  }
  // Fade-out outro → don't fight it: a long, gentle blend; sweep the outgoing DARK and wash it in
  // ambience as it fades, so it sinks into the distance (a produced exit).
  if (end === 'fade') {
    return { name: 'fade-out', blendBeats: 28, blendDefaultS: 16, completeFrac: 0.9, outFilter: true, washOut: true };
  }
  // Soft, building intro on the incoming → start it early, let it build under the outgoing, and open
  // it up through a lowpass (a filter-up build into full).
  if (start === 'soft') {
    return { name: 'soft-intro', blendBeats: 28, blendDefaultS: 16, completeFrac: 0.85, inFilter: true };
  }
  // A beat/drop intro into a normal ending → make the drop LAND. Beat-locked pairs get a tight
  // beat-stutter on the outgoing's last beat; otherwise a highpass riser builds the tension.
  if (start === 'drop') {
    return matched
      ? { name: 'drop-stutter', blendBeats: 16, blendDefaultS: 11, completeFrac: 0.7, stutter: true }
      : { name: 'drop-riser', blendBeats: 20, blendDefaultS: 12, completeFrac: 0.78, riser: true };
  }
  // Bread and butter.
  return {
    name: 'standard',
    blendBeats: AUTO_BLEND_BEATS,
    blendDefaultS: AUTO_BLEND_DEFAULT_S,
    completeFrac: STANDARD_COMPLETE_FRAC,
  };
}
