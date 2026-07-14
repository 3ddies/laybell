import { createVideoPlayer, type VideoPlayer } from 'expo-video';

// ── Pooled video players (Home feed + Reels) ────────────────────────────────
// AVPlayer CREATION is heavy enough on-device to freeze a frame. Pools remove
// creation from the picture: players are created ONCE, switching videos is
// player.replaceAsync(source) — async, loaded off the UI thread. This is how
// Instagram-class feeds work, and it makes video assignment safe mid-scroll.
//
// BANDWIDTH RULE (learned on device): an idle player whose source is still
// loaded keeps buffering in the background and STARVES the playing video —
// the "plays ~1 second then freezes" stall. Release therefore UNLOADS the
// source (replaceAsync(null)); re-acquiring reloads (CDN/disk cache softens
// the cost). Never keep more streams loading than the UX needs right now.
//
// Ownership: acquire by post id; when a pool is exhausted the least-recently-
// acquired entry is STOLEN and its previous owner notified (onStolen) so it
// detaches its VideoView.

type Entry = {
  player: VideoPlayer;
  owner: string | null;      // post id currently holding this player
  uri: string | null;        // source currently loaded into it
  seq: number;               // acquisition order — steal the oldest
  onStolen?: () => void;     // previous owner's detach callback
};

export type PlayerPool = {
  acquire: (
    ownerId: string,
    uri: string,
    opts: { loop: boolean; muted: boolean; timeUpdateSec: number },
    onStolen: () => void,
  ) => { player: VideoPlayer; alreadyLoaded: boolean };
  release: (ownerId: string, player: VideoPlayer) => void;
};

function makePool(size: number): PlayerPool {
  let entries: Entry[] | null = null;
  let seqCounter = 0;

  function ensure(): Entry[] {
    if (!entries) {
      entries = Array.from({ length: size }, () => {
        const player = createVideoPlayer(null);
        player.timeUpdateEventInterval = 0;
        return { player, owner: null, uri: null, seq: 0 };
      });
    }
    return entries;
  }

  return {
    acquire(ownerId, uri, opts, onStolen) {
      const pool = ensure();
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
        // Same source still loaded (steal-then-return race or remount): reveal
        // immediately if it's already ready.
        return { player: p, alreadyLoaded: p.status === 'readyToPlay' };
      } catch {
        return { player: p, alreadyLoaded: false };
      }
    },
    release(ownerId, player) {
      const pool = ensure();
      const e = pool.find((x) => x.player === player);
      if (!e || e.owner !== ownerId) return; // already stolen — new owner manages it
      e.owner = null;
      e.onStolen = undefined;
      e.uri = null;
      try { player.pause(); } catch {}
      // Unload — see the bandwidth rule above.
      try { player.replaceAsync(null).catch(() => {}); } catch {}
    },
  };
}

// Separate pools per surface so reels can never steal the feed's players (the
// feed stays mounted under the reels modal) and vice versa.
const feedPool = makePool(3);
export const acquireFeedPlayer = feedPool.acquire;
export const releaseFeedPlayer = feedPool.release;

export const reelPool = makePool(3);
