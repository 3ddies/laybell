import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Image, TextInput, ActivityIndicator,
  KeyboardAvoidingView, Platform, Keyboard, TouchableWithoutFeedback,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Room } from 'livekit-client';
import SwipeBackPager from '../../../components/SwipeBackPager';
import LiveChatOverlay, { useBufferedChat } from '../../../components/LiveChatOverlay';
import LiveDonateModal from '../../../components/LiveDonateModal';
import LiveDonationAlerts from '../../../components/LiveDonationAlerts';
import { GRADIENTS, type ThemePalette } from '../../../constants/theme';
import { useTheme, useThemedStyles } from '../../../contexts/ThemeContext';
import { useTranslation } from '../../../contexts/LanguageContext';
import { useProfile } from '../../../contexts/ProfileContext';
import { supabase } from '../../../lib/supabase';
import { webrtcAvailable } from '../../../lib/whip';
import { displayedTier } from '../../../lib/badges';
import { joinStudioChannel, type LiveChannelHandle, type LiveDonationEvent, type LiveProfile } from '../../../lib/live';
import {
  connectStudioListener, disconnectStudioRoom, fetchStudioListen, getRoomEvents,
  myJoinRequestStatus, requestStudioJoin, type StudioMember,
} from '../../../lib/studio';

// Tune in to a LIVE studio broadcast — modern radio. The listener subscribes
// hear-only + hidden (the musicians' room never even sees the audience, so
// their latency/quality is untouched no matter how many people listen).
// Comments, donations and the listener count ride the same channel machinery
// as a livestream's; "request to join" can upgrade a listener into the
// session itself once the host accepts.

type Phase = 'connecting' | 'live' | 'ended' | 'unavailable' | 'error';
type ReqState = 'none' | 'pending' | 'declined' | 'busy';

export default function StudioListenScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile } = useProfile();

  const [phase, setPhase] = useState<Phase>('connecting');
  const [title, setTitle] = useState<string | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [hostProfile, setHostProfile] = useState<LiveProfile | null>(null);
  const [roster, setRoster] = useState<StudioMember[]>([]);
  const [listeners, setListeners] = useState(0);
  const [reqState, setReqState] = useState<ReqState>('none');
  const [donateOpen, setDonateOpen] = useState(false);
  const [donationEvent, setDonationEvent] = useState<LiveDonationEvent | null>(null);
  const [draft, setDraft] = useState('');
  const { messages: chat, push: pushChat } = useBufferedChat();
  const [, force] = useState(0);
  const roomRef = useRef<Room | null>(null);
  const channelRef = useRef<LiveChannelHandle | null>(null);
  const endedRef = useRef(false);

  const markEnded = useCallback(() => {
    if (endedRef.current) return;
    endedRef.current = true;
    setPhase('ended');
  }, []);

  // Session metadata + roster (RPC — safe columns only), with a slow poll as
  // the ended-fallback: listeners have no RLS view of the session row, so the
  // channel's 'ended' broadcast is primary and this poll catches a host whose
  // app died before sending it.
  const loadMeta = useCallback(async () => {
    if (!id) return;
    const data = await fetchStudioListen(id);
    if (!data) { markEnded(); return; }
    setTitle(data.session.title);
    setHostId(data.session.host_id);
    setRoster(data.roster);
  }, [id, markEnded]);

  useEffect(() => {
    loadMeta();
    const iv = setInterval(loadMeta, 25000);
    return () => clearInterval(iv);
  }, [loadMeta]);

  // Host profile (fee display for donations + the header line).
  useEffect(() => {
    if (!hostId) return;
    supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, premium_until')
      .eq('id', hostId)
      .maybeSingle()
      .then(({ data }) => { if (data) setHostProfile(data as LiveProfile); });
  }, [hostId]);

  // My standing join request (e.g. re-opening the screen while pending).
  useEffect(() => {
    if (!id) return;
    myJoinRequestStatus(id).then((s) => {
      if (s === 'pending') setReqState('pending');
      else if (s === 'declined') setReqState('declined');
    });
  }, [id]);

  // Hear-only LiveKit connection.
  useEffect(() => {
    if (!id) return;
    if (!webrtcAvailable()) { setPhase('unavailable'); return; }
    let alive = true;
    connectStudioListener(id)
      .then((room) => {
        if (!alive) { disconnectStudioRoom(room); return; }
        roomRef.current = room;
        const update = () => force((n) => n + 1);
        const RoomEvent = getRoomEvents();
        room
          .on(RoomEvent.ActiveSpeakersChanged, update)
          .on(RoomEvent.ParticipantConnected, update)
          .on(RoomEvent.ParticipantDisconnected, update)
          .on(RoomEvent.Disconnected, () => {
            // Could be the broadcast ending or a network drop — the RPC decides.
            if (alive) fetchStudioListen(id).then((d) => { if (!d) markEnded(); else setPhase('error'); });
          });
        setPhase('live');
      })
      .catch(() => { if (alive) fetchStudioListen(id).then((d) => { if (!d) markEnded(); else setPhase('error'); }); });
    return () => {
      alive = false;
      const room = roomRef.current;
      roomRef.current = null;
      if (room) disconnectStudioRoom(room);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Audience channel: chat + donations + the listener count + the end signal.
  useEffect(() => {
    if (!id || !profile?.id) return;
    const handle = joinStudioChannel(id, {
      userId: profile.id,
      name: profile.display_name || profile.username || 'Listener',
      username: profile.username ?? null,
      avatarUrl: profile.avatar_url ?? null,
      tier: displayedTier(profile),
      onViewers: setListeners,
      onChat: pushChat,
      onDonation: setDonationEvent,
      onEnded: markEnded,
    });
    channelRef.current = handle;
    return () => { handle.leave(); channelRef.current = null; };
  }, [id, profile?.id, profile?.display_name, profile?.username, profile?.avatar_url, pushChat, markEnded]);

  // Accepted → I'm a member now: hop into the session for real.
  useEffect(() => {
    if (!id || !profile?.id || reqState !== 'pending') return;
    const channel = supabase
      .channel(`studio-myreq:${id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'studio_join_requests', filter: `session_id=eq.${id}` }, (payload: any) => {
        if (payload?.new?.user_id !== profile.id) return;
        if (payload.new.status === 'accepted') router.replace(`/studio/${id}`);
        else if (payload.new.status === 'declined') setReqState('declined');
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [id, profile?.id, reqState, router]);

  // Raising a hand is RE-SENDABLE. A host mid-take misses requests, and a
  // decline is usually "not right now" rather than "never" — leaving the button
  // dead after either one stranded the listener with no way back in. Only an
  // in-flight call blocks a press; pending and declined can both be pressed
  // again to ask afresh.
  async function onRequestJoin() {
    if (!id || reqState === 'busy') return;
    setReqState('busy');
    const res = await requestStudioJoin(id);
    if (res === 'member' || res === 'accepted') { router.replace(`/studio/${id}`); return; }
    setReqState(res === 'pending' ? 'pending' : res === 'declined' ? 'declined' : 'none');
  }

  function sendChat() {
    const text = draft.trim();
    if (!text || !channelRef.current) return;
    setDraft('');
    channelRef.current.sendChat(text);
  }

  const hostName = hostProfile?.display_name || hostProfile?.username || '';
  const room = roomRef.current;
  const speakingIds = new Set(
    room ? [...room.remoteParticipants.values()].filter((p) => p.isSpeaking).map((p) => p.identity) : [],
  );

  return (
    <SwipeBackPager>
      <View style={styles.root}>
        <LinearGradient colors={['#17120C', '#0B0908', '#000']} style={StyleSheet.absoluteFill} />

        {/* Header */}
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} onPress={() => router.back()} style={styles.headerBtn}>
            <Ionicons name="chevron-back" size={24} color="#fff" />
          </TouchableOpacity>
          <View style={styles.liveBadge}>
            <View style={styles.liveDot} />
            <Text style={styles.liveBadgeText}>{t('studio.liveStudio')}</Text>
          </View>
          <View style={styles.listenerPill}>
            <Ionicons name="headset-outline" size={13} color="#fff" />
            <Text style={styles.listenerPillText}>{listeners}</Text>
          </View>
        </View>

        {phase === 'connecting' && (
          <View style={styles.center}><ActivityIndicator color={colors.primary} size="large" /></View>
        )}

        {(phase === 'unavailable' || phase === 'error') && (
          <View style={styles.center}>
            <Ionicons name="cloud-offline-outline" size={40} color="rgba(255,255,255,0.5)" />
            <Text style={styles.stateText}>
              {phase === 'unavailable' ? t('live.rebuildNeeded') : t('studio.connectionLost')}
            </Text>
          </View>
        )}

        {phase === 'ended' && (
          <View style={styles.center}>
            <Ionicons name="radio-outline" size={44} color="rgba(255,255,255,0.5)" />
            <Text style={styles.endedTitle}>{t('studio.broadcastEnded')}</Text>
            <TouchableOpacity style={styles.endedBtn} onPress={() => router.back()} activeOpacity={0.85}>
              <Text style={styles.endedBtnText}>{t('studio.leave')}</Text>
            </TouchableOpacity>
          </View>
        )}

        {phase === 'live' && (
          <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
          {/* Tap anywhere outside the chat field to dismiss the keyboard. There
              is no ScrollView on this screen, so nothing was doing it: Android
              gets it from the OS back gesture, iOS had no way out at all short
              of sending a message. accessible={false} keeps this off the a11y
              tree, and it only responds to taps no child claimed, so every
              button below still works. */}
          <TouchableWithoutFeedback accessible={false} onPress={Keyboard.dismiss}>
          <View style={{ flex: 1 }}>
            {/* Session identity */}
            <View style={styles.meta}>
              <Text style={styles.title} numberOfLines={2}>{title || t('studio.untitled')}</Text>
              {!!hostName && <Text style={styles.hostLine}>{t('studio.hostedBy', { name: hostName })}</Text>}
            </View>

            {/* On-air artists */}
            <View style={styles.grid}>
              {roster.map((m) => {
                const speaking = speakingIds.has(m.user_id);
                return (
                  <TouchableOpacity
                    key={m.user_id}
                    style={styles.tile}
                    onPress={() => router.push(`/profile/${m.user_id}`)}
                    activeOpacity={0.8}
                  >
                    <View style={[styles.tileAvatarWrap, speaking && { borderColor: colors.primary }]}>
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
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={{ flex: 1 }} />

            {/* Chat + actions, pinned above the input */}
            <View style={styles.bottom}>
              <LiveChatOverlay
                messages={chat}
                maxHeight={190}
                onPressName={(m) => router.push(`/profile/${m.userId}`)}
              />
              <View style={styles.actionsRow}>
                <View style={styles.inputWrap}>
                  <TextInput
                    style={styles.input}
                    placeholder={t('live.chatPlaceholder')}
                    placeholderTextColor="rgba(255,255,255,0.5)"
                    value={draft}
                    onChangeText={setDraft}
                    maxLength={300}
                    onSubmitEditing={sendChat}
                    returnKeyType="send"
                  />
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.send')} onPress={sendChat} disabled={!draft.trim()} style={[styles.sendBtn, !draft.trim() && { opacity: 0.4 }]}>
                    <Ionicons name="arrow-up" size={17} color="#fff" />
                  </TouchableOpacity>
                </View>
                <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.tip')} style={styles.roundBtn} onPress={() => setDonateOpen(true)} activeOpacity={0.85}>
                  <Ionicons name="cash-outline" size={20} color="#fff" />
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.roundBtn, reqState === 'pending' && styles.roundBtnPending]}
                  onPress={onRequestJoin}
                  disabled={reqState === 'busy'}
                  activeOpacity={0.85}
                >
                  {reqState === 'busy'
                    ? <ActivityIndicator color="#fff" size="small" />
                    : <Ionicons
                        name={reqState === 'pending' ? 'hourglass-outline' : reqState === 'declined' ? 'close-circle-outline' : 'hand-left-outline'}
                        size={20}
                        color="#fff"
                      />}
                </TouchableOpacity>
              </View>
              <Text style={styles.reqHint}>
                {reqState === 'pending' ? t('studio.requestPending')
                  : reqState === 'declined' ? t('studio.requestDeclined')
                  : t('studio.requestHint')}
              </Text>
              <View style={{ height: insets.bottom + 8 }} />
            </View>
          </View>
          </TouchableWithoutFeedback>
          </KeyboardAvoidingView>
        )}

        <LiveDonationAlerts event={donationEvent} />

        {phase === 'live' && (
          <LiveDonateModal
            visible={donateOpen}
            studio={{ sessionId: id ?? '', hostProfile }}
            onClose={() => setDonateOpen(false)}
            onDonated={(cents, msg) => channelRef.current?.sendDonation(cents, msg)}
          />
        )}
      </View>
    </SwipeBackPager>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, gap: 8 },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#F43F5E', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff' },
  liveBadgeText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  listenerPill: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(255,255,255,0.14)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5, marginLeft: 'auto', marginRight: 6 },
  listenerPillText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 32 },
  stateText: { color: 'rgba(255,255,255,0.7)', fontSize: 14, textAlign: 'center' },
  endedTitle: { color: '#fff', fontSize: 18, fontWeight: '800' },
  endedBtn: { backgroundColor: 'rgba(255,255,255,0.14)', borderRadius: 999, paddingHorizontal: 26, paddingVertical: 11, marginTop: 4 },
  endedBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  meta: { paddingHorizontal: 20, paddingTop: 14, gap: 4 },
  title: { color: '#fff', fontSize: 22, fontWeight: '800' },
  hostLine: { color: 'rgba(255,255,255,0.65)', fontSize: 13 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, justifyContent: 'center', paddingVertical: 22, paddingHorizontal: 16 },
  tile: { width: 84, alignItems: 'center', gap: 6 },
  tileAvatarWrap: { width: 72, height: 72, borderRadius: 36, borderWidth: 2.5, borderColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  tileAvatar: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  tileInitial: { color: '#fff', fontSize: 24, fontWeight: '700' },
  tileName: { color: '#fff', fontSize: 12, fontWeight: '600', maxWidth: 82 },
  hostTag: { color: 'rgba(255,255,255,0.55)', fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  bottom: { paddingHorizontal: 14, gap: 10 },
  actionsRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  inputWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 999, paddingLeft: 14, paddingRight: 4, height: 42 },
  input: { flex: 1, color: '#fff', fontSize: 14 },
  sendBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  roundBtn: { width: 42, height: 42, borderRadius: 21, backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center' },
  roundBtnPending: { backgroundColor: 'rgba(242,101,34,0.5)' },
  reqHint: { color: 'rgba(255,255,255,0.45)', fontSize: 11, textAlign: 'right' },
});
