import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

// Offline stream-credit outbox.
//
// record_stream is fire-and-forget in AudioContext, so a listen with no network
// silently loses the creator's stream credit. This persists failed record_stream
// calls and replays them when connectivity returns (on app foreground / next
// successful RPC). The server's own per-user/per-device 24h caps dedupe replays, so
// re-sending is safe — and we deliberately do NOT backdate (no forged timestamps):
// an offline listen simply counts at reconnect time.
//
// Scoped per user id: we only ever replay events for the currently signed-in user,
// so signing in as someone else never credits their account with another's listens.

type StreamEvent = { postId: string; deviceId: string | null; ts: number };

const MAX_QUEUED = 200;
const key = (uid: string) => `stream_outbox_v1_${uid}`;

async function load(uid: string): Promise<StreamEvent[]> {
  try {
    const raw = await AsyncStorage.getItem(key(uid));
    return raw ? (JSON.parse(raw) as StreamEvent[]) : [];
  } catch { return []; }
}

async function save(uid: string, events: StreamEvent[]) {
  try { await AsyncStorage.setItem(key(uid), JSON.stringify(events.slice(-MAX_QUEUED))); } catch {}
}

// Try to record a stream now; on any failure, queue it for later replay.
// Mirrors the existing AudioContext call shape: rpc('record_stream', { p_post_id, p_device_id }).
export async function recordStream(uid: string, postId: string, deviceId: string | null): Promise<void> {
  try {
    const { error } = await supabase.rpc('record_stream', { p_post_id: postId, p_device_id: deviceId });
    if (!error) return;
    throw error;
  } catch {
    try {
      const q = await load(uid);
      q.push({ postId, deviceId, ts: Date.now() });
      await save(uid, q);
    } catch {}
  }
}

// Replay queued events. Stops on the first failure (still offline) and keeps the
// remainder for the next attempt. Safe to call repeatedly (server caps dedupe).
export async function flushStreamOutbox(uid: string): Promise<void> {
  let q = await load(uid);
  if (!q.length) return;
  const remaining: StreamEvent[] = [];
  let failed = false;
  for (let i = 0; i < q.length; i++) {
    if (failed) { remaining.push(q[i]); continue; }
    const ev = q[i];
    try {
      const { error } = await supabase.rpc('record_stream', { p_post_id: ev.postId, p_device_id: ev.deviceId });
      if (error) { failed = true; remaining.push(ev); }
    } catch { failed = true; remaining.push(ev); }
  }
  await save(uid, remaining);
}
