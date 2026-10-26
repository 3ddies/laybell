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
export const AUTO_BLEND_BEATS = 16;           // beatmatched blend length, in beats of the OUTGOING track
export const AUTO_BLEND_DEFAULT_S = 12;       // blend length when we can't read the beat grid
export const AUTO_BLEND_MIN_S = 5;            // never blend shorter than this
export const AUTO_BLEND_MAX_S = 16;           // or longer than this
export const AUTO_BEAT_MIN_CONFIDENCE = 0.18; // below this, skip beatmatch (fall back to EQ blend)
export const AUTO_MAX_STRETCH = 0.06;         // only beatmatch within ±6% tempo change (musical + safe)
export const AUTO_POST_RESTORE_S = 4;         // after the blend, ease the new track back to its natural tempo over this
// EQ "duck" the incoming starts at (the blend ramps these up to flat). Shared by
// the controller (pre-duck before play) and the engine (ramp start value).
export const AUTO_MID_DUCK = -0.6;
export const AUTO_HIGH_DUCK = -0.4;
