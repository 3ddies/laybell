import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Image, Share, ActivityIndicator, ScrollView, Switch,
  TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Room } from 'livekit-client';
import SwipeBackPager from '../../components/SwipeBackPager';
import ConfirmDialog from '../../components/ConfirmDialog';
import LiveChatOverlay, { useBufferedChat } from '../../components/LiveChatOverlay';
import LiveDonationAlerts from '../../components/LiveDonationAlerts';
import LiveEarnedOverlay from '../../components/LiveEarnedOverlay';
import { GRADIENTS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { useProfile } from '../../contexts/ProfileContext';
import { supabase } from '../../lib/supabase';
import { STATIC_WEB_ORIGIN } from '../../lib/appLinks';
import { tabTick } from '../../lib/haptics';
import { webrtcAvailable } from '../../lib/whip';
import { displayedTier } from '../../lib/badges';
import { joinStudioChannel, type LiveChannelHandle, type LiveDonationEvent } from '../../lib/live';
import { fetchStudioEarnings } from '../../lib/donations';
import {
  applyVocalPreset, connectStudioRoom, disconnectStudioRoom, endSession, fetchJoinRequests, hostExitSession,
  fetchRoster, fetchSession, getRoomEvents, leaveSession, onCountIn, respondStudioJoin,
  sendCountIn, setListenerPeak, setSessionLive, beatStudioSession, VOCAL_PRESETS,
  type StudioJoinRequest, type StudioMember, type StudioSession, type VocalPresetKey,
} from '../../lib/studio';

// A studio session room: LiveKit voice tuned for music (high-bitrate stereo
// Opus, DTX/RED off), with one-tap VOCAL PRESETS — 'raw' (the old studio mode:
// no processing, for DAWs/instruments) or polished voice chains keyed to the
// singer's pitch range. The synchronized count-in broadcasts a wall-clock
// start so everyone can punch record in their own DAW on the same beat.
//
// The host can also BROADCAST the session to a listener audience ("modern
// radio"): listeners tune in hear-only + hidden (zero impact on the musicians'
// latency/quality), chat + donations ride a Supabase channel exactly like a
// livestream's, and listeners can request a seat — accepted requests join the
// session for real.

type ConnState = 'connecting' | 'connected' | 'unavailable' | 'error';

const PRESET_STORE_KEY = 'studio.vocalPreset';

export default function StudioRoomScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile } = useProfile();

  const [session, setSession] = useState<StudioSession | null>(null);
  const [roster, setRoster] = useState<StudioMember[]>([]);
  const [conn, setConn] = useState<ConnState>('connecting');
  const [muted, setMuted] = useState(false);
  const [preset, setPreset] = useState<VocalPresetKey>('natural');
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [count, setCount] = useState<string | null>(null); // '4'…'1' | 'REC'
  const [, force] = useState(0);
  const roomRef = useRef<Room | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const mutedRef = useRef(false); mutedRef.current = muted;

  // ── Broadcast state ─────────────────────────────────────────────────────────
  const [broadcastBusy, setBroadcastBusy] = useState(false);
  const [listeners, setListeners] = useState(0);
  const [joinReqs, setJoinReqs] = useState<StudioJoinRequest[]>([]);
  const [donationEvent, setDonationEvent] = useState<LiveDonationEvent | null>(null);
  const [earned, setEarned] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const { messages: chat, push: pushChat } = useBufferedChat();
  const channelRef = useRef<LiveChannelHandle | null>(null);
  const listenerPeakRef = useRef(0);

  const isHost = !!session && session.host_id === profile?.id;
  const isLive = !!session?.live;

  const loadMeta = useCallback(async () => {
    if (!id) return;
    const [s, r] = await Promise.all([fetchSession(id), fetchRoster(id)]);
    setSession(s);
    setRoster(r);
  }, [id]);

  // Roster + session metadata, kept fresh over realtime.
  useEffect(() => {
    loadMeta();
    if (!id) return;
    const channel = supabase
      .channel(`studio:${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'studio_session_members', filter: `session_id=eq.${id}` }, () => loadMeta())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'studio_sessions', filter: `id=eq.${id}` }, () => loadMeta())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [id, loadMeta]);

  // Check in every 15s so the server-side reaper knows this room is real.
  // supabase/sql/live_ghost_sweeper.sql ends anything that stops pinging — that
  // sweep is the only cleanup that survives a force-quit, a crash or a dead
  // battery, none of which ever reach a leave handler. Beat immediately as well
  // as on the interval, so the room is covered from its first second.
  useEffect(() => {
    if (!id) return;
    beatStudioSession(id);
    const iv = setInterval(() => beatStudioSession(id), 15_000);
    return () => clearInterval(iv);
  }, [id]);

  // Voice connection.
  useEffect(() => {
    if (!id) return;
    if (!webrtcAvailable()) { setConn('unavailable'); return; }
    let alive = true;
    let cleanupCountIn: (() => void) | null = null;
    connectStudioRoom(id)
      .then(async (room) => {
        if (!alive) { disconnectStudioRoom(room); return; }
        roomRef.current = room;
        const update = () => force((n) => n + 1);
        const RoomEvent = getRoomEvents();
        room
          .on(RoomEvent.ParticipantConnected, update)
          .on(RoomEvent.ParticipantDisconnected, update)
          .on(RoomEvent.ActiveSpeakersChanged, update)
          .on(RoomEvent.TrackMuted, update)
          .on(RoomEvent.TrackUnmuted, update)
          .on(RoomEvent.TrackSubscribed, update)
          .on(RoomEvent.Disconnected, () => { if (alive) setConn('error'); });
        cleanupCountIn = onCountIn(room, runCountIn);
        setConn('connected');
        // Restore the artist's last vocal preset (persisted across sessions).
        try {
          const stored = (await AsyncStorage.getItem(PRESET_STORE_KEY)) as VocalPresetKey | null;
          if (alive && stored && stored !== 'natural' && VOCAL_PRESETS.some((p) => p.key === stored)) {
            setPreset(stored);
            await applyVocalPreset(room, stored);
            if (mutedRef.current) await room.localParticipant.setMicrophoneEnabled(false);
          }
        } catch { /* keep natural */ }
      })
      .catch(() => { if (alive) setConn('error'); });
    return () => {
      alive = false;
      cleanupCountIn?.();
      const room = roomRef.current;
      roomRef.current = null;
      if (room) disconnectStudioRoom(room);
      timersRef.current.forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ── Audience channel (chat + donations + listener count) ────────────────────
  // Every session member joins while the broadcast is live — as 'host' so the
  // presence count stays listeners-only (musicians aren't their own audience).
  useEffect(() => {
    if (!isLive || !id || !profile?.id) return;
    const handle = joinStudioChannel(id, {
      userId: profile.id,
      name: profile.display_name || profile.username || 'Artist',
      username: profile.username ?? null,
      avatarUrl: profile.avatar_url ?? null,
      tier: displayedTier(profile),
      isHost: true,
      onViewers: (n) => {
        listenerPeakRef.current = Math.max(listenerPeakRef.current, n);
        setListeners(n);
      },
      onChat: pushChat,
      onDonation: setDonationEvent,
    });
    channelRef.current = handle;
    return () => { handle.leave(); channelRef.current = null; setListeners(0); };
  }, [isLive, id, profile?.id, profile?.display_name, profile?.username, profile?.avatar_url, pushChat]);

  // ── Join requests (host only, while live) ───────────────────────────────────
  useEffect(() => {
    if (!isLive || !isHost || !id) return;
    let alive = true;
    const load = () => fetchJoinRequests(id).then((r) => { if (alive) setJoinReqs(r); }).catch(() => {});
    load();
    const channel = supabase
      .channel(`studio-reqs:${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'studio_join_requests', filter: `session_id=eq.${id}` }, load)
      .subscribe();
    // POLL AS WELL, deliberately. This screen used to depend on the realtime
    // subscription alone, and studio_join_requests was never added to the
    // `supabase_realtime` publication — so no change event has ever been
    // delivered and a raised hand was invisible unless the host happened to
    // re-open the screen afterwards. supabase/sql/studio_join_requests_realtime.sql
    // fixes the publication, but a feature this visible should not be one
    // dashboard toggle away from silently doing nothing, on any environment.
    // Cheap: one indexed read of the pending rows for this session, and only
    // while the host is actually live.
    const poll = setInterval(load, 8000);
    return () => { alive = false; clearInterval(poll); supabase.removeChannel(channel); };
  }, [isLive, isHost, id]);

  // Runs the 4-beat visual/haptic count-in ending exactly at msg.startAt.
  function runCountIn(msg: { startAt: number; bpm: number }) {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    const beatMs = 60000 / Math.max(40, Math.min(240, msg.bpm));
    for (let beat = 4; beat >= 1; beat--) {
      const at = msg.startAt - beat * beatMs - Date.now();
      if (at < 0) continue;
      timersRef.current.push(setTimeout(() => { setCount(String(beat)); tabTick(); }, at));
    }
    const recIn = msg.startAt - Date.now();
    if (recIn >= 0) {
      timersRef.current.push(setTimeout(() => { setCount('REC'); tabTick(); }, recIn));
      timersRef.current.push(setTimeout(() => setCount(null), recIn + 1800));
    }
  }

  async function toggleMute() {
    const room = roomRef.current;
    if (!room) return;
    const next = !muted;
    setMuted(next);
    await room.localParticipant.setMicrophoneEnabled(!next).catch(() => setMuted(!next));
  }

  async function pickPreset(key: VocalPresetKey) {
    if (key === preset) return;
    const room = roomRef.current;
    const prev = preset;
    setPreset(key);
    AsyncStorage.setItem(PRESET_STORE_KEY, key).catch(() => {});
    if (!room) return;
    try {
      await applyVocalPreset(room, key);
      if (mutedRef.current) await room.localParticipant.setMicrophoneEnabled(false);
    } catch { setPreset(prev); }
  }

  // ── Broadcast toggle (host) ─────────────────────────────────────────────────
  async function toggleBroadcast(on: boolean) {
    if (!session || broadcastBusy) return;
    setBroadcastBusy(true);
    try {
      if (on) {
        listenerPeakRef.current = 0;
        const ok = await setSessionLive(session.id, true);
        if (ok) setSession({ ...session, live: true });
      } else {
        await stopBroadcast(true);
      }
    } finally {
      setBroadcastBusy(false);
    }
  }

  // Ends the broadcast: tells the audience, flips the flag, records the peak,
  // and (optionally) rolls the earned celebration.
  async function stopBroadcast(celebrate: boolean) {
    if (!session) return;
    channelRef.current?.sendEnded();
    await setSessionLive(session.id, false);
    setListenerPeak(session.id, listenerPeakRef.current).catch(() => {});
    setSession({ ...session, live: false });
    setJoinReqs([]);
    if (celebrate) {
      const cents = await fetchStudioEarnings(session.id).catch(() => 0);
      if (cents > 0) setEarned(cents);
    }
  }

  async function respondReq(userId: string, accept: boolean) {
    if (!session) return;
    setJoinReqs((q) => q.filter((r) => r.user_id !== userId));
    const ok = await respondStudioJoin(session.id, userId, accept);
    if (!ok) fetchJoinRequests(session.id).then(setJoinReqs).catch(() => {});
  }

  function sendChat() {
    const text = draft.trim();
    if (!text || !channelRef.current) return;
    setDraft('');
    channelRef.current.sendChat(text);
  }

  function invite() {
    if (!session) return;
    // STATIC_WEB_ORIGIN (GitHub Pages), not laybell.app: the GoDaddy builder
    // can't host web/ files, so studio.html 404s there until the custom domain
    // is mapped onto Pages (go-live checklist) — same rule as QR/share links.
    Share.share({
      message: `${t('studio.inviteMsg', { code: session.join_code })}\n${STATIC_WEB_ORIGIN}/studio.html?code=${session.join_code}`,
    }).catch(() => {});
  }

  async function exit() {
    setConfirmEnd(false);
    if (session) {
      if (isHost) {
        // The broadcast always stops first — a host must never walk away from a
        // session that is still on air (the RPC enforces this server-side too).
        if (isLive) await stopBroadcast(false).catch(() => {});
        // Then hand the room to the earliest remaining member instead of killing
        // it under them; it only ends if the host is the last one out. A null
        // result means the RPC isn't deployed yet — fall back to the old
        // always-end behaviour rather than leaving an ownerless open room.
        const outcome = await hostExitSession(session.id).catch(() => null);
        if (outcome === null) await endSession(session.id).catch(() => {});
      } else {
        await leaveSession(session.id).catch(() => {});
      }
    }
    router.back();
  }

  // Live participants come from LiveKit (who's actually connected — including
  // web/DAW guests); avatars come from the roster.
  const room = roomRef.current;
  const live = room
    ? [room.localParticipant, ...room.remoteParticipants.values()]
    : [];
  const byId = new Map(roster.map((m) => [m.user_id, m]));
  const selected = VOCAL_PRESETS.find((p) => p.key === preset) ?? VOCAL_PRESETS[1];

  return (
    <SwipeBackPager>
      <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} onPress={() => setConfirmEnd(true)} style={styles.headerBtn}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <View style={styles.headerTextWrap}>
            <Text style={styles.headerTitle} numberOfLines={1}>{session?.title || t('studio.untitled')}</Text>
            <Text style={styles.headerSub}>
              {conn === 'connected' ? t('studio.membersIn', { n: Math.max(live.length, roster.length) })
                : conn === 'connecting' ? t('studio.connecting')
                : conn === 'unavailable' ? t('live.rebuildNeeded')
                : t('studio.connectionLost')}
              {isLive ? `  ·  ${t('studio.listenersIn', { n: listeners })}` : ''}
            </Text>
          </View>
          {isLive && (
            <View style={styles.liveBadge}>
              <View style={styles.liveDot} />
              <Text style={styles.liveBadgeText}>{t('studio.onAir')}</Text>
            </View>
          )}
          <TouchableOpacity onPress={invite} style={styles.headerBtn} accessibilityRole="button" accessibilityLabel={t('a11y.addPeople')}>
            <Ionicons name="person-add-outline" size={20} color={colors.text} />
          </TouchableOpacity>
        </View>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
        {/* iOS had no way to close the studio chat keyboard short of sending:
            keyboardShouldPersistTaps="handled" only dismisses on taps that land
            on the ScrollView ITSELF, and this content doesn't fill the screen,
            so most taps hit nothing at all. flexGrow makes the scroll surface
            cover the viewport so those taps register, and on-drag dismisses when
            scrolling. Android already got this from the OS back gesture. */}
        <ScrollView
          contentContainerStyle={[styles.scrollContent, { flexGrow: 1 }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {/* Join code + DAW connector hint */}
          <View style={styles.codeCard}>
            <View style={styles.codeRow}>
              <Text style={styles.codeLabel}>{t('studio.codeTitle')}</Text>
              <Text style={styles.codeValue} selectable>{session?.join_code ?? '——————'}</Text>
            </View>
            <View style={styles.dawRow}>
              <Ionicons name="laptop-outline" size={17} color={colors.textSecondary} />
              <Text style={styles.dawText}>{t('studio.connectDawSub')}</Text>
            </View>
            <View style={styles.dawRow}>
              <Ionicons name="hardware-chip-outline" size={17} color={colors.textSecondary} />
              <Text style={styles.dawText}>{t('studio.proGearSub')}</Text>
            </View>
          </View>

          {/* The card above is for whoever is running the session — the code, the
              DAW, the interface. This one is for whoever is holding the mic, who
              had no guidance at all. Headphones lead because that mistake is the
              loudest: without them the beat re-enters the mic and everyone in the
              room hears the echo, and the artist is the last to notice. */}
          <View style={styles.codeCard}>
            <Text style={styles.artistTitle}>{t('studio.artistTitle')}</Text>
            <View style={styles.dawRow}>
              <Ionicons name="headset-outline" size={17} color={colors.textSecondary} />
              <Text style={styles.dawText}>{t('studio.artistHeadphones')}</Text>
            </View>
            <View style={styles.dawRow}>
              <Ionicons name="timer-outline" size={17} color={colors.textSecondary} />
              <Text style={styles.dawText}>{t('studio.artistCountIn')}</Text>
            </View>
            <View style={styles.dawRow}>
              <Ionicons name="mic-off-outline" size={17} color={colors.textSecondary} />
              <Text style={styles.dawText}>{t('studio.artistMute')}</Text>
            </View>
          </View>

          {/* Participants */}
          <View style={styles.grid}>
            {conn === 'connecting' && <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />}
            {(conn === 'connected' ? live : []).map((p) => {
              const member = byId.get(p.identity);
              const name = p.isLocal
                ? t('studio.you')
                : member?.display_name || member?.username || p.name || t('studio.guest');
              const speaking = p.isSpeaking;
              const micOff = p.isLocal ? muted : p.isMicrophoneEnabled === false;
              const isGuest = !member && !p.isLocal;
              return (
                <View key={p.identity} style={styles.tile}>
                  <View style={[styles.tileAvatarWrap, speaking && { borderColor: colors.primary }]}>
                    {member?.avatar_url ? (
                      <Image source={{ uri: member.avatar_url }} style={styles.tileAvatar} />
                    ) : (
                      <LinearGradient colors={GRADIENTS.avatar} style={styles.tileAvatar}>
                        {isGuest
                          ? <Ionicons name="laptop-outline" size={22} color="#fff" />
                          : <Text style={styles.tileInitial}>{name.charAt(0).toUpperCase()}</Text>}
                      </LinearGradient>
                    )}
                    {micOff && (
                      <View style={styles.micOffBadge}>
                        <Ionicons name="mic-off" size={11} color="#fff" />
                      </View>
                    )}
                  </View>
                  <Text style={styles.tileName} numberOfLines={1}>{name}</Text>
                  {member?.role === 'host' && <Text style={styles.hostTag}>{t('studio.host')}</Text>}
                </View>
              );
            })}
            {/* Members not yet connected to audio */}
            {conn !== 'connecting' && roster
              .filter((m) => !live.some((p) => p.identity === m.user_id))
              .map((m) => (
                <View key={m.user_id} style={[styles.tile, { opacity: 0.45 }]}>
                  <View style={styles.tileAvatarWrap}>
                    {m.avatar_url ? (
                      <Image source={{ uri: m.avatar_url }} style={styles.tileAvatar} />
                    ) : (
                      <LinearGradient colors={GRADIENTS.avatar} style={styles.tileAvatar}>
                        <Text style={styles.tileInitial}>{(m.display_name || m.username || '?').charAt(0).toUpperCase()}</Text>
                      </LinearGradient>
                    )}
                  </View>
                  <Text style={styles.tileName} numberOfLines={1}>{m.display_name || m.username}</Text>
                  {m.role === 'host' && <Text style={styles.hostTag}>{t('studio.host')}</Text>}
                </View>
              ))}
          </View>

          {/* Vocal preset — one tap from raw signal to a mixed, polished voice */}
          <View style={styles.presetCard}>
            <Text style={styles.settingTitle}>{t('studio.voicePreset')}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.presetRow}>
              {VOCAL_PRESETS.map((p) => {
                const on = p.key === preset;
                return (
                  <TouchableOpacity
                    key={p.key}
                    style={[styles.presetPill, on && styles.presetPillOn]}
                    onPress={() => pickPreset(p.key)}
                    disabled={conn !== 'connected'}
                    activeOpacity={0.8}
                  >
                    <Ionicons name={p.icon as never} size={14} color={on ? '#fff' : colors.textSecondary} />
                    <Text style={[styles.presetPillText, on && styles.presetPillTextOn]}>
                      {t(`studio.preset.${p.key}`)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <Text style={styles.settingSub}>{t(`studio.preset.${selected.key}Sub`)}</Text>
          </View>

          {/* Broadcast to listeners (host controls; members see the state) */}
          {isHost && (
            <View style={styles.settingColumn}>
              <View style={styles.settingRowInner}>
                <View style={styles.settingTextWrap}>
                  <Text style={styles.settingTitle}>{t('studio.broadcast')}</Text>
                  <Text style={styles.settingSub}>{t('studio.broadcastSub')}</Text>
                </View>
                {broadcastBusy
                  ? <ActivityIndicator color={colors.primary} />
                  : (
                    <Switch
                      value={isLive}
                      onValueChange={toggleBroadcast}
                      disabled={conn !== 'connected'}
                      trackColor={{ true: colors.primary, false: colors.surfaceLight }}
                      thumbColor="#fff"
                    />
                  )}
              </View>

              {/* Pending join requests */}
              {isLive && joinReqs.map((r) => (
                <View key={r.user_id} style={styles.reqRow}>
                  {r.avatar_url ? (
                    <Image source={{ uri: r.avatar_url }} style={styles.reqAvatar} />
                  ) : (
                    <LinearGradient colors={GRADIENTS.avatar} style={styles.reqAvatar}>
                      <Text style={styles.reqInitial}>{(r.display_name || r.username || '?').charAt(0).toUpperCase()}</Text>
                    </LinearGradient>
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={styles.reqName} numberOfLines={1}>{r.display_name || r.username || '—'}</Text>
                    <Text style={styles.reqSub}>{t('studio.wantsToJoin')}</Text>
                  </View>
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.confirm')} style={styles.reqAccept} onPress={() => respondReq(r.user_id, true)}>
                    <Ionicons name="checkmark" size={18} color="#fff" />
                  </TouchableOpacity>
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.close')} style={styles.reqDecline} onPress={() => respondReq(r.user_id, false)}>
                    <Ionicons name="close" size={18} color={colors.text} />
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}

          {/* Audience chat — visible to every musician while on air */}
          {isLive && (
            <View style={styles.chatCard}>
              <View style={styles.chatHeader}>
                <Ionicons name="chatbubble-ellipses-outline" size={15} color={colors.textSecondary} />
                <Text style={styles.chatTitle}>{t('studio.audienceChat')}</Text>
                <Text style={styles.chatCount}>{t('studio.listenersIn', { n: listeners })}</Text>
              </View>
              {chat.length === 0
                ? <Text style={styles.chatEmpty}>{t('studio.chatEmpty')}</Text>
                : <LiveChatOverlay messages={chat} maxHeight={180} onPressName={(m) => router.push(`/profile/${m.userId}`)} />}
              <View style={styles.chatInputRow}>
                <TextInput
                  style={styles.chatInput}
                  placeholder={t('live.chatPlaceholder')}
                  placeholderTextColor={colors.textTertiary}
                  value={draft}
                  onChangeText={setDraft}
                  maxLength={300}
                  onSubmitEditing={sendChat}
                  returnKeyType="send"
                />
                <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.send')}
                  onPress={sendChat}
                  disabled={!draft.trim()}
                  style={[styles.chatSend, !draft.trim() && { opacity: 0.4 }]}
                >
                  <Ionicons name="arrow-up" size={18} color="#fff" />
                </TouchableOpacity>
              </View>
            </View>
          )}
        </ScrollView>
        </KeyboardAvoidingView>

        {/* Controls */}
        <View style={[styles.controls, { paddingBottom: insets.bottom + 14 }]}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={muted ? t('a11y.unmuteMic') : t('a11y.muteMic')}
            style={[styles.controlBtn, muted && styles.controlBtnActive]}
            onPress={toggleMute}
            disabled={conn !== 'connected'}
          >
            <Ionicons name={muted ? 'mic-off' : 'mic'} size={22} color={muted ? '#fff' : colors.text} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.countInBtn}
            onPress={() => { const r = roomRef.current; if (r) { sendCountIn(r).then(runCountIn).catch(() => {}); } }}
            disabled={conn !== 'connected'}
            activeOpacity={0.85}
          >
            <LinearGradient colors={GRADIENTS.primary} style={styles.countInBg}>
              <Ionicons name="timer-outline" size={18} color="#fff" />
              <Text style={styles.countInText}>{t('studio.countIn')}</Text>
            </LinearGradient>
          </TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.leave')} style={[styles.controlBtn, styles.leaveBtn]} onPress={() => setConfirmEnd(true)}>
            <Ionicons name="exit-outline" size={22} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* Donation alerts ride over everything while on air */}
        <LiveDonationAlerts event={donationEvent} topOffset={insets.top + 54} />

        {/* Count-in overlay */}
        {count !== null && (
          <View pointerEvents="none" style={styles.countOverlay}>
            <Text style={[styles.countText, count === 'REC' && { color: '#F43F5E' }]}>{count}</Text>
          </View>
        )}

        {/* Post-broadcast "You Earned $X" */}
        {earned !== null && (
          <LiveEarnedOverlay
            amountCents={earned}
            onCashOut={() => { setEarned(null); router.push('/wallet'); }}
            onDone={() => setEarned(null)}
          />
        )}

        <ConfirmDialog
          visible={confirmEnd}
          title={isHost ? t('studio.confirmEndTitle') : t('studio.confirmLeaveTitle')}
          message={isHost ? t('studio.confirmEndMsg') : undefined}
          confirmLabel={isHost ? t('studio.end') : t('studio.leave')}
          cancelLabel={t('common.cancel')}
          destructive
          onConfirm={exit}
          onCancel={() => setConfirmEnd(false)}
        />
      </View>
    </SwipeBackPager>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.background },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, gap: 6 },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTextWrap: { flex: 1, gap: 1 },
  headerTitle: { color: c.text, fontSize: 16, fontWeight: '700' },
  headerSub: { color: c.textTertiary, fontSize: 12 },
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#F43F5E', borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4 },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff' },
  liveBadgeText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  scrollContent: { padding: 16, gap: 14, paddingBottom: 24 },
  codeCard: { backgroundColor: c.surface, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, padding: 14, gap: 10 },
  codeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  codeLabel: { color: c.textSecondary, fontSize: 13, fontWeight: '600' },
  codeValue: { color: c.text, fontSize: 20, fontWeight: '800', letterSpacing: 4 },
  // Titles this card, since it sits directly under the code card and would
  // otherwise read as more of the same producer setup.
  artistTitle: { color: c.text, fontSize: 13, fontWeight: '700', letterSpacing: -0.1 },
  dawRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  dawText: { flex: 1, color: c.textTertiary, fontSize: 12, lineHeight: 17 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, justifyContent: 'center', paddingVertical: 8 },
  tile: { width: 86, alignItems: 'center', gap: 6 },
  tileAvatarWrap: { width: 68, height: 68, borderRadius: 34, borderWidth: 2.5, borderColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  tileAvatar: { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  tileInitial: { color: '#fff', fontSize: 22, fontWeight: '700' },
  micOffBadge: { position: 'absolute', bottom: 2, right: 2, width: 20, height: 20, borderRadius: 10, backgroundColor: '#F43F5E', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: c.background },
  tileName: { color: c.text, fontSize: 12, fontWeight: '600', maxWidth: 84 },
  hostTag: { color: c.textTertiary, fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  presetCard: { backgroundColor: c.surface, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, padding: 14, gap: 10 },
  presetRow: { gap: 8 },
  presetPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderRadius: 999, borderWidth: 1, borderColor: c.border,
    paddingHorizontal: 13, paddingVertical: 8, backgroundColor: c.surfaceLight,
  },
  presetPillOn: { backgroundColor: c.primary, borderColor: c.primary },
  presetPillText: { color: c.textSecondary, fontSize: 13, fontWeight: '700' },
  presetPillTextOn: { color: '#fff' },
  settingColumn: { backgroundColor: c.surface, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, padding: 14, gap: 12 },
  settingRowInner: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  settingTextWrap: { flex: 1, gap: 3 },
  settingTitle: { color: c.text, fontSize: 14, fontWeight: '700' },
  settingSub: { color: c.textTertiary, fontSize: 12, lineHeight: 17 },
  reqRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, paddingTop: 12 },
  reqAvatar: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  reqInitial: { color: '#fff', fontSize: 15, fontWeight: '700' },
  reqName: { color: c.text, fontSize: 13, fontWeight: '700' },
  reqSub: { color: c.textTertiary, fontSize: 11 },
  reqAccept: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#22C55E', alignItems: 'center', justifyContent: 'center' },
  reqDecline: { width: 36, height: 36, borderRadius: 18, backgroundColor: c.surfaceLight, alignItems: 'center', justifyContent: 'center' },
  chatCard: { backgroundColor: c.surface, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, padding: 14, gap: 10 },
  chatHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  chatTitle: { color: c.text, fontSize: 14, fontWeight: '700', flex: 1 },
  chatCount: { color: c.textTertiary, fontSize: 12 },
  chatEmpty: { color: c.textTertiary, fontSize: 12, fontStyle: 'italic' },
  chatInputRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chatInput: { flex: 1, backgroundColor: c.surfaceLight, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9, color: c.text, fontSize: 14 },
  chatSend: { width: 38, height: 38, borderRadius: 19, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, paddingHorizontal: 16, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
  controlBtn: { width: 52, height: 52, borderRadius: 26, backgroundColor: c.surfaceLight, alignItems: 'center', justifyContent: 'center' },
  controlBtnActive: { backgroundColor: '#F43F5E' },
  leaveBtn: { backgroundColor: '#F43F5E' },
  countInBtn: { borderRadius: 26, overflow: 'hidden' },
  countInBg: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 22, paddingVertical: 15 },
  countInText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  countOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.35)' },
  countText: { color: '#fff', fontSize: 120, fontWeight: '900' },
});
