// Pure DJ constants + types — NO native import. UI modules use these so they never
// pull in react-native-audio-api (which installs its native bindings at import time and
// throws "failed to install" on a build that predates the native module). ONLY
// lib/dj/DjEngine.ts touches the native library, and it's loaded lazily (app/dj.tsx).
export type EqBand = 'low' | 'mid' | 'high';
export type DeckId = 'a' | 'b';

// Tempo travel: ±8%, the classic pitch-fader range.
export const TEMPO_MIN = 0.92;
export const TEMPO_MAX = 1.08;

// ── Auto-DJ transition tuning (Listen Mode) ──────────────────────────────────
// These shape the "radio morph". Tune by ear over Metro — no rebuild needed.
export const AUTO_BLEND_BEATS = 24;           // beatmatched blend length, in beats of the OUTGOING track (long = "felt")
export const AUTO_BLEND_DEFAULT_S = 14;       // blend length when we can't read the beat grid
export const AUTO_BLEND_MIN_S = 6;            // never blend shorter than this
export const AUTO_BLEND_MAX_S = 20;           // or longer than this
export const AUTO_MIN_PLAY_S = 10;            // let a track play at least this long before transitioning out
                                              // (clamped to half its duration, so short tracks still mix)
// A transition is an OPPORTUNISTIC garnish, never a core function. It only fires when its run-up is
// untouched: if the user scrubbed or skipped within this window of the trigger, the song just plays
// out to a clean hard-advance instead (the effect gracefully doesn't happen). Keeps user control
// absolute — the mix never fights a scrub/skip. (Owner: "the last 30 seconds leading up … untouched".)
export const AUTO_EFFECT_CLEAR_MS = 30_000;
export const AUTO_BEAT_MIN_CONFIDENCE = 0.18; // below this, skip beatmatch (fall back to EQ blend)
export const AUTO_MAX_STRETCH = 0.08;         // only beatmatch within ±8% tempo change (musical + safe)
// A beatmatched incoming holds the locked tempo for the first part of the blend, then eases back
// to its natural tempo over the latter part — WHILE the outgoing is fading, so the pitch change is
// masked (no exposed post-blend slide) and the new track ends up at its own pitch when solo.
export const AUTO_MATCH_HOLD_FRAC = 0.5;      // hold the lock for this fraction of the blend
export const AUTO_MATCH_GLIDE_END_FRAC = 0.82; // reach natural tempo by this fraction (as the outgoing goes silent)
// How far before the outgoing track's TRUE audio end the blend finishes (so it's
// silent before the stop). Abrupt/cold endings get more headroom than tails.
export const AUTO_END_GUARD_S = 0.4;          // natural/decaying outro
export const AUTO_END_GUARD_ABRUPT_S = 1.0;   // cold stop — outgoing fully out ~1s before the stop
// EQ "duck" the incoming starts at (the blend ramps these up to flat). Shared by
// the controller (pre-duck before play) and the engine (ramp start value).
export const AUTO_MID_DUCK = -0.6;
export const AUTO_HIGH_DUCK = -0.4;
// Beat-LOCKED blends only: the incoming kick starts only mildly tucked (not killed) and layers in
// under the outgoing's sub, so the two locked kicks reinforce ("the drums belong to each other").
export const AUTO_MATCH_BASS_DUCK = -0.35;   // incoming kick's starting tuck
export const AUTO_MATCH_BASS_SHARE = -0.12;  // …and the level it holds UNDER the outgoing anchor during the
                                             // shared window (not full flat → two locked kicks can't double into boom)
