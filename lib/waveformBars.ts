// Synthetic waveform bars, 0..1 each, deterministic from a seed — a given song
// draws the same way every time, on every device. Nothing in this app stores real
// audio peaks (components/ImmersivePlayer.tsx explains why), so these read as a
// waveform without describing the audio. Shared by the immersive player's
// scrubber and the video studio's song strip (components/SoundControls).
//
// Not cryptographic and does not need to be: it needs to be STABLE.
export function barsFor(seed: string, count: number): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h |= 0;
    const r = Math.abs(h % 1000) / 1000;
    // Bias toward the middle of the range and add a slow swell across the track,
    // so it reads as music rather than as noise: real waveforms have shape.
    const swell = 0.55 + 0.45 * Math.sin((i / count) * Math.PI * 2.3);
    out.push(0.22 + 0.78 * (0.35 * r + 0.65 * swell) * (0.6 + 0.4 * r));
  }
  return out;
}
