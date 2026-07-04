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
  const { data } = await supabase
    .from('studio_sessions')
    .select('id, host_id, title, join_code, status, created_at')
    .eq('id', sessionId)
    .maybeSingle();
  return (data as StudioSession) ?? null;
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
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .eq('id', sessionId);
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

/** Republishes the mic with (or without) voice processing. */
export async function setStudioMode(room: Room, studio: boolean): Promise<void> {
  await room.localParticipant.setMicrophoneEnabled(false);
  await room.localParticipant.setMicrophoneEnabled(
    true,
    studio ? STUDIO_CAPTURE : VOICE_CAPTURE,
    MUSIC_PUBLISH,
  );
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
