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

// ── One honest bar ────────────────────────────────────────────────────────────
// A film passes through three stages — prepare (on-device compress), upload,
// then Cloudflare's encode — and each one used to drive the bar from 0% to
// 100% on its own. Three consecutive full sweeps read as "it keeps starting
// over", which is the single most demoralising thing a long upload can do.
//
// These weights turn the three stages into ONE monotonic climb. They are rough
// shares of wall-clock for a typical film (compressing is real work, the upload
// is the longest leg, the server encode is the shortest), and being approximate
// is fine — what matters is that the bar only ever moves forward and that its
// position means "how much of the whole job is done".
const W_PREPARE = 0.30;
const W_UPLOAD = 0.50;
const W_PROCESS = 0.20;

// The stage boundaries, so a smoother can creep WITHIN a stage without ever
// crossing into territory the next stage owns.
export function stageBounds(
  phase: 'preparing' | 'uploading' | 'processing' | 'done' | 'error',
): { from: number; to: number } {
  switch (phase) {
    case 'preparing': return { from: 0, to: W_PREPARE };
    case 'uploading': return { from: W_PREPARE, to: W_PREPARE + W_UPLOAD };
    case 'processing': return { from: W_PREPARE + W_UPLOAD, to: 1 };
    case 'done': return { from: 1, to: 1 };
    default: return { from: W_PREPARE, to: W_PREPARE + W_UPLOAD };
  }
}

/**
 * A bar that always moves, and never jumps.
 *
 * Real progress arrives unevenly: a stage can report nothing for minutes and
 * then land a whole step at once, which on screen is a bar frozen at a stage
 * boundary followed by a leap — the exact "stuck at 30%, jumps to 80%" that
 * makes a working upload feel broken. Two corrections:
 *
 *   • EASE toward whatever truth we have, so a big correction glides instead
 *     of teleporting.
 *   • TRICKLE while truth is silent — creep slowly toward the current stage's
 *     end, decelerating as it approaches so it never arrives early and never
 *     implies the stage is finished.
 *
 * It is monotonic by construction: the returned value never decreases, because
 * a bar that goes backwards destroys trust faster than one that stalls.
 */
export function useSmoothProgress(target: number, phase: 'preparing' | 'uploading' | 'processing' | 'done' | 'error'): number {
  const [shown, setShown] = useState(0);
  const shownRef = useRef(0);
  const targetRef = useRef(target);
  targetRef.current = target;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // The ticker only exists while there is something to animate. This component
  // lives INSIDE the home feed, so a timer that kept firing after an upload
  // settled would re-render the feed several times a second for nothing.
  const active = phase !== 'done' && phase !== 'error';
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      const t = targetRef.current;
      const { to } = stageBounds(phaseRef.current);
      let next = shownRef.current;
      if (t > next) {
        // Ease 18% of the remaining gap per tick — fast enough to feel
        // responsive, slow enough that a leap reads as motion.
        next = next + (t - next) * 0.18;
      } else if (phaseRef.current !== 'done' && phaseRef.current !== 'error') {
        // No news. Creep toward — but never reach — the stage ceiling, easing
        // off as the gap closes so it visibly decelerates rather than stalling.
        const room = Math.max(0, to - 0.02 - next);
        if (room > 0.001) next = next + room * 0.012;
      }
      if (phaseRef.current === 'done') next = 1;
      // Only re-render on a change big enough to SEE. Sub-pixel updates would
      // otherwise churn the feed four times a second for nothing.
      if (next - shownRef.current > 0.002) {
        shownRef.current = next;
        setShown(next);
      }
    }, 300);
    return () => clearInterval(id);
  }, [active]);

  return Math.min(1, shown);
}

/** 0..1 across the WHOLE publish, not the current stage. */
export function overallProgress(
  phase: 'preparing' | 'uploading' | 'processing' | 'done' | 'error',
  stageProgress: number,
  processingPct?: number,
): number {
  const p = Math.min(1, Math.max(0, stageProgress || 0));
  switch (phase) {
    case 'preparing': return W_PREPARE * p;
    case 'uploading': return W_PREPARE + W_UPLOAD * p;
    case 'processing': return W_PREPARE + W_UPLOAD + W_PROCESS * Math.min(1, (processingPct ?? 0) / 100);
    case 'done': return 1;
    default: return W_PREPARE + W_UPLOAD * p;
  }
}

// Whole-unit rounding, and always UP: a countdown that finishes early is a
// pleasant surprise, one that overruns is a broken promise.
export function formatEta(t: (k: string, p?: Record<string, string>) => string, etaSec: number | null): string | null {
  if (etaSec == null) return null;
  if (etaSec < 60) return t('upload.etaUnderMinute');
  if (etaSec < 5400) return t('upload.etaMinutes', { m: String(Math.max(1, Math.ceil(etaSec / 60))) });
  return t('upload.etaHours', { h: String(Math.floor(etaSec / 3600)), m: String(Math.min(59, Math.ceil((etaSec % 3600) / 60))) });
}
