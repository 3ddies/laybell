// Studio sessions — private, high-quality LiveKit voice rooms for realtime
// collaboration ("Laybell as the connector for online studio sessions").
//
// Audio is tuned for MUSIC, not meetings: 48kHz stereo Opus at a high bitrate
// with DTX/RED off, and a "studio mode" that disables echo cancellation, noise
// suppression, and auto-gain so DAW playback and instruments aren't mangled.
// Desktop collaborators join through web/studio.html with the 6-char code and
// can pipe FL Studio / BandLab / any app's audio in via system-audio share.
//
// Sync count-in: the host broadcasts a data message with a target timestamp;
// every client beeps 4 counts and flashes REC at the same wall-clock moment so
// everyone can punch record in their own DAW in sync.

import type { Room } from 'livekit-client';
import { supabase } from './supabase';

// livekit-client touches browser globals at import time (DOMException, etc.)
// that only exist after registerGlobals() succeeds — so it is loaded LAZILY,
// never at module scope (this file is pulled in by eagerly-bundled routes).
type LK = typeof import('livekit-client');
let lkCached: LK | null = null;
function lk(): LK {
  if (!lkCached) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    lkCached = require('livekit-client') as LK;
  }
  return lkCached;
}

/** RoomEvent enum, loaded lazily — for screens wiring room listeners. */
export function getRoomEvents(): LK['RoomEvent'] {
  return lk().RoomEvent;
}

export type StudioSession = {
  id: string;
  host_id: string;
  title: string | null;
  join_code: string;
  status: 'open' | 'ended';
  created_at: string;
  member_count?: number;
  // Broadcast state (studio_live.sql) — absent on a pre-migration database.
  live?: boolean;
  live_started_at?: string | null;
  listener_peak?: number;
};

export type StudioMember = {
  user_id: string;
  role: 'host' | 'member';
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

export type CountInMessage = {
  t: 'countin';
  startAt: number; // epoch ms when the REC flash should land
  bpm: number;
  from: string;
};

export type StudioJoinRequest = {
  session_id: string;
  user_id: string;
  status: 'pending' | 'accepted' | 'declined';
  created_at: string;
  username?: string | null;
  display_name?: string | null;
  avatar_url?: string | null;
};

/** A live studio broadcast as the audience sees it (RPC-shaped — no join code). */
export type LiveStudioSession = {
  id: string;
  title: string | null;
  host_id: string;
  live_started_at: string | null;
  host_username: string | null;
  host_display_name: string | null;
  host_avatar_url: string | null;
  member_count: number;
};

// --- Session CRUD -------------------------------------------------------------

export async function createStudioSession(title: string): Promise<StudioSession> {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth?.user?.id;
  if (!userId) throw new Error('not signed in');
  const { data, error } = await supabase
    .from('studio_sessions')
    .insert({ host_id: userId, title: title || null })
    .select()
    .single();
  if (error) throw error;
  await supabase
    .from('studio_session_members')
    .insert({ session_id: data.id, user_id: userId, role: 'host' });
  return data as StudioSession;
}

export async function joinByCode(code: string): Promise<string> {
  const { data, error } = await supabase.rpc('join_studio_session', { code });
  if (error) throw new Error(error.message.includes('invalid') ? 'invalid_code' : error.message);
  return data as string;
}

export async function fetchMySessions(): Promise<StudioSession[]> {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth?.user?.id;
  if (!userId) return [];
  const { data, error } = await supabase
    .from('studio_sessions')
    .select('id, host_id, title, join_code, status, created_at')
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) throw error;
  return (data ?? []) as StudioSession[];
}

export async function fetchSession(sessionId: string): Promise<StudioSession | null> {
  // The broadcast columns arrive with studio_live.sql — on a pre-migration
  // database that select errors, so retry with the base column set.
  let row: unknown = (await supabase
    .from('studio_sessions')
    .select('id, host_id, title, join_code, status, created_at, live, live_started_at, listener_peak')
    .eq('id', sessionId)
    .maybeSingle()).data;
  if (!row) {
    row = (await supabase
      .from('studio_sessions')
      .select('id, host_id, title, join_code, status, created_at')
      .eq('id', sessionId)
      .maybeSingle()).data;
  }
  return (row as StudioSession) ?? null;
}

export async function fetchRoster(sessionId: string): Promise<StudioMember[]> {
  const { data, error } = await supabase
    .from('studio_session_members')
    .select('user_id, role')
    .eq('session_id', sessionId);
  if (error) throw error;
  const rows = (data ?? []) as { user_id: string; role: 'host' | 'member' }[];
  if (!rows.length) return [];
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url')
    .in('id', rows.map((r) => r.user_id));
  const byId = new Map((profiles ?? []).map((p) => [p.id, p]));
  return rows.map((r) => ({
    user_id: r.user_id,
    role: r.role,
    username: byId.get(r.user_id)?.username ?? null,
    display_name: byId.get(r.user_id)?.display_name ?? null,
    avatar_url: byId.get(r.user_id)?.avatar_url ?? null,
  }));
}

export async function endSession(sessionId: string): Promise<void> {
  await supabase
    .from('studio_sessions')
    // live:false so an in-progress broadcast ends with the session (the column
    // arrives with studio_live.sql; pre-migration the update still succeeds
    // because unknown columns are the caller's schema problem — so send it in
    // a second, best-effort update instead of risking the primary one).
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .eq('id', sessionId);
  await supabase.from('studio_sessions').update({ live: false }).eq('id', sessionId).then(() => {}, () => {});
}

export async function leaveSession(sessionId: string): Promise<void> {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth?.user?.id;
  if (!userId) return;
  await supabase
    .from('studio_session_members')
    .delete()
    .eq('session_id', sessionId)
    .eq('user_id', userId);
}

// --- LiveKit room -------------------------------------------------------------

/** Capture profile for "studio mode": raw signal, no voice processing. */
const STUDIO_CAPTURE = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 2,
  sampleRate: 48000,
} as const;

/** Capture profile for plain voice chat: processed, feedback-safe. */
const VOICE_CAPTURE = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
} as const;

const MUSIC_PUBLISH = {
  dtx: false,
  red: false,
  audioPreset: { maxBitrate: 320_000 },
  stopMicTrackOnMute: false,
} as const;

// --- Vocal presets -------------------------------------------------------------
// One-tap "make my voice sound mixed" presets, keyed by the singer's pitch
// range. Each carries two layers:
//   * capture — WebRTC constraints applied on EVERY platform: 'raw' bypasses
//     all processing (instruments/DAW), everything else runs the clean-voice
//     chain (echo cancel + noise suppression + auto-gain = the polished,
//     even, feedback-safe sound).
//   * eq — the pitch-specific EQ + compressor recipe. Applied where real DSP
//     exists today: the web/DAW connector's Web Audio graph (web/studio.html
//     mirrors these numbers). Native publishes the preset key through
//     participant attributes so any DSP-capable surface can honor it.
export type VocalPresetKey = 'raw' | 'natural' | 'low' | 'mid' | 'high';

export type VocalEq = {
  highpassHz: number;
  bands: Array<{ freqHz: number; gainDb: number; q: number }>;
  compressor: { thresholdDb: number; ratio: number; attackS: number; releaseS: number };
  makeupDb: number;
};

export type VocalPreset = {
  key: VocalPresetKey;
  /** Ionicons name for the picker pill. */
  icon: string;
  capture: Record<string, unknown>;
  eq: VocalEq | null;
};

export const VOCAL_PRESETS: VocalPreset[] = [
  // Raw input — instruments, DAWs, interfaces. The old "studio mode".
  { key: 'raw', icon: 'pulse-outline', capture: STUDIO_CAPTURE, eq: null },
  // Clean voice, no tonal shaping.
  { key: 'natural', icon: 'mic-outline', capture: VOICE_CAPTURE, eq: null },
  // Deep voices: clear the mud below the chest register, push presence.
  {
    key: 'low', icon: 'trending-down-outline', capture: VOICE_CAPTURE,
    eq: {
      highpassHz: 70,
      bands: [
        { freqHz: 250, gainDb: -2.5, q: 1.0 },   // de-mud
        { freqHz: 3200, gainDb: 3, q: 1.1 },     // presence / diction
        { freqHz: 9500, gainDb: 1.5, q: 0.8 },   // air
      ],
      compressor: { thresholdDb: -18, ratio: 3, attackS: 0.003, releaseS: 0.25 },
      makeupDb: 3,
    },
  },
  // Mid voices: gentle low-mid tidy, forward presence, open top.
  {
    key: 'mid', icon: 'remove-outline', capture: VOICE_CAPTURE,
    eq: {
      highpassHz: 85,
      bands: [
        { freqHz: 350, gainDb: -2, q: 1.1 },
        { freqHz: 4000, gainDb: 2.5, q: 1.1 },
        { freqHz: 11000, gainDb: 2, q: 0.8 },
      ],
      compressor: { thresholdDb: -18, ratio: 3, attackS: 0.003, releaseS: 0.25 },
      makeupDb: 2.5,
    },
  },
  // High/bright voices: add body, soften harshness, keep the sparkle.
  {
    key: 'high', icon: 'trending-up-outline', capture: VOICE_CAPTURE,
    eq: {
      highpassHz: 100,
      bands: [
        { freqHz: 220, gainDb: 1.5, q: 0.9 },    // warmth / body
        { freqHz: 6500, gainDb: -2, q: 2.0 },    // de-harsh
        { freqHz: 12000, gainDb: 2, q: 0.8 },    // air
      ],
      compressor: { thresholdDb: -20, ratio: 2.5, attackS: 0.004, releaseS: 0.22 },
      makeupDb: 2,
    },
  },
];

export function vocalPreset(key: VocalPresetKey): VocalPreset {
  return VOCAL_PRESETS.find((p) => p.key === key) ?? VOCAL_PRESETS[1];
}

/**
 * Republishes the mic with the preset's capture profile and stamps the choice
 * on participant attributes (so the web connector & future DSP surfaces can
 * apply the matching EQ recipe to what they hear/publish).
 */
export async function applyVocalPreset(room: Room, key: VocalPresetKey): Promise<void> {
  const p = vocalPreset(key);
  await room.localParticipant.setMicrophoneEnabled(false);
  await room.localParticipant.setMicrophoneEnabled(true, p.capture as never, MUSIC_PUBLISH);
  try { await room.localParticipant.setAttributes({ vocalPreset: key }); } catch { /* older server */ }
}

// The RN audio session must be running before any WebRTC audio flows. Guarded
// require so a binary without the livekit natives doesn't crash at import.
async function setAudioSession(on: boolean): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AudioSession } = require('@livekit/react-native');
    if (on) await AudioSession.startAudioSession();
    else await AudioSession.stopAudioSession();
  } catch { /* native module not in this binary yet */ }
}

export async function connectStudioRoom(sessionId: string): Promise<Room> {
  const { data, error } = await supabase.functions.invoke('livekit-token', {
    body: { sessionId },
  });
  if (error || !data?.token) throw new Error(data?.error ?? error?.message ?? 'token failed');

  await setAudioSession(true);
  const room = new (lk().Room)({
    adaptiveStream: false,
    publishDefaults: MUSIC_PUBLISH,
    audioCaptureDefaults: VOICE_CAPTURE,
  });
  await room.connect(data.url, data.token);
  await room.localParticipant.setMicrophoneEnabled(true, VOICE_CAPTURE, MUSIC_PUBLISH);
  return room;
}

export async function disconnectStudioRoom(room: Room): Promise<void> {
  try { await room.disconnect(); } catch { /* already gone */ }
  await setAudioSession(false);
}

/**
 * Tunes in to a LIVE studio broadcast: subscribe-only + hidden, so the
 * musicians' room never even sees the audience. Any signed-in user works —
 * no membership required (the token fn checks the session is live).
 */
export async function connectStudioListener(sessionId: string): Promise<Room> {
  const { data, error } = await supabase.functions.invoke('livekit-token', {
    body: { sessionId, listen: true },
  });
  if (error || !data?.token) throw new Error(data?.error ?? error?.message ?? 'token failed');

  await setAudioSession(true);
  const room = new (lk().Room)({ adaptiveStream: false });
  await room.connect(data.url, data.token);
  return room;
}

// --- Sync count-in --------------------------------------------------------------

/** Host: schedule a synchronized count-in ~3s out for everyone in the room. */
export async function sendCountIn(room: Room, bpm = 120): Promise<CountInMessage> {
  const msg: CountInMessage = {
    t: 'countin',
    startAt: Date.now() + 3000,
    bpm,
    from: room.localParticipant.identity,
  };
  await room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(msg)), { reliable: true });
  return msg;
}

export function onCountIn(room: Room, cb: (msg: CountInMessage) => void): () => void {
  const handler = (payload: Uint8Array) => {
    try {
      const msg = JSON.parse(new TextDecoder().decode(payload));
      if (msg?.t === 'countin' && typeof msg.startAt === 'number') cb(msg as CountInMessage);
    } catch { /* not ours */ }
  };
  room.on(lk().RoomEvent.DataReceived, handler);
  return () => { room.off(lk().RoomEvent.DataReceived, handler); };
}

// --- Live broadcast (the audience side of a session) ---------------------------
// All of this degrades gracefully pre-migration (studio_live.sql): the RPCs
// just error and callers fall back to "not available".

/** Host: start/stop broadcasting this session to listeners. */
export async function setSessionLive(sessionId: string, on: boolean): Promise<boolean> {
  const { error } = await supabase
    .from('studio_sessions')
    .update(on
      ? { live: true, live_started_at: new Date().toISOString() }
      : { live: false })
    .eq('id', sessionId);
  return !error;
}

/** Host: record the broadcast's biggest audience (for the earned screen). */
export async function setListenerPeak(sessionId: string, peak: number): Promise<void> {
  await supabase.from('studio_sessions').update({ listener_peak: peak }).eq('id', sessionId).then(() => {}, () => {});
}

/** Live broadcasts, for the audience rails (RPC — join codes never leave). */
export async function fetchLiveStudioSessions(): Promise<LiveStudioSession[]> {
  try {
    const { data, error } = await supabase.rpc('fetch_live_studio_sessions');
    if (error) return [];
    return (data ?? []).map((r: Record<string, unknown>) => ({
      ...r,
      member_count: Number(r.member_count ?? 0),
    })) as LiveStudioSession[];
  } catch {
    return [];
  }
}

/** Everything the listen screen needs; null once the broadcast has ended. */
export async function fetchStudioListen(sessionId: string): Promise<{
  session: { id: string; title: string | null; host_id: string; live_started_at: string | null };
  roster: StudioMember[];
} | null> {
  try {
    const { data, error } = await supabase.rpc('fetch_studio_listen', { p_session: sessionId });
    if (error || !data) return null;
    return data as never;
  } catch {
    return null;
  }
}

/** Listener: ask to join the session. Resolves to the request's status. */
export async function requestStudioJoin(sessionId: string):
  Promise<'pending' | 'accepted' | 'declined' | 'member' | 'unavailable'> {
  try {
    const { data, error } = await supabase.rpc('request_studio_join', { p_session: sessionId });
    if (error) return 'unavailable';
    return (data as never) ?? 'pending';
  } catch {
    return 'unavailable';
  }
}

/** Host: accept or decline a listener's join request. */
export async function respondStudioJoin(sessionId: string, userId: string, accept: boolean): Promise<boolean> {
  const { error } = await supabase.rpc('respond_studio_join', {
    p_session: sessionId, p_user: userId, p_accept: accept,
  });
  return !error;
}

/** Host: this session's pending join requests, with requester profiles. */
export async function fetchJoinRequests(sessionId: string): Promise<StudioJoinRequest[]> {
  const { data } = await supabase
    .from('studio_join_requests')
    .select('session_id, user_id, status, created_at')
    .eq('session_id', sessionId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  const rows = (data ?? []) as StudioJoinRequest[];
  if (!rows.length) return [];
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url')
    .in('id', rows.map((r) => r.user_id));
  const byId = new Map((profiles ?? []).map((p) => [p.id, p]));
  return rows.map((r) => ({
    ...r,
    username: byId.get(r.user_id)?.username ?? null,
    display_name: byId.get(r.user_id)?.display_name ?? null,
    avatar_url: byId.get(r.user_id)?.avatar_url ?? null,
  }));
}

/** Listener: my request's current status for this session (null = none yet). */
export async function myJoinRequestStatus(sessionId: string):
  Promise<'pending' | 'accepted' | 'declined' | null> {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) return null;
  const { data } = await supabase
    .from('studio_join_requests')
    .select('status')
    .eq('session_id', sessionId)
    .eq('user_id', uid)
    .maybeSingle();
  return (data?.status as never) ?? null;
}
