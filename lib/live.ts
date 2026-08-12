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
  // Drives the tip FEE disclosure (lib/donations hostFeeRate) — either
  // subscription active = the premium rate, matching what the server charges.
  premium_until: string | null;
  premium_plus_until?: string | null;
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
  // Last "I'm still broadcasting" ping (updated ~every 15s while live). Absent on
  // pre-migration DBs / older clients → treated as always-fresh (never hidden).
  last_heartbeat_at?: string | null;
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
  // Sender's @handle — lets a tapped reply insert a real, resolvable @username
  // mention (older clients omit it → falls back to the display name).
  username?: string | null;
  avatarUrl: string | null;
  text: string;
  at: number;
  // Sender's displayed badge tier, stamped at send time — colors their name in
  // the chat overlay. Absent/null (older clients, no badge) → default white.
  tier?: Tier | null;
};

// A donation, broadcast over the SAME live channel as chat (ephemeral — the DB
// row in `donations` is the record of truth; this is just the real-time alert
// payload). Every joiner incl. the host and the donor themselves receives it
// (broadcast self:true) and shows the Twitch-style alert overlay.
export type LiveDonationEvent = {
  id: string;
  donorId: string;
  name: string;
  avatarUrl: string | null;
  amountCents: number;
  message: string;
  at: number;
};

async function attachProfiles<T extends { user_id: string }>(rows: T[]): Promise<(T & { profile?: LiveProfile })[]> {
  const ids = [...new Set(rows.map((r) => r.user_id))];
  if (!ids.length) return rows;
  // The badge columns arrive with badges.sql and premium_plus_until with
  // premium_plus.sql — on a database missing either, this select errors, so
  // retry with the base column set rather than losing the host profiles
  // entirely. (The fallback deliberately omits the newer columns: pre-migration
  // nobody can BE Premium+, so the standard-fee display it implies is correct.)
  let data: LiveProfile[] | null = (await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url, premium_until, premium_plus_until, badge_tier, badge_show, profile_theme')
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
const LIVE_COLS_HB = `${LIVE_COLS}, last_heartbeat_at`;

// A live host pings last_heartbeat_at ~every 15s. If the newest ping is older
// than this, their app is gone (killed / crashed / long-backgrounded, which stops
// the camera anyway) — a ghost, so hide it. Generous enough (3 missed pings) that
// a brief network blip never flickers a real stream out.
const STALE_LIVE_MS = 45_000;

// Drop ghost lives: any row whose heartbeat has gone stale. A NULL heartbeat means
// a pre-migration DB or an older client that can't ping — those are left visible
// (we can't tell, so we don't hide a possibly-real stream).
function dropStaleLives<T extends { last_heartbeat_at?: string | null }>(rows: T[]): T[] {
  const cutoff = Date.now() - STALE_LIVE_MS;
  return rows.filter((r) => {
    if (r.last_heartbeat_at == null) return true;
    const t = new Date(r.last_heartbeat_at).getTime();
    return Number.isNaN(t) || t >= cutoff;
  });
}

/**
 * A frame of the live from Cloudflare's thumbnail endpoint
 * (`<origin>/<uid>/thumbnails/thumbnail.jpg`). Cloudflare generates these from
 * the HLS/recording pipeline, which RTMP/SRT inputs run — so encoder lives get a
 * real preview frame. WHIP (phone/WebRTC) inputs have no such pipeline during
 * Cloudflare's beta, so the URL 404s there and callers fall back to the host
 * avatar. Origin is reused from playback_url (WHEP or HLS both carry it).
 */
export function liveThumbnailUrl(l: Pick<LiveStream, 'playback_url' | 'cf_input_uid'>): string | null {
  try {
    if (!l.cf_input_uid || !l.playback_url) return null;
    return `${new URL(l.playback_url).origin}/${l.cf_input_uid}/thumbnails/thumbnail.jpg?height=720`;
  } catch {
    return null;
  }
}

/**
 * Broadcasts currently live, newest first. `horizontalOnly` (Laybell TV's Lives
 * tab) keeps only orientation 'horizontal'|'both'. Falls back gracefully if the
 * orientation column isn't migrated yet (the filter no-ops → all lives shown).
 */
export async function fetchLiveStreams(horizontalOnly = false): Promise<LiveStream[]> {
  const build = (cols: string) => {
    let q = supabase
      .from('live_streams')
      .select(cols)
      .eq('status', 'live')
      .order('started_at', { ascending: false })
      .limit(50);
    if (horizontalOnly) q = q.in('orientation', ['horizontal', 'both']);
    return q;
  };
  // Prefer the heartbeat column so ghosts can be filtered; retry on the base
  // columns if it isn't migrated yet (then nothing gets hidden — same as before).
  let { data, error } = await build(LIVE_COLS_HB);
  if (error) ({ data, error } = await build(LIVE_COLS));
  if (error) {
    // Pre-migration (no orientation column): retry without the horizontal filter.
    if (horizontalOnly) {
      const { data: d2 } = await supabase
        .from('live_streams')
        .select('id, user_id, title, mode, cf_input_uid, playback_url, status, started_at, viewer_peak')
        .eq('status', 'live').order('started_at', { ascending: false }).limit(50);
      return attachProfiles(dropStaleLives((d2 ?? []) as LiveStream[]));
    }
    throw error;
  }
  return attachProfiles(dropStaleLives((data ?? []) as unknown as LiveStream[]));
}

/**
 * Provisions a Cloudflare live input and creates the stream row (status 'idle'
 * until the broadcast actually starts). Returns the row plus broadcaster
 * secrets; secrets are also stored in live_stream_keys for resuming.
 */
/**
 * Digs the real failure out of a functions.invoke error. supabase-js turns every
 * non-2xx into a FunctionsHttpError, nulls `data`, and sets the message to the
 * famously unhelpful "Edge Function returned a non-2xx status code" — the body
 * that says what actually went wrong is left unread on `.context`. Without this
 * a host whose go-live failed is told nothing at all.
 */
async function edgeErrorDetail(error: unknown, data: any): Promise<string> {
  const join = (b: any) => [b?.error, b?.reason].filter(Boolean).join(': ');
  if (data?.error) return join(data);
  const ctx = (error as any)?.context;
  if (ctx && typeof ctx.json === 'function') {
    try {
      const detail = join(await ctx.json());
      if (detail) return detail;
    } catch { /* not JSON — fall through to the generic message */ }
  }
  return (error as any)?.message ?? '';
}

export async function createLiveStream(
  title: string,
  mode: 'webrtc' | 'rtmp',
  orientation: LiveOrientation = 'vertical',
): Promise<{ stream: LiveStream; keys: LiveStreamKeys }> {
  const call = () => supabase.functions.invoke('live-input', { body: { action: 'create', title } });

  let { data, error } = await call();
  if (error || !data?.inputUid) {
    const detail = await edgeErrorDetail(error, data);
    // 'live_input_failed' means Cloudflare answered and refused, so a retry only
    // burns a second input. Anything else (an expired token the client hasn't
    // rotated yet, a cold start, a dropped connection) is worth exactly one more
    // go with a fresh session — a host tapping "Go live" should not be defeated
    // by a blip they can do nothing about.
    if (detail.startsWith('live_input_failed')) throw new Error(detail);
    await supabase.auth.refreshSession().catch(() => {});
    ({ data, error } = await call());
    if (error || !data?.inputUid) {
      throw new Error((await edgeErrorDetail(error, data)) || 'live input failed');
    }
  }

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
      // save_replay / replay_attested_at are deliberately not written any more:
      // the "Save a replay" switch is gone and every recording is deleted when
      // the broadcast ends, so the columns would only ever record `false`.
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

/**
 * "I'm still broadcasting" ping — called ~every 15s while live so viewers' feeds
 * can hide this stream the moment the host's app dies (see dropStaleLives). Fully
 * best-effort: pre-migration (no column) or offline just no-ops, and markLive is
 * deliberately NOT touched, so going live never depends on this column existing.
 */
export async function beatLiveStream(streamId: string): Promise<void> {
  await supabase
    .from('live_streams')
    .update({ last_heartbeat_at: new Date().toISOString() })
    .eq('id', streamId); // returned error (missing column / RLS / offline) is ignored on purpose
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

/**
 * Reaps THIS user's "ghost" streams — rows still marked live/idle when the user
 * is provably NOT broadcasting. They happen when a broadcast's cleanup never runs
 * (app force-killed or crashed mid-stream), leaving a status='live' row that has
 * no media behind it — so it lingers in the live feed forever as an un-playable
 * black screen, and the host even sees themselves "live". Call this whenever we
 * KNOW the user isn't broadcasting: cold app start, opening Go Live, opening the
 * live feed.
 *
 * Crucially it ends ONLY the specific rows it just read (`.in('id', ids)`), never
 * a blanket "all my non-ended rows" update — so a brand-new broadcast created a
 * moment later (racing this call) can never be reaped by it. Returns the count.
 */
export async function endMyStaleLiveStreams(userId: string): Promise<number> {
  if (!userId) return 0;
  const { data } = await supabase
    .from('live_streams')
    .select('id, cf_input_uid')
    .eq('user_id', userId)
    .neq('status', 'ended');
  const rows = (data ?? []) as { id: string; cf_input_uid: string | null }[];
  if (!rows.length) return 0;
  await supabase
    .from('live_streams')
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .in('id', rows.map((r) => r.id));
  // Best-effort Cloudflare input teardown so ghosts don't linger as paid inputs.
  for (const r of rows) {
    if (r.cf_input_uid) {
      supabase.functions.invoke('live-input', { body: { action: 'delete', inputUid: r.cf_input_uid } }).catch(() => {});
    }
  }
  return rows.length;
}

/** Asks Cloudflare whether an encoder is connected to the input (RTMP mode). */
export async function isInputConnected(inputUid: string): Promise<boolean> {
  const { data } = await supabase.functions.invoke('live-input', {
    body: { action: 'status', inputUid },
  });
  return !!data?.connected;
}

export type LiveChannelOpts = {
  userId: string;
  name: string;
  username?: string | null;
  avatarUrl: string | null;
  // The joiner's displayed badge tier — rides along on every chat message they
  // send so other viewers can tier-color their name.
  tier?: Tier | null;
  isHost?: boolean;
  onViewers: (count: number) => void;
  onChat: (msg: LiveChatMessage) => void;
  onDonation?: (d: LiveDonationEvent) => void;
  // Studio broadcasts: the host announces the end over the channel (listeners
  // can't watch the session row through RLS the way stream viewers can).
  onEnded?: () => void;
  // Studio RADIO. The host publishes what is playing and everyone plays it
  // themselves from the CDN, in step — see lib/studioRadio.ts for why the audio
  // does not travel through LiveKit.
  onRadio?: (state: StudioRadioState) => void;
  /**
   * A tap-reaction: one emoji, floated on everyone's screen.
   *
   * Separate from chat on purpose. Reactions are the low-effort end of taking
   * part — most people will never type, and a tap should not put a message in
   * the transcript for everyone to scroll past.
   */
  onReaction?: (emoji: string) => void;
  // Host only: somebody just arrived and is asking what is on. Answering this
  // is what makes a late joiner hear the current song immediately instead of
  // waiting for the next heartbeat.
  onRadioRequest?: () => void;
};

/**
 * What the room is playing. `positionMs` is the position at `startedAt`, so the
 * live position is positionMs + (now - startedAt) unless paused.
 *
 * `hostAt` is the host's clock at send time. A receiver compares it with its own
 * clock to correct for device clock skew, which is otherwise the single biggest
 * source of drift between two phones — bigger than network latency.
 */
export type StudioRadioState = {
  track: {
    id: string;
    title: string;
    artist: string;
    cover: string | null;
    uri: string;
    durationMs: number | null;
  } | null;
  startedAt: number;
  positionMs: number;
  paused: boolean;
  hostAt: number;
};

export type LiveChannelHandle = ReturnType<typeof joinBroadcastChannel>;

/**
 * Joins a stream's realtime channel: presence drives the viewer count, broadcast
 * carries ephemeral chat. Returns send + leave handles. Broadcasters join too
 * (they're not counted — presence key 'host' is subtracted client-side).
 */
export function joinLiveChannel(opts: LiveChannelOpts & { streamId: string }) {
  return joinBroadcastChannel(`live:${opts.streamId}`, opts);
}

/**
 * Same machinery for a STUDIO broadcast's audience — chat, donation alerts and
 * the listener count ride one channel, exactly like a livestream's.
 */
export function joinStudioChannel(sessionId: string, opts: LiveChannelOpts) {
  return joinBroadcastChannel(`studio-live:${sessionId}`, opts);
}

function joinBroadcastChannel(channelName: string, opts: LiveChannelOpts) {
  const channel = supabase.channel(channelName, {
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
  channel.on('broadcast', { event: 'donation' }, ({ payload }) => {
    if (payload) opts.onDonation?.(payload as LiveDonationEvent);
  });
  channel.on('broadcast', { event: 'ended' }, () => {
    opts.onEnded?.();
  });
  channel.on('broadcast', { event: 'reaction' }, ({ payload }) => {
    const e = (payload as { emoji?: unknown })?.emoji;
    // Length-capped: this arrives from another client and lands straight in a
    // <Text>. One emoji is one or two code points plus a possible modifier.
    if (typeof e === 'string' && e.length > 0 && e.length <= 8) opts.onReaction?.(e);
  });
  channel.on('broadcast', { event: 'radio' }, ({ payload }) => {
    if (payload) opts.onRadio?.(payload as StudioRadioState);
  });
  // `broadcast: { self: true }` means the host hears its own request too — it
  // answers that harmlessly, and the guard is that only a host wires this up.
  channel.on('broadcast', { event: 'radio:req' }, () => {
    opts.onRadioRequest?.();
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
        username: opts.username ?? null,
        avatarUrl: opts.avatarUrl,
        text: text.slice(0, 300),
        at: Date.now(),
        tier: opts.tier ?? null,
      };
      channel.send({ type: 'broadcast', event: 'chat', payload: msg }).catch(() => {});
      return msg;
    },
    // Broadcast a donation to the room (the alert overlay). The DB insert (lib/
    // donations.donate) is separate — this is only the real-time notification.
    sendDonation(amountCents: number, message: string) {
      const d: LiveDonationEvent = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        donorId: opts.userId,
        name: opts.name,
        avatarUrl: opts.avatarUrl,
        amountCents,
        message: message.slice(0, 200),
        at: Date.now(),
      };
      channel.send({ type: 'broadcast', event: 'donation', payload: d }).catch(() => {});
      return d;
    },
    // Host only: tell the audience the broadcast is over (studio listeners
    // have no RLS view of the session row, so this IS their end signal).
    sendEnded() {
      channel.send({ type: 'broadcast', event: 'ended', payload: { at: Date.now() } }).catch(() => {});
    },
    sendReaction(emoji: string) {
      channel.send({ type: 'broadcast', event: 'reaction', payload: { emoji: emoji.slice(0, 8) } }).catch(() => {});
    },
    // Host only: publish what is playing. Sent on every change AND on a
    // heartbeat, so a client that missed one packet is never wrong for long.
    sendRadio(state: Omit<StudioRadioState, 'hostAt'>) {
      const payload: StudioRadioState = { ...state, hostAt: Date.now() };
      channel.send({ type: 'broadcast', event: 'radio', payload }).catch(() => {});
      return payload;
    },
    // Anyone: "I just got here, what's on?" The host replies with sendRadio.
    requestRadio() {
      channel.send({ type: 'broadcast', event: 'radio:req', payload: { at: Date.now() } }).catch(() => {});
    },
    leave() {
      supabase.removeChannel(channel);
    },
  };
}

function onlyViewers(presenceKeys: string[], cb: (n: number) => void) {
  cb(presenceKeys.filter((k) => !k.startsWith('host:')).length);
}
