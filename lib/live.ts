// Livestream data layer for the Live tab. Streams live in Cloudflare Stream Live
// (via the live-input edge function); rows live in live_streams (public while
// live) + live_stream_keys (broadcaster-only secrets). Viewer counts and live
// chat ride a Supabase Realtime presence/broadcast channel — nothing persisted.

import { supabase } from './supabase';
import type { Tier } from './badges';

export type LiveProfile = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  // Drives the live donation lock — only a Premium host (premium_until in the
  // future) can receive tips (lib/donations hostCanReceive).
  premium_until: string | null;
  // Badge display fields (badges.sql) — color the host's name on the live feed
  // by their displayed tier. Optional: absent on a pre-badges database.
  badge_tier?: string | null;
  badge_show?: boolean | null;
  profile_theme?: string | null;
};

// Broadcast orientation (phone go-live choice). 'horizontal' and 'both'
// streams ALSO surface in Laybell TV; 'vertical'/'both' show in the main feed.
export type LiveOrientation = 'vertical' | 'horizontal' | 'both';

export type LiveStream = {
  id: string;
  user_id: string;
  title: string | null;
  mode: 'webrtc' | 'rtmp';
  orientation: LiveOrientation;
  cf_input_uid: string;
  playback_url: string;
  status: 'idle' | 'live' | 'ended';
  started_at: string | null;
  viewer_peak: number;
  profile?: LiveProfile;
};

export type LiveStreamKeys = {
  whipUrl: string;
  rtmpsUrl: string;
  rtmpsStreamKey: string;
};

export type LiveChatMessage = {
  id: string;
  userId: string;
  name: string;
  avatarUrl: string | null;
  text: string;
  at: number;
  // Sender's displayed badge tier, stamped at send time — colors their name in
  // the chat overlay. Absent/null (older clients, no badge) → default white.
  tier?: Tier | null;
};

async function attachProfiles<T extends { user_id: string }>(rows: T[]): Promise<(T & { profile?: LiveProfile })[]> {
  const ids = [...new Set(rows.map((r) => r.user_id))];
  if (!ids.length) return rows;
  // The badge columns arrive with badges.sql — on a pre-badges database this
  // select errors, so retry with the base column set rather than losing the
  // host profiles entirely.
  let data: LiveProfile[] | null = (await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url, premium_until, badge_tier, badge_show, profile_theme')
    .in('id', ids)).data;
  if (!data) {
    data = (await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, premium_until')
      .in('id', ids)).data;
  }
  const byId = new Map((data ?? []).map((p) => [p.id, p as LiveProfile]));
  return rows.map((r) => ({ ...r, profile: byId.get(r.user_id) }));
}

const LIVE_COLS = 'id, user_id, title, mode, orientation, cf_input_uid, playback_url, status, started_at, viewer_peak';

/**
 * Broadcasts currently live, newest first. `horizontalOnly` (Laybell TV's Lives
 * tab) keeps only orientation 'horizontal'|'both'. Falls back gracefully if the
 * orientation column isn't migrated yet (the filter no-ops → all lives shown).
 */
export async function fetchLiveStreams(horizontalOnly = false): Promise<LiveStream[]> {
  let q = supabase
    .from('live_streams')
    .select(LIVE_COLS)
    .eq('status', 'live')
    .order('started_at', { ascending: false })
    .limit(50);
  if (horizontalOnly) q = q.in('orientation', ['horizontal', 'both']);
  const { data, error } = await q;
  if (error) {
    // Pre-migration (no orientation column): retry without the horizontal filter.
    if (horizontalOnly) {
      const { data: d2 } = await supabase
        .from('live_streams')
        .select('id, user_id, title, mode, cf_input_uid, playback_url, status, started_at, viewer_peak')
        .eq('status', 'live').order('started_at', { ascending: false }).limit(50);
      return attachProfiles((d2 ?? []) as LiveStream[]);
    }
    throw error;
  }
  return attachProfiles((data ?? []) as LiveStream[]);
}

/**
 * Provisions a Cloudflare live input and creates the stream row (status 'idle'
 * until the broadcast actually starts). Returns the row plus broadcaster
 * secrets; secrets are also stored in live_stream_keys for resuming.
 */
export async function createLiveStream(
  title: string,
  mode: 'webrtc' | 'rtmp',
  orientation: LiveOrientation = 'vertical',
): Promise<{ stream: LiveStream; keys: LiveStreamKeys }> {
  const { data, error } = await supabase.functions.invoke('live-input', {
    body: { action: 'create', title },
  });
  if (error || !data?.inputUid) throw new Error(data?.error ?? error?.message ?? 'live input failed');

  const { data: auth } = await supabase.auth.getUser();
  const userId = auth?.user?.id;
  if (!userId) throw new Error('not signed in');

  const playbackUrl = mode === 'webrtc' ? data.whepUrl : data.hlsUrl;
  const { data: row, error: insErr } = await supabase
    .from('live_streams')
    .insert({
      user_id: userId,
      title: title || null,
      mode,
      orientation,
      cf_input_uid: data.inputUid,
      playback_url: playbackUrl,
    })
    .select()
    .single();
  if (insErr) throw insErr;

  await supabase.from('live_stream_keys').insert({
    stream_id: row.id,
    user_id: userId,
    whip_url: data.whipUrl,
    rtmps_url: data.rtmpsUrl,
    rtmps_stream_key: data.rtmpsStreamKey,
  });

  return {
    stream: row as LiveStream,
    keys: { whipUrl: data.whipUrl, rtmpsUrl: data.rtmpsUrl, rtmpsStreamKey: data.rtmpsStreamKey },
  };
}

/** Flips the public row to 'live' the moment media is actually flowing. */
export async function markLive(streamId: string): Promise<void> {
  const { error } = await supabase
    .from('live_streams')
    .update({ status: 'live', started_at: new Date().toISOString() })
    .eq('id', streamId);
  if (error) throw error;
}

/** Ends the broadcast: row → 'ended', Cloudflare input deleted (best effort). */
export async function endLiveStream(streamId: string, inputUid: string, viewerPeak = 0): Promise<void> {
  await supabase
    .from('live_streams')
    .update({ status: 'ended', ended_at: new Date().toISOString(), viewer_peak: viewerPeak })
    .eq('id', streamId);
  supabase.functions
    .invoke('live-input', { body: { action: 'delete', inputUid } })
    .catch((err) => console.log('live input delete:', err?.message));
}

/** Abandoned Go Live (created an input but never went live) — clean it all up. */
export async function discardLiveStream(streamId: string, inputUid: string): Promise<void> {
  await supabase.from('live_streams').delete().eq('id', streamId);
  supabase.functions
    .invoke('live-input', { body: { action: 'delete', inputUid } })
    .catch(() => { /* best effort */ });
}

/** Asks Cloudflare whether an encoder is connected to the input (RTMP mode). */
export async function isInputConnected(inputUid: string): Promise<boolean> {
  const { data } = await supabase.functions.invoke('live-input', {
    body: { action: 'status', inputUid },
  });
  return !!data?.connected;
}

/**
 * Joins a stream's realtime channel: presence drives the viewer count, broadcast
 * carries ephemeral chat. Returns send + leave handles. Broadcasters join too
 * (they're not counted — presence key 'host' is subtracted client-side).
 */
export function joinLiveChannel(opts: {
  streamId: string;
  userId: string;
  name: string;
  avatarUrl: string | null;
  // The joiner's displayed badge tier — rides along on every chat message they
  // send so other viewers can tier-color their name.
  tier?: Tier | null;
  isHost?: boolean;
  onViewers: (count: number) => void;
  onChat: (msg: LiveChatMessage) => void;
}) {
  const channel = supabase.channel(`live:${opts.streamId}`, {
    config: {
      presence: { key: opts.isHost ? `host:${opts.userId}` : opts.userId },
      broadcast: { self: true },
    },
  });
  channel.on('presence', { event: 'sync' }, () => {
    const keys = Object.keys(channel.presenceState());
    onlyViewers(keys, opts.onViewers);
  });
  channel.on('broadcast', { event: 'chat' }, ({ payload }) => {
    if (payload) opts.onChat(payload as LiveChatMessage);
  });
  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') channel.track({ at: Date.now() }).catch(() => {});
  });

  return {
    sendChat(text: string) {
      const msg: LiveChatMessage = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        userId: opts.userId,
        name: opts.name,
        avatarUrl: opts.avatarUrl,
        text: text.slice(0, 300),
        at: Date.now(),
        tier: opts.tier ?? null,
      };
      channel.send({ type: 'broadcast', event: 'chat', payload: msg }).catch(() => {});
      return msg;
    },
    leave() {
      supabase.removeChannel(channel);
    },
  };
}

function onlyViewers(presenceKeys: string[], cb: (n: number) => void) {
  cb(presenceKeys.filter((k) => !k.startsWith('host:')).length);
}
