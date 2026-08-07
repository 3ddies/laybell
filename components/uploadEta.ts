import { useEffect, useRef, useState } from 'react';

// Rolling-window time-remaining estimate for FILM uploads, shared by the
// in-feed pending card and the global upload banner.
//
// A film climbs for tens of minutes, and a bare progress bar with no time
// signal reads as "stuck" — which discourages the exact users Films is for.
// The rate comes from real recent throughput (up to 12 samples / 5 minutes),
// so the estimate self-corrects as the connection changes.
//
// ACCURACY GATE — device testing showed the naive version displaying a small
// number that then GREW, which reads worse than no number at all. Nothing is
// shown until (a) the window spans ≥25s with ≥3 samples and real movement,
// AND (b) two consecutive raw estimates agree within 25% — i.e. the number is
// stable before it is ever visible. Once visible it moves through a smoothing
// average so it drifts calmly instead of twitching with throughput wobble.
export function useUploadEta(progress: number, active: boolean): number | null {
  const samples = useRef<{ t: number; p: number }[]>([]);
  const lastRaw = useRef<number | null>(null);
  const [etaSec, setEtaSec] = useState<number | null>(null);
  useEffect(() => {
    if (!active) { samples.current = []; lastRaw.current = null; setEtaSec(null); return; }
    const now = Date.now();
    const list = samples.current;
    const last = list[list.length - 1];
    // Progress moved BACKWARD → a retry restarted measurement — old samples lie.
    if (last && progress < last.p) { list.length = 0; lastRaw.current = null; }
    if (!list.length || progress > list[list.length - 1].p) list.push({ t: now, p: progress });
    while (list.length > 12 || (list.length > 2 && now - list[0].t > 300_000)) list.shift();
    if (list.length < 3) return;
    const a = list[0];
    const b = list[list.length - 1];
    const dtMs = b.t - a.t;
    const dp = b.p - a.p;
    if (dtMs < 25_000 || dp < 0.002 || b.p >= 1) return;
    const raw = ((1 - b.p) * dtMs) / dp / 1000;
    const prev = lastRaw.current;
    lastRaw.current = raw;
    // Two consecutive estimates must agree before the first reveal; after
    // that, stable readings keep refining the shown value via EMA.
    if (prev != null && Math.abs(raw - prev) / Math.max(raw, prev) < 0.25) {
      setEtaSec((s) => (s == null ? raw : s * 0.65 + raw * 0.35));
    }
  }, [progress, active]);
  return active ? etaSec : null;
}

// ENCODE time-remaining — a different animal from upload progress. Cloudflare's
// pctComplete is NOT linear in wall-clock: it sprints through the early
// renditions and crawls at the tail, so extrapolating it linearly produced
// "About 1 minute" for encodes that took five — and a blown promise reads far
// worse than a longer honest one. This estimator:
//   • starts from a PRIOR — encode time scales with the film's length
//     (~0.5× runtime + fixed tail) — so an expectation shows immediately;
//   • lets measured velocity only make the estimate LONGER, never shorter
//     (max of the two): a slow encode is reported slow, a fast one finishes
//     "early" — the pleasant direction of wrong.
export function useEncodeEta(progress: number, active: boolean, videoDurationSec: number): number | null {
  const samples = useRef<{ t: number; p: number }[]>([]);
  const lastRaw = useRef<number | null>(null);
  const velRef = useRef<number | null>(null);
  // The countdown's anchor: "the encode should finish around THIS timestamp".
  // Estimates re-anchor it; wall-clock drains it.
  const endAtRef = useRef<number | null>(null);
  const [, setBeat] = useState(0);

  // 1-second heartbeat — a countdown must COUNT DOWN. Cloudflare's pct can sit
  // still for minutes (queued, coarse reporting on long files), and a number
  // that only moved with pct froze with it — which reads as a hang even while
  // the encode is working fine. Time drives the display; pct drives the anchor.
  useEffect(() => {
    if (!active) return;
    const iv = setInterval(() => setBeat((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, [active]);

  useEffect(() => {
    if (!active) {
      samples.current = []; lastRaw.current = null; velRef.current = null; endAtRef.current = null;
      return;
    }
    const now = Date.now();
    const list = samples.current;
    const last = list[list.length - 1];
    if (last && progress < last.p) { list.length = 0; lastRaw.current = null; }
    if (!list.length || progress > list[list.length - 1].p) list.push({ t: now, p: progress });
    while (list.length > 12 || (list.length > 2 && now - list[0].t > 300_000)) list.shift();
    if (list.length >= 3) {
      const a = list[0];
      const b = list[list.length - 1];
      const dtMs = b.t - a.t;
      const dp = b.p - a.p;
      if (dtMs >= 20_000 && dp >= 0.002 && b.p < 1) {
        const raw = ((1 - b.p) * dtMs) / dp / 1000;
        const prev = lastRaw.current;
        lastRaw.current = raw;
        if (prev != null && Math.abs(raw - prev) / Math.max(raw, prev) < 0.3) {
          velRef.current = velRef.current == null ? raw : velRef.current * 0.65 + raw * 0.35;
        }
      }
    }
    // Re-anchor from the best current estimate (length prior, lengthened-only
    // by measured velocity). Runs on mount too, so the countdown starts from
    // the prior immediately — before Cloudflare has reported anything.
    const p = Math.min(1, Math.max(0, progress));
    const prior = videoDurationSec > 0 ? videoDurationSec * 0.5 * (1 - p) + 40 : null;
    const vel = velRef.current;
    const est = vel != null && prior != null ? Math.max(vel, prior) : (prior ?? vel);
    if (est != null) endAtRef.current = Date.now() + est * 1000;
  }, [progress, active, videoDurationSec]);

  if (!active || endAtRef.current == null) return null;
  // Drains to 0 in real time between pct reports; the caller's tail logic
  // (<60s → "Almost done…") takes over rather than promising exact minutes.
  return Math.max(0, (endAtRef.current - Date.now()) / 1000);
}

// Whole-unit rounding, and always UP: a countdown that finishes early is a
// pleasant surprise, one that overruns is a broken promise.
export function formatEta(t: (k: string, p?: Record<string, string>) => string, etaSec: number | null): string | null {
  if (etaSec == null) return null;
  if (etaSec < 60) return t('upload.etaUnderMinute');
  if (etaSec < 5400) return t('upload.etaMinutes', { m: String(Math.max(1, Math.ceil(etaSec / 60))) });
  return t('upload.etaHours', { h: String(Math.floor(etaSec / 3600)), m: String(Math.min(59, Math.ceil((etaSec % 3600) / 60))) });
}
