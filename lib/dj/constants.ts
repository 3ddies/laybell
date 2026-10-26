// Pure DJ constants + types — NO native import. UI modules use these so they never
// pull in react-native-audio-api (which installs its native bindings at import time and
// throws "failed to install" on a build that predates the native module). ONLY
// lib/dj/DjEngine.ts touches the native library, and it's loaded lazily (app/dj.tsx).
export type EqBand = 'low' | 'mid' | 'high';
export type DeckId = 'a' | 'b';

// Tempo travel: ±8%, the classic pitch-fader range.
export const TEMPO_MIN = 0.92;
export const TEMPO_MAX = 1.08;
