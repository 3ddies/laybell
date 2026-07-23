import { createVideoPlayer, type VideoPlayer } from 'expo-video';

// ── Pooled video players (Home feed + Reels) ────────────────────────────────
// AVPlayer CREATION is heavy enough on-device to freeze a frame. Pools remove
// creation: players are created ONCE, switching videos is replaceAsync —
// async, loaded off the UI thread. Instagram-class feeds work this way.
//
// HARD-LEARNED RULES (each from an on-device regression):
// 1. NEVER steal the player of the video the user is WATCHING. The playing
//    card is always the oldest acquisition, so naive LRU stealing froze every
//    playing video the moment feed video density rose ("top 2 play fine, all
//    below freeze"). Each pool protects one owner from stealing.
// 2. NEVER unload (replaceAsync(null)) on release — item disposal stalls the
//    main thread, and releases happen right after landings (the reels
//    "freezes at the snap, stops after a split second"). Release = pause
//    only; disposal happens lazily when an entry is reused, or via
//    unloadIdle() at moments when nothing is on screen (feed blur).
// 3. Keep the number of LIVE streams minimal (visible + one next) — idle
//    loaded players still background-buffer and starve the playing video.

type Entry = {
  player: VideoPlayer;
  owner: string | null;      // post id currently holding this player
  uri: string | null;        // source currently loaded into it
  seq: number;               // acquisition order — steal the oldest stealable
  onStolen?: () => void;     // previous owner's detach callback
  loading?: boolean;         // replaceAsync in flight — old item may still report readyToPlay
  loadPromise?: Promise<void>; // resolves when `uri` has finished loading into the player
};

// alreadyLoaded = this exact source is already loaded and ready (instant reveal).
// loadPromise (present only when a load is in flight) resolves once THIS source
// is loaded — the caller waits on it before showing its surface, so it never
// paints the frame the pooled player was still holding from its PREVIOUS post.
export type PoolAcquisition = { player: VideoPlayer; alreadyLoaded: boolean; loadPromise?: Promise<void> };

export type PlayerPool = {
  acquire: (
    ownerId: string,
    uri: string,
    opts: { loop: boolean; muted: boolean; timeUpdateSec: number },
    onStolen: () => void,
  ) => PoolAcquisition | null; // null = nothing stealable right now (stay on the poster)
  release: (ownerId: string, player: VideoPlayer) => void;
  // The owner whose entry must never be stolen (the video being WATCHED).
  setProtected: (ownerId: string | null) => void;
  // Dispose idle entries' loaded items — call ONLY when no video is on screen
  // (e.g. the feed just blurred), never during playback.
  unloadIdle: () => void;
};

function makePool(size: number): PlayerPool {
  let entries: Entry[] | null = null;
  let seqCounter = 0;
  let protectedOwner: string | null = null;

  function ensure(): Entry[] {
    if (!entries) {
      entries = Array.from({ length: size }, () => {
        const player = createVideoPlayer(null);
        player.timeUpdateEventInterval = 0;
        // Cap forward buffering (AVPlayerItem.preferredForwardBufferDuration).
        // Raw MP4 posts otherwise buffer UNBOUNDED at full throttle, so a
        // pre-warming neighbor/next player starves the PLAYING video's stream
        // mid-watch — the screen-recorded "plays a second, then freezes for
        // seconds" rebuffer. ~8s keeps playback smooth while making every
        // warm download bounded and polite.
        try { (player as any).bufferOptions = { preferredForwardBufferDuration: 8 }; } catch {}
        return { player, owner: null, uri: null, seq: 0 };
      });
    }
    return entries;
  }

  return {
    acquire(ownerId, uri, opts, onStolen) {
      const pool = ensure();
      // Preference order: my own entry → a free entry that STILL HOLDS MY
      // SOURCE (scroll-away/scroll-back resumes instantly, no reload, no
      // disposal) → a free EMPTY entry (no disposal cost) → a free loaded
      // entry (disposal on reuse) → steal the oldest non-protected entry.
      let entry =
        pool.find((e) => e.owner === ownerId) ??
        pool.find((e) => e.owner === null && e.uri === uri) ??
        pool.find((e) => e.owner === null && e.uri === null) ??
        pool.find((e) => e.owner === null);
      if (!entry) {
        const stealable = pool.filter((e) => e.owner !== protectedOwner);
        if (!stealable.length) return null;
        entry = stealable.reduce((a, b) => (a.seq <= b.seq ? a : b));
      }
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
          entry.loading = true;
          entry.loadPromise = p.replaceAsync({ uri })
            .then(() => { if (entry.uri === uri) entry.loading = false; })
            // A failed load must not poison the entry: clearing uri makes the
            // next acquire RETRY (fresh Cloudflare posts 404 while encoding;
            // one transient error used to mean a stuck thumbnail all session).
            .catch(() => { if (entry.uri === uri) { entry.uri = null; entry.loading = false; } });
          return { player: p, alreadyLoaded: false, loadPromise: entry.loadPromise };
        }
        // Same source re-acquired but the player ERRORED on it — retry now.
        if (p.status === 'error') {
          entry.loading = true;
          entry.loadPromise = p.replaceAsync({ uri })
            .then(() => { if (entry.uri === uri) entry.loading = false; })
            .catch(() => { if (entry.uri === uri) { entry.uri = null; entry.loading = false; } });
          return { player: p, alreadyLoaded: false, loadPromise: entry.loadPromise };
        }
        // Same source still loaded (re-acquired) — reveal immediately if ready.
        // NEVER while a swap is in flight: the OLD item still reports
        // readyToPlay, and trusting it revealed the previous post's video. If a
        // swap for THIS uri is still in flight (another card started it), hand
        // back its loadPromise so the caller waits for the real frame.
        return {
          player: p,
          alreadyLoaded: !entry.loading && p.status === 'readyToPlay',
          loadPromise: entry.loading ? entry.loadPromise : undefined,
        };
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
      try { player.pause(); } catch {}
      // NO unload here (rule 2) — the loaded item stays until reuse/unloadIdle.
    },
    setProtected(ownerId) {
      protectedOwner = ownerId;
    },
    unloadIdle() {
      if (!entries) return;
      for (const e of entries) {
        if (e.owner === null && e.uri !== null) {
          e.uri = null;
          try { e.player.pause(); } catch {}
          try { e.player.replaceAsync(null).catch(() => {}); } catch {}
        }
      }
    },
  };
}

// Separate pools per surface so reels can never steal the feed's players (the
// feed stays mounted under the reels modal) and vice versa.
export const feedPool = makePool(3);
export const acquireFeedPlayer = feedPool.acquire;
export const releaseFeedPlayer = feedPool.release;

export const reelPool = makePool(3);

// Explore grid (looping tile previews + the Laybell-TV banner): 2 concurrent
// tile previews + the always-live banner + 1 slack entry so a preview handoff
// mid-scroll (new tile acquires before the old one's release effect runs)
// never has to steal the banner's player.
export const explorePool = makePool(4);
