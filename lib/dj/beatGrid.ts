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

  // 2. Onset envelope = positive flux, lightly smoothed, then normalized.
  const onsetRaw = new Float32Array(nFrames);
  for (let f = 1; f < nFrames; f++) { const d = energy[f] - energy[f - 1]; onsetRaw[f] = d > 0 ? d : 0; }
  const onset = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    const a = onsetRaw[f - 1] ?? 0;
    const b = onsetRaw[f];
    const c = onsetRaw[f + 1] ?? 0;
    onset[f] = (a + 2 * b + c) / 4; // tiny triangular smoothing
  }
  let omax = 0;
  for (let f = 0; f < nFrames; f++) if (onset[f] > omax) omax = onset[f];
  if (omax <= 0) return null;
  for (let f = 0; f < nFrames; f++) onset[f] /= omax;

  // 3. Autocorrelation over the BPM lag range.
  const fps = sampleRate / HOP;
  const lagMin = Math.max(1, Math.round((fps * 60) / MAX_BPM));
  const lagMax = Math.round((fps * 60) / MIN_BPM);
  if (lagMax <= lagMin || lagMax >= nFrames) return null;

  const scores = new Float32Array(lagMax + 2);
  let bestLag = -1;
  let bestScore = -1;
  let scoreSum = 0;
  let scoreCnt = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let acc = 0;
    for (let f = lag; f < nFrames; f++) acc += onset[f] * onset[f - lag];
    acc /= (nFrames - lag);
    scores[lag] = acc;
    scoreSum += acc;
    scoreCnt++;
    if (acc > bestScore) { bestScore = acc; bestLag = lag; }
  }
  if (bestLag <= 0) return null;

  // Sub-frame precision via parabolic interpolation around the peak.
  let lag = bestLag;
  if (bestLag > lagMin && bestLag < lagMax) {
    const y0 = scores[bestLag - 1];
    const y1 = scores[bestLag];
    const y2 = scores[bestLag + 1];
    const denom = y0 - 2 * y1 + y2;
    if (denom !== 0) {
      const delta = (0.5 * (y0 - y2)) / denom;
      if (Math.abs(delta) < 1) lag = bestLag + delta;
    }
  }

  const beatPeriodS = lag / fps;
  const bpm = 60 / beatPeriodS;
  const meanScore = scoreCnt > 0 ? scoreSum / scoreCnt : 0;
  const confidence = meanScore > 0 ? clamp((bestScore / meanScore - 1) / 3, 0, 1) : 0;

  // 4. Phase: comb the onset envelope at the beat period; the best offset is the grid origin.
  const periodFrames = Math.max(1, Math.round(lag));
  const stepsAcross = Math.max(1, Math.round(periodFrames / 48));
  let bestPhase = 0;
  let bestPhaseScore = -1;
  for (let p = 0; p < periodFrames; p += stepsAcross) {
    let acc = 0;
    for (let f = p; f < nFrames; f += periodFrames) acc += onset[f];
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

export function analyzeEnding(samples: Float32Array, sampleRate: number): { endS: number; abrupt: boolean } {
  const n = samples?.length ?? 0;
  if (!n || !sampleRate) return { endS: 0, abrupt: false };
  const durS = n / sampleRate;

  const nFrames = Math.floor(n / END_HOP);
  if (nFrames < 8) return { endS: durS, abrupt: false };

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
  if (ref <= 0) return { endS: durS, abrupt: false };

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

  return { endS, abrupt };
}
