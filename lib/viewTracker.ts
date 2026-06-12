import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { getDeviceId } from './deviceId';
import { viewThresholds } from './playThresholds';

// Credits video VIEWS by cumulative genuine watch time, mirroring the audio
// stream logic in AudioContext. A module singleton so watch time for a post
// combines across every video surface (reel, post detail) and persists for a
// rolling 24h window. Call trackVideoProgress() from a Video's
// onPlaybackStatusUpdate; the server (record_view) enforces the real caps.

const KEY = 'view_progress_v1';
const WINDOW_MS = 24 * 60 * 60 * 1000;

const watchMs: Record<string, number> = {};      // cumulative forward watch ms per post
const awarded: Record<string, number> = {};      // views credited this window (0–3)
const windowStart: Record<string, number> = {};  // epoch ms the 24h window began
const lastPos: Record<string, number> = {};      // last reported position, for forward deltas

let uid: string | null = null;
let deviceId: string | null = null;
let initStarted = false;

async function init() {
  if (initStarted) return;
  initStarted = true;
  try {
    deviceId = await getDeviceId();
    const { data: { user } } = await supabase.auth.getUser();
    uid = user?.id ?? null;
    if (!uid) return;
    const raw = await AsyncStorage.getItem(`${KEY}_${uid}`);
    if (!raw) return;
    const map = JSON.parse(raw) as Record<string, { ms: number; awarded: number; ts: number }>;
    const now = Date.now();
    for (const [pid, e] of Object.entries(map)) {
      if (e && now - e.ts < WINDOW_MS) {
        watchMs[pid] = e.ms;
        awarded[pid] = e.awarded;
        windowStart[pid] = e.ts;
      }
    }
  } catch {}
}

function save() {
  if (!uid) return;
  try {
    const now = Date.now();
    const out: Record<string, { ms: number; awarded: number; ts: number }> = {};
    for (const pid of Object.keys(watchMs)) {
      const ts = windowStart[pid] ?? now;
      if (now - ts < WINDOW_MS) out[pid] = { ms: watchMs[pid] || 0, awarded: awarded[pid] || 0, ts };
    }
    AsyncStorage.setItem(`${KEY}_${uid}`, JSON.stringify(out)).catch(() => {});
  } catch {}
}

function recordView(postId: string) {
  supabase.rpc('record_view', { p_post_id: postId, p_device_id: deviceId }).then(undefined, () => {});
}

// Feed a video's playback status. Accumulates genuine forward watch time (ignores
// seeks, rewinds and the jump on loop), then credits the 1st/2nd/3rd view as
// cumulative watch time crosses this video's duration-scaled thresholds.
export function trackVideoProgress(postId: string, positionMs: number, durationMs: number) {
  if (!postId || !durationMs || durationMs <= 0) return;
  if (!initStarted) init();

  const delta = positionMs - (lastPos[postId] ?? 0);
  lastPos[postId] = positionMs;
  if (!(delta > 0 && delta < 1500)) return; // ignore seeks/loops/large gaps

  const now = Date.now();
  const ws = windowStart[postId];
  if (ws == null || now - ws >= WINDOW_MS) {
    windowStart[postId] = now;
    watchMs[postId] = 0;
    awarded[postId] = 0;
  }

  const watched = (watchMs[postId] || 0) + delta;
  watchMs[postId] = watched;
  const a = awarded[postId] || 0;
  // 1st view at a flat 5s of genuine watch; 2nd/3rd need real rewatching.
  const { t1, t2, t3 } = viewThresholds(durationMs / 1000);
  if (a === 0 && watched >= t1 * 1000) { awarded[postId] = 1; recordView(postId); save(); }
  else if (a === 1 && watched >= t2 * 1000) { awarded[postId] = 2; recordView(postId); save(); }
  else if (a === 2 && watched >= t3 * 1000) { awarded[postId] = 3; recordView(postId); save(); }
}
