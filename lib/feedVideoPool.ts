import { createVideoPlayer, type VideoPlayer } from 'expo-video';

// ── Pooled video players for the Home feed ───────────────────────────────────
// AVPlayer CREATION is heavy enough on-device to freeze a frame, which forced
// the feed's "players only at rest, behind a poster" rule — and with it, a
// visible start delay. This pool removes creation from the picture entirely:
// POOL_SIZE players are created ONCE (first feed use), and switching videos is
// player.replaceAsync(source) — async, loaded off the UI thread ("avoid UI
// lags", expo-video docs). Instagram-class feeds work exactly this way, and it
// makes video assignment safe DURING scrolling again → starts feel instant.
//
// Ownership model: a FeedVideo component acquires by post id. When the pool is
// exhausted the least-recently-acquired entry is STOLEN — its previous owner
// is notified (onStolen) so it detaches its VideoView. Release keeps the
// source loaded (a back-scroll to the same post re-acquires instantly).

const POOL_SIZE = 3;

type Entry = {
  player: VideoPlayer;
  owner: string | null;      // post id currently holding this player
  uri: string | null;        // source currently loaded into it
  seq: number;               // acquisition order — steal the oldest
  onStolen?: () => void;     // previous owner's detach callback
};

let entries: Entry[] | null = null;
let seqCounter = 0;

function ensurePool(): Entry[] {
  if (!entries) {
    entries = Array.from({ length: POOL_SIZE }, () => {
      const player = createVideoPlayer(null);
      player.timeUpdateEventInterval = 0;
      return { player, owner: null, uri: null, seq: 0 };
    });
  }
  return entries;
}

export function acquireFeedPlayer(
  ownerId: string,
  uri: string,
  opts: { loop: boolean; muted: boolean; timeUpdateSec: number },
  onStolen: () => void,
): { player: VideoPlayer; alreadyLoaded: boolean } {
  const pool = ensurePool();
  const entry =
    pool.find((e) => e.owner === ownerId) ??
    pool.find((e) => e.owner === null) ??
    pool.reduce((a, b) => (a.seq <= b.seq ? a : b));
  if (entry.owner && entry.owner !== ownerId) entry.onStolen?.();
  entry.onStolen = onStolen;
  entry.owner = ownerId;
  entry.seq = ++seqCounter;
  const p = entry.player;
  try {
    p.loop = opts.loop;
    p.muted = opts.muted;
    p.timeUpdateEventInterval = opts.timeUpdateSec;
    if (entry.uri !== uri) {
      try { p.pause(); } catch {}
      entry.uri = uri;
      p.replaceAsync({ uri }).catch(() => {});
      return { player: p, alreadyLoaded: false };
    }
    // Same source still loaded (re-acquired after a back-scroll / remount):
    // no reload — the caller can reveal immediately if it's already ready.
    return { player: p, alreadyLoaded: p.status === 'readyToPlay' };
  } catch {
    return { player: p, alreadyLoaded: false };
  }
}

export function releaseFeedPlayer(ownerId: string, player: VideoPlayer): void {
  const pool = ensurePool();
  const e = pool.find((x) => x.player === player);
  if (!e || e.owner !== ownerId) return; // already stolen — new owner manages it
  e.owner = null;
  e.onStolen = undefined;
  try { player.pause(); } catch {}
  // Deliberately KEEP the source loaded — scrolling back re-acquires instantly;
  // the next steal's replaceAsync unloads it anyway.
}
