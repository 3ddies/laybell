import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Image, Share, ActivityIndicator, ScrollView, Switch,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Room } from 'livekit-client';
import SwipeBackPager from '../../components/SwipeBackPager';
import ConfirmDialog from '../../components/ConfirmDialog';
import { GRADIENTS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { useProfile } from '../../contexts/ProfileContext';
import { supabase } from '../../lib/supabase';
import { WEB_ORIGIN } from '../../lib/appLinks';
import { tabTick } from '../../lib/haptics';
import { webrtcAvailable } from '../../lib/whip';
import {
  connectStudioRoom, disconnectStudioRoom, endSession, fetchRoster, fetchSession,
  getRoomEvents, leaveSession, onCountIn, sendCountIn, setStudioMode,
  type StudioMember, type StudioSession,
} from '../../lib/studio';

// A studio session room: LiveKit voice tuned for music (high-bitrate stereo
// Opus, DTX/RED off), with a "studio mode" that strips echo cancellation /
// noise suppression / AGC for raw DAW and instrument signal. The synchronized
// count-in broadcasts a wall-clock start so everyone can punch record in their
// own DAW on the same beat — Laybell as the connector, like Zoom for meetings.

type ConnState = 'connecting' | 'connected' | 'unavailable' | 'error';

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
  const [studioOn, setStudioOn] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [count, setCount] = useState<string | null>(null); // '4'…'1' | 'REC'
  const [, force] = useState(0);
  const roomRef = useRef<Room | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const isHost = !!session && session.host_id === profile?.id;

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

  // Voice connection.
  useEffect(() => {
    if (!id) return;
    if (!webrtcAvailable()) { setConn('unavailable'); return; }
    let alive = true;
    let cleanupCountIn: (() => void) | null = null;
    connectStudioRoom(id)
      .then((room) => {
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

  async function toggleStudio(on: boolean) {
    const room = roomRef.current;
    setStudioOn(on);
    if (!room) return;
    try {
      await setStudioMode(room, on);
      if (muted) await room.localParticipant.setMicrophoneEnabled(false);
    } catch { setStudioOn(!on); }
  }

  function invite() {
    if (!session) return;
    Share.share({
      message: `${t('studio.inviteMsg', { code: session.join_code })}\n${WEB_ORIGIN}/studio.html?code=${session.join_code}`,
    }).catch(() => {});
  }

  async function exit() {
    setConfirmEnd(false);
    if (session) {
      if (isHost) await endSession(session.id).catch(() => {});
      else await leaveSession(session.id).catch(() => {});
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

  return (
    <SwipeBackPager>
      <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => setConfirmEnd(true)} style={styles.headerBtn}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <View style={styles.headerTextWrap}>
            <Text style={styles.headerTitle} numberOfLines={1}>{session?.title || t('studio.untitled')}</Text>
            <Text style={styles.headerSub}>
              {conn === 'connected' ? t('studio.membersIn', { n: Math.max(live.length, roster.length) })
                : conn === 'connecting' ? t('studio.connecting')
                : conn === 'unavailable' ? t('live.rebuildNeeded')
                : t('studio.connectionLost')}
            </Text>
          </View>
          <TouchableOpacity onPress={invite} style={styles.headerBtn}>
            <Ionicons name="person-add-outline" size={20} color={colors.text} />
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.scrollContent}>
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
                      <LinearGradient colors={GRADIENTS.primary} style={styles.tileAvatar}>
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
                      <LinearGradient colors={GRADIENTS.primary} style={styles.tileAvatar}>
                        <Text style={styles.tileInitial}>{(m.display_name || m.username || '?').charAt(0).toUpperCase()}</Text>
                      </LinearGradient>
                    )}
                  </View>
                  <Text style={styles.tileName} numberOfLines={1}>{m.display_name || m.username}</Text>
                  {m.role === 'host' && <Text style={styles.hostTag}>{t('studio.host')}</Text>}
                </View>
              ))}
          </View>

          {/* Studio mode */}
          <View style={styles.settingRow}>
            <View style={styles.settingTextWrap}>
              <Text style={styles.settingTitle}>{t('studio.studioMode')}</Text>
              <Text style={styles.settingSub}>{t('studio.studioModeSub')}</Text>
            </View>
            <Switch
              value={studioOn}
              onValueChange={toggleStudio}
              disabled={conn !== 'connected'}
              trackColor={{ true: colors.primary, false: colors.surfaceLight }}
              thumbColor="#fff"
            />
          </View>
        </ScrollView>

        {/* Controls */}
        <View style={[styles.controls, { paddingBottom: insets.bottom + 14 }]}>
          <TouchableOpacity
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
          <TouchableOpacity style={[styles.controlBtn, styles.leaveBtn]} onPress={() => setConfirmEnd(true)}>
            <Ionicons name="exit-outline" size={22} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* Count-in overlay */}
        {count !== null && (
          <View pointerEvents="none" style={styles.countOverlay}>
            <Text style={[styles.countText, count === 'REC' && { color: '#F43F5E' }]}>{count}</Text>
          </View>
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
  scrollContent: { padding: 16, gap: 14, paddingBottom: 24 },
  codeCard: { backgroundColor: c.surface, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, padding: 14, gap: 10 },
  codeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  codeLabel: { color: c.textSecondary, fontSize: 13, fontWeight: '600' },
  codeValue: { color: c.text, fontSize: 20, fontWeight: '800', letterSpacing: 4 },
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
  settingRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: c.surface, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, padding: 14 },
  settingTextWrap: { flex: 1, gap: 3 },
  settingTitle: { color: c.text, fontSize: 14, fontWeight: '700' },
  settingSub: { color: c.textTertiary, fontSize: 12, lineHeight: 17 },
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
