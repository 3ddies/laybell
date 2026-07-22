import { useEffect, useState } from 'react';
import { fetchLiveStreams } from './live';

// ── Who is LIVE right now (shared, cheap) ────────────────────────────────────
// One module-level poll serves every avatar on screen: while at least one
// component subscribes (via useLiveStreamId), the active-streams list refreshes
// every POLL_MS and keeps a userId → streamId map. Subscribers re-render ONLY
// when live membership actually changes, so hundreds of mounted avatars cost
// one query per interval and zero renders while nothing changes.
//
// fetchLiveStreams already drops heartbeat-stale ghosts, so a crashed
// broadcaster's badge disappears on the next poll.

const POLL_MS = 45_000;

let liveByUser = new Map<string, string>(); // userId → streamId
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let fetching = false;

async function refresh() {
  if (fetching) return;
  fetching = true;
  try {
    const streams = await fetchLiveStreams();
    const next = new Map<string, string>();
    for (const s of streams) if (s.user_id && s.id) next.set(s.user_id, s.id);
    let changed = next.size !== liveByUser.size;
    if (!changed) {
      for (const [u, sid] of next) {
        if (liveByUser.get(u) !== sid) { changed = true; break; }
      }
    }
    liveByUser = next;
    if (changed) listeners.forEach((l) => l());
  } catch { /* offline / pre-migration — keep the last known set */ }
  fetching = false;
}

function ensurePolling() {
  if (timer) return;
  refresh();
  timer = setInterval(refresh, POLL_MS);
}

function stopIfIdle() {
  if (listeners.size === 0 && timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Non-reactive read (for handlers). */
export function liveStreamIdFor(userId?: string | null): string | null {
  return userId ? liveByUser.get(userId) ?? null : null;
}

/**
 * The user's active livestream id, or null — live-updating. Mount-cheap:
 * subscribes to the shared poll; all subscribers share one request cycle.
 */
export function useLiveStreamId(userId?: string | null): string | null {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    ensurePolling();
    return () => { listeners.delete(l); stopIfIdle(); };
  }, []);
  return liveStreamIdFor(userId);
}
