import { Platform } from 'react-native';
import { supabase } from './supabase';
import { getPrefs } from './offlinePrefs';
import { getNetworkState } from './network';
import { getPrefetchCandidates } from './listenHistory';
import { autoCache, setKeepSet } from './offline';

// Offline safety-net prefetch (Layer 0, proactive half).
//
// The reactive auto-cache (lib/offline.autoCache, fired from the player) keeps songs
// AS YOU PLAY them. This complements it by proactively keeping, on device, the user's
// top-N most-played and N most-recent songs — so an UNEXPECTED Wi-Fi/data outage
// doesn't stop the music: their recent and favourite tracks are already cached.
//
// These are TEMPORARY caches (cacheDirectory, OS-evictable, never permanent — same as
// the rest of Layer 0); they exist purely for outage resilience. Honors the creator's
// download opt-out (re-verified against the server here), the user's auto-cache /
// Wi-Fi-only prefs, connectivity, and free space (all enforced by autoCache per track).
//
// Gated by the SAME "Auto-download recent songs" setting as the reactive cache, and —
// like all of Layer 0 — only actually runs once NetInfo is in the native build
// (lib/network.ts), so it ships dormant ahead of that rebuild.

export const PREFETCH_TOP_N = 6;       // top most-listened (the user asked for 6)
export const PREFETCH_RECENT_N = 6;    // most-recently listened
const MIN_INTERVAL_MS = 10 * 60 * 1000; // don't re-run more than every ~10 min on foreground

let lastRunAt = 0;
let running = false;

// Compute the desired set, protect it from LRU eviction, and download whatever's
// missing. Safe to call on launch, foreground, and when connectivity returns.
export async function runOfflinePrefetch(uid: string, force = false): Promise<void> {
  if (Platform.OS === 'web' || !uid) return;
  if (running) return;
  const now = Date.now();
  if (!force && now - lastRunAt < MIN_INTERVAL_MS) return;

  running = true;
  try {
    const prefs = await getPrefs();
    if (!prefs.autoCache) { setKeepSet([]); return; }   // feature off → protect nothing

    const net = await getNetworkState();
    if (!net.isConnected) return;                        // offline → can't fetch (the outage itself)
    if (prefs.wifiOnly && !net.isWifi) return;           // respect Wi-Fi-only

    const candidates = await getPrefetchCandidates(uid, PREFETCH_TOP_N, PREFETCH_RECENT_N);
    if (!candidates.length) { setKeepSet([]); return; }

    // Re-verify against the server: an opted-out (downloadable=false), deleted, or
    // re-uploaded (drifted media_url) track must not be prefetched. RLS-filtered, so
    // an inaccessible post simply doesn't come back. Use the FRESH media_url + flag.
    const ids = candidates.map((c) => c.id);
    const { data, error } = await supabase
      .from('posts')
      .select('id, media_url, downloadable')
      .in('id', ids);
    if (error || !data) return;

    const byId = new Map(data.map((r: any) => [r.id, r]));
    // Keep candidate order (recent first, then top), but only those still downloadable.
    const wanted = candidates
      .map((c) => ({ c, row: byId.get(c.id) as any }))
      .filter(({ row }) => row && row.media_url && row.downloadable !== false);

    // Protect the intended set from eviction BEFORE downloading, so in-flight + already
    // cached copies survive the reactive LRU while the rest of the set fills in.
    setKeepSet(wanted.map(({ c }) => c.id));
    lastRunAt = now;

    // Download what's missing, sequentially (small set, background, never blocks
    // playback). autoCache is idempotent (skips already-cached) and self-gates on
    // prefs/network/free-space/opt-out, so this is just "ensure present".
    for (const { c, row } of wanted) {
      await autoCache(c.id, row.media_url, {
        title: c.title, artist: c.artist, cover: c.cover, downloadable: true,
      });
    }
  } catch {
    // best-effort — never throw into the caller (launch / foreground / reconnect)
  } finally {
    running = false;
  }
}
