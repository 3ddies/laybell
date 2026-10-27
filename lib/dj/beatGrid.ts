// ── Offline beat/tempo analysis for Auto-DJ ───────────────────────────────────
// Pure JS (no native import) so it's safe to load anywhere. Given a track's mono
// PCM samples it estimates BPM + where the beats sit (the beat grid), which the
// Auto-DJ controller uses to tempo-match and phase-lock one song into the next.
//
// Method (a compact beat tracker):
//   1. Frame the signal and take short-time energy.
//   2. Onset envelope = half-wave-rectified energy flux (rises on hits).
//   3. Autocorrelate the onset envelope; the strongest lag in the musical BPM
//      range is the beat period (parabolic-interpolated for sub-frame precision).
//   4. Phase = the beat offset (a comb over the onset envelope at that period).
// It won't be perfect for every genre, so it also returns a confidence the caller
// gates on — a low-confidence read falls back to a plain EQ blend, never a wrong
// beatmatch (which sounds worse than none).

export type BeatGrid = {
  bpm: number;
  beatPeriodS: number;   // 60 / bpm
  firstBeatS: number;    // seconds to the first strong beat (the grid origin)
  confidence: number;    // 0..1
};

const MIN_BPM = 70;
const MAX_BPM = 180;
const HOP = 256;              // samples per analysis frame
const MAX_ANALYSIS_S = 90;    // BPM is stable — cap cost on long tracks
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function analyzeBeatGrid(samples: Float32Array, sampleRate: number): BeatGrid | null {
  if (!samples || !sampleRate || sampleRate < 8000) return null;
  // Cap the window — the first ~90s is plenty to lock tempo.
  const maxLen = Math.min(samples.length, Math.floor(sampleRate * MAX_ANALYSIS_S));
  if (maxLen < sampleRate * 2) return null; // need at least ~2s

  const nFrames = Math.floor(maxLen / HOP);
  if (nFrames < 32) return null;

  // 1. Short-time energy per frame.
  const energy = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    const s = f * HOP;
    const e = s + HOP;
    let sum = 0;
    for (let i = s; i < e; i++) { const v = samples[i]; sum += v * v; }
    energy[f] = sum / HOP;
  }

  // 2. Onset envelope = half-wave-rectified LOG-energy flux (log compresses dynamics so beats
  //    register in quiet and loud passages alike), lightly smoothed.
  const env = new Float32Array(nFrames);
  {
    const flux = new Float32Array(nFrames);
    for (let f = 1; f < nFrames; f++) {
      const d = Math.log(1 + 1e3 * energy[f]) - Math.log(1 + 1e3 * energy[f - 1]);
      flux[f] = d > 0 ? d : 0;
    }
    for (let f = 0; f < nFrames; f++) {
      const a = f > 0 ? flux[f - 1] : 0;
      const c = f < nFrames - 1 ? flux[f + 1] : 0;
      env[f] = (a + 2 * flux[f] + c) / 4;
    }
  }

  // 3. Mean-subtract so the autocorrelation reflects PERIODICITY, not the envelope's DC
  //    offset — an all-positive envelope otherwise gives a near-flat autocorrelation and
  //    uselessly low confidence (the original bug: conf read ~0.03 on real beats).
  let mean = 0;
  for (let f = 0; f < nFrames; f++) mean += env[f];
  mean /= nFrames;
  const dev = new Float32Array(nFrames);
  let var0 = 0;
  for (let f = 0; f < nFrames; f++) { const d = env[f] - mean; dev[f] = d; var0 += d * d; }
  if (var0 <= 0) return null;

  // 4. Biased normalized autocorrelation over the BPM lag range (coefficients in [-1,1]).
  const fps = sampleRate / HOP;
  const lagMin = Math.max(1, Math.round((fps * 60) / MAX_BPM));
  const lagMax = Math.round((fps * 60) / MIN_BPM);
  if (lagMax <= lagMin || lagMax >= nFrames) return null;

  const ac = new Float32Array(lagMax + 1);
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let acc = 0;
    for (let f = lag; f < nFrames; f++) acc += dev[f] * dev[f - lag];
    ac[lag] = acc / var0;
  }

  // Harmonic enhancement: a true beat period also correlates at 2×/3× the lag — add those so
  // the fundamental wins over a half-tempo pick.
  let bestLag = -1;
  let bestScore = -Infinity;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let e = ac[lag];
    if (2 * lag <= lagMax) e += 0.5 * ac[2 * lag];
    if (3 * lag <= lagMax) e += 0.33 * ac[3 * lag];
    if (e > bestScore) { bestScore = e; bestLag = lag; }
  }
  if (bestLag <= 0) return null;

  // Sub-frame precision via parabolic interpolation on the raw autocorrelation.
  let lag = bestLag;
  if (bestLag > lagMin && bestLag < lagMax) {
    const y0 = ac[bestLag - 1];
    const y1 = ac[bestLag];
    const y2 = ac[bestLag + 1];
    const denom = y0 - 2 * y1 + y2;
    if (denom !== 0) {
      const delta = (0.5 * (y0 - y2)) / denom;
      if (Math.abs(delta) < 1) lag = bestLag + delta;
    }
  }

  const beatPeriodS = lag / fps;
  const bpm = 60 / beatPeriodS;
  const confidence = clamp(ac[bestLag], 0, 1); // normalized autocorrelation at the beat period

  // 5. Phase: comb the onset envelope at the beat period; the best offset is the grid origin.
  const periodFrames = Math.max(1, Math.round(lag));
  const stepsAcross = Math.max(1, Math.round(periodFrames / 48));
  let bestPhase = 0;
  let bestPhaseScore = -1;
  for (let p = 0; p < periodFrames; p += stepsAcross) {
    let acc = 0;
    for (let f = p; f < nFrames; f += periodFrames) acc += env[f];
    if (acc > bestPhaseScore) { bestPhaseScore = acc; bestPhase = p; }
  }
  const firstBeatS = bestPhase / fps;

  return { bpm, beatPeriodS, firstBeatS, confidence };
}

// ── Song ending analysis ─────────────────────────────────────────────────────
// Where a track's MUSIC truly ends — the last moment it's actually loud — not just
// where digital silence begins. Many tracks keep a quiet reverb/ambience tail above
// a silence floor after the loud part has already cold-stopped; anchoring the blend
// to that tail lets the loud part snap off mid-fade. So we detect the end by ENERGY
// relative to the track's own loudness, which trims both silence and quiet tails and
// lands on a cold stop. `abrupt` = still loud right at that end (needs more fade
// headroom to mask the cut) vs. a decaying outro.
const END_HOP = 1024;
const END_LOUD_PERCENTILE = 0.75;  // "typical loud" reference = this percentile of frame energy
const END_PRESENT_FRACTION = 0.18; // music is "present" above this fraction of the loud reference (energy
                                   // ≈ 42% amplitude) — ends on the LOUD part, trimming quieter tails
const END_ABRUPT_FRACTION = 0.5;   // still this loud just before the end (energy) = abrupt/cold stop
const END_ABRUPT_WINDOW_S = 0.3;

// How a track ENDS / STARTS — drives the per-pair transition recipe (see transitionPlan.ts).
export type EndType = 'cold' | 'fade' | 'sparse' | 'standard';
//   cold   = loud right up to a hard stop (abrupt)
//   fade   = energy decays to the end (fade-out outro)
//   sparse = ends thin — little bass/drums, e.g. vocals or ambience only
//   standard = none of the above
export type StartType = 'drop' | 'vocal' | 'soft' | 'standard';
//   drop  = comes in loud and bass-heavy from the top (a beat/drop)
//   vocal = present but thin from the top (a vocal/yell, no beat yet)
//   soft  = quiet intro that builds
//   standard = none of the above

// Fraction of a region's energy that sits below ~200Hz (a one-pole low-pass). High = bass/drums
// present; low = thin/vocal. Cheap, mono, one pass. Used to tell a beat from a vocal.
function lowFraction(samples: Float32Array, s: number, e: number, sampleRate: number): number {
  const a = (1 / sampleRate) / (1 / (2 * Math.PI * 200) + 1 / sampleRate);
  let y = 0;
  let low = 0;
  let tot = 0;
  const end = Math.min(e, samples.length);
  for (let i = Math.max(0, s); i < end; i++) { const x = samples[i]; y += a * (x - y); low += y * y; tot += x * x; }
  return tot > 0 ? low / tot : 0;
}

// "Percussiveness" of a region = crest of its energy-flux (peak ÷ mean positive flux). Drums/beats
// are spiky (sharp onsets → HIGH crest); sustained vocals/pads are smooth (LOW crest). This is what
// lets us tell a beat intro from a vocal/lyrical intro — the key to not mushing two vocals.
function percussiveness(samples: Float32Array, s: number, e: number, sampleRate: number): number {
  const H = 512;
  const start = Math.max(0, s);
  const end = Math.min(e, samples.length);
  const nF = Math.floor((end - start) / H);
  if (nF < 4) return 0;
  let prev = 0;
  let fluxSum = 0;
  let fluxMax = 0;
  let cnt = 0;
  for (let f = 0; f < nF; f++) {
    const b = start + f * H;
    let en = 0;
    for (let i = b; i < b + H; i++) { const v = samples[i]; en += v * v; }
    en /= H;
    if (f > 0) { const flux = en > prev ? en - prev : 0; fluxSum += flux; if (flux > fluxMax) fluxMax = flux; cnt++; }
    prev = en;
  }
  const mean = cnt ? fluxSum / cnt : 0;
  return mean > 0 ? fluxMax / mean : 0;
}

const SPARSE_LOW_FRACTION = 0.45;  // outro low-fraction below this (with low crest) = vocal/thin ending
const FADE_DECAY_RATIO = 0.45;     // tail's late energy below this × its early energy = a fade
const VOCAL_CREST_MAX = 3.2;       // crest below this = sustained (vocal/pad), not percussive
const BEAT_CREST_MIN = 4.5;        // crest above this = percussive (drums/beat)

export function analyzeEnding(samples: Float32Array, sampleRate: number):
  { endS: number; abrupt: boolean; endType: EndType; outroLow: number; outroCrest: number } {
  const n = samples?.length ?? 0;
  if (!n || !sampleRate) return { endS: 0, abrupt: false, endType: 'standard', outroLow: 0, outroCrest: 0 };
  const durS = n / sampleRate;

  const nFrames = Math.floor(n / END_HOP);
  if (nFrames < 8) return { endS: durS, abrupt: false, endType: 'standard', outroLow: 0, outroCrest: 0 };

  // Frame energy over the WHOLE track (the end can be anywhere).
  const energy = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    const s = f * END_HOP;
    const e = s + END_HOP;
    let sum = 0;
    for (let i = s; i < e; i++) { const v = samples[i]; sum += v * v; }
    energy[f] = sum / END_HOP;
  }

  // Robust "typical loud" reference = a high percentile of frame energy.
  const sorted = Float32Array.from(energy);
  sorted.sort();
  const ref = sorted[Math.min(nFrames - 1, Math.floor(nFrames * END_LOUD_PERCENTILE))] || sorted[nFrames - 1] || 0;
  if (ref <= 0) return { endS: durS, abrupt: false, endType: 'standard', outroLow: 0, outroCrest: 0 };

  // Last frame where music is still present (energy above a fraction of the loud ref).
  const presentThresh = ref * END_PRESENT_FRACTION;
  let endFrame = nFrames - 1;
  for (let f = nFrames - 1; f >= 0; f--) { if (energy[f] >= presentThresh) { endFrame = f; break; } }
  const endS = Math.min(durS, ((endFrame + 1) * END_HOP) / sampleRate);

  // Abrupt if it's still loud in the last ~0.3s before that end (cold stop, no taper).
  const abruptThresh = ref * END_ABRUPT_FRACTION;
  const look = Math.max(1, Math.round((END_ABRUPT_WINDOW_S * sampleRate) / END_HOP));
  let abrupt = false;
  for (let f = Math.max(0, endFrame - look); f <= endFrame; f++) { if (energy[f] >= abruptThresh) { abrupt = true; break; } }

  // Classify the ending. Measure the OUTRO the blend will overlap — skip the last ~1s so a final
  // drum-jingle/tail can't mask a lyrical outro before it (the Laybell→Spike Lee mush case).
  const fps = sampleRate / END_HOP;
  const endSample = (endFrame + 1) * END_HOP;
  const outroA = Math.max(0, endSample - Math.floor(9 * sampleRate));
  const outroB = Math.max(outroA + 1, endSample - Math.floor(1 * sampleRate));
  const outroLow = lowFraction(samples, outroA, outroB, sampleRate);
  const outroCrest = percussiveness(samples, outroA, outroB, sampleRate);

  // Energy trend across the last ~5s before the end: a big decline = a fade.
  const win = Math.round(5 * fps);
  const e0 = Math.max(0, endFrame - win);
  const midF = Math.floor((e0 + endFrame) / 2);
  let earlyE = 0; let earlyN = 0; let lateE = 0; let lateN = 0;
  for (let f = e0; f <= endFrame; f++) { if (f < midF) { earlyE += energy[f]; earlyN++; } else { lateE += energy[f]; lateN++; } }
  earlyE = earlyN ? earlyE / earlyN : 0;
  lateE = lateN ? lateE / lateN : 0;
  const decays = earlyE > 0 && lateE < FADE_DECAY_RATIO * earlyE;

  let endType: EndType;
  if (abrupt) endType = 'cold';
  else if (outroCrest < VOCAL_CREST_MAX && outroLow < SPARSE_LOW_FRACTION) endType = 'sparse'; // sustained + mid-dominant = vocal/thin
  else if (decays) endType = 'fade';
  else endType = 'standard';

  return { endS, abrupt, endType, outroLow: +outroLow.toFixed(3), outroCrest: +outroCrest.toFixed(1) };
}

// How a track STARTS, from its first few seconds. Conservative — defaults to 'standard' unless
// a type is clear. See StartType.
const START_HOP = 1024;
export function analyzeStart(samples: Float32Array, sampleRate: number):
  { startType: StartType; loud: number; low: number; crest: number } {
  const n = samples?.length ?? 0;
  const none = { startType: 'standard' as StartType, loud: 0, low: 0, crest: 0 };
  if (!n || !sampleRate) return none;

  // Reference loudness = loudest frame in the first ~20s.
  const refLen = Math.min(n, 20 * sampleRate);
  let maxFrameE = 0;
  for (let s = 0; s + START_HOP <= refLen; s += START_HOP) {
    let e = 0;
    for (let i = s; i < s + START_HOP; i++) { const v = samples[i]; e += v * v; }
    e /= START_HOP;
    if (e > maxFrameE) maxFrameE = e;
  }
  if (maxFrameE <= 0) return none;

  // Mean energy of the first ~1s (how loud the top is), low-band fraction + percussiveness of the top.
  const first1 = Math.min(n, sampleRate);
  let e1 = 0;
  for (let i = 0; i < first1; i++) { const v = samples[i]; e1 += v * v; }
  e1 /= first1;
  const loud = e1 / maxFrameE;
  const low = lowFraction(samples, 0, Math.min(n, 2 * sampleRate), sampleRate);
  const crest = percussiveness(samples, 0, Math.min(n, 3 * sampleRate), sampleRate);

  let startType: StartType;
  if (loud < 0.12) startType = 'soft';                                        // quiet intro that builds
  else if (loud > 0.3 && (crest > BEAT_CREST_MIN || low > 0.3)) startType = 'drop';   // percussive/bassy = a beat/drop
  else if (loud > 0.18 && crest < VOCAL_CREST_MAX && low < 0.3) startType = 'vocal';  // present + sustained + thin = a vocal/lyric intro
  else startType = 'standard';

  return { startType, loud: +loud.toFixed(2), low: +low.toFixed(2), crest: +crest.toFixed(1) };
}
