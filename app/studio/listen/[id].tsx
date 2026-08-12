import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator,
  KeyboardAvoidingView, Platform, Keyboard, TouchableWithoutFeedback,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Room } from 'livekit-client';
import SwipeBackPager from '../../../components/SwipeBackPager';
import StudioStage, { CountPop, LiveDot } from '../../../components/StudioStage';
import StudioRadioBar from '../../../components/StudioRadioBar';
import FloatingReactions from '../../../components/FloatingReactions';
import { useStudioRadio } from '../../../hooks/useStudioRadio';
import { useAudioControls } from '../../../contexts/AudioContext';
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

// The chat strip's height. Fixed on purpose — see the note where it is used.
const CHAT_H = 200;

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
  // Stops the app's own music player when the radio takes over — two separate
  // players, both audible otherwise.
  const audioControls = useAudioControls();

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
  // The stage is a centring flex child, so once the keyboard shortens its box
  // the content overflows in BOTH directions and the circles ride up over the
  // title. Compact mode shrinks them instead.
  const [kbUp, setKbUp] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', () => setKbUp(true));
    const hide = Keyboard.addListener('keyboardWillHide', () => setKbUp(false));
    return () => { show.remove(); hide.remove(); };
  }, []);

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
        // Track events refresh the on-air list as artists mute/unmute or a
        // publication lands after the room is already joined.
        room
          .on(RoomEvent.TrackSubscribed, update)
          .on(RoomEvent.TrackUnsubscribed, update)
          .on(RoomEvent.TrackPublished, update)
          .on(RoomEvent.TrackMuted, update)
          .on(RoomEvent.TrackUnmuted, update);
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

  // The room's radio. A listener is a pure follower here — it never publishes,
  // it just asks once on arrival ("what's on?") and plays whatever comes back.
  const requestRadio = useCallback(() => { channelRef.current?.requestRadio(); }, []);
  const radio = useStudioRadio({ isHost: false, request: requestRadio, ready: phase === 'live', onTakeOver: audioControls.stop, viewerId: profile?.id ?? null });

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
      onRadio: radio.applyRemote,
    });
    channelRef.current = handle;
    return () => { handle.leave(); channelRef.current = null; };
  }, [id, profile?.id, profile?.display_name, profile?.username, profile?.avatar_url, pushChat, markEnded,
      radio.applyRemote]);

  // Accepted → I'm a member now: hop into the session for real.
  useEffect(() => {
    if (!id || !profile?.id || reqState !== 'pending') return;
    const act = (status: string) => {
      if (status === 'accepted' || status === 'member') router.replace(`/studio/${id}`);
      else if (status === 'declined') setReqState('declined');
    };
    const channel = supabase
      .channel(`studio-myreq:${id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'studio_join_requests', filter: `session_id=eq.${id}` }, (payload: any) => {
        if (payload?.new?.user_id !== profile.id) return;
        act(payload.new.status);
      })
      .subscribe();
    // POLL TOO — same reason as the host side. studio_join_requests was never
    // in the `supabase_realtime` publication, so this subscription has never
    // fired: being accepted left the listener sitting on "Request sent" while
    // the host watched them not arrive. Waiting on a realtime event is also the
    // wrong bet generally here, because this is the moment the person is
    // staring at the screen. supabase/sql/studio_join_requests_realtime.sql
    // fixes the publication; this makes the outcome not depend on it.
    const poll = setInterval(() => {
      myJoinRequestStatus(id).then((s) => { if (s) act(s); }).catch(() => {});
    }, 5000);
    return () => { clearInterval(poll); supabase.removeChannel(channel); };
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
    // Drop the keyboard on send. It covers the chat and most of the stage, so
    // without this you fire a message and watch none of it happen — including
    // the emoji you just launched.
    Keyboard.dismiss();
  }

  const hostName = hostProfile?.display_name || hostProfile?.username || '';

  return (
    <SwipeBackPager
      // Horizontal swipe-back is OFF here. Listeners hold the phone loosely while a session plays; an accidental drag
      // should not drop them out of the broadcast.
      // The header back button and the hardware/gesture back still work, and
      // both route through this screen's own confirm — so leaving stays a
      // decision rather than a twitch.
      swipeBackEnabled={false}
    >
      <View style={styles.root}>
        <LinearGradient colors={['#17120C', '#0B0908', '#000']} style={StyleSheet.absoluteFill} />

        {/* Header */}
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} onPress={() => router.back()} style={styles.headerBtn}>
            <Ionicons name="chevron-back" size={24} color="#fff" />
          </TouchableOpacity>
          <View style={styles.liveBadge}>
            <LiveDot />
            <Text style={styles.liveBadgeText}>{t('studio.liveStudio')}</Text>
          </View>
          <View style={styles.listenerPill}>
            <Ionicons name="headset-outline" size={13} color="#fff" />
            <CountPop value={listeners} />
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

            {/* The stage — big circles that bloom with whoever is talking, and
                a field driven by the room's actual audio. Given the whole
                middle of the screen and centred in it. */}
            <View style={styles.stageWrap}>
              <StudioStage
                room={roomRef.current}
                roster={roster}
                hostLabel={t('studio.host')}
                compact={kbUp}
                onPressMember={(userId) => router.push(`/profile/${userId}`)}
              />
            </View>

            {/* Chat + actions, pinned above the input */}
            <View style={styles.bottom}>
              {/* What the room is playing. Sits above the chat because it is
                  the reason a listener is here, and it is tappable — a song
                  heard on the radio is one tap from the artist who made it. */}
              {!!radio.state.track && (
                <StudioRadioBar
                  track={radio.state.track}
                  paused={radio.state.paused}
                  volume={radio.volume}
                  onVolume={radio.setVolume}
                  localMuted={radio.localMuted}
                  onToggleMute={() => radio.setLocalMuted((m) => !m)}
                  onOpenTrack={(sid) => router.push(`/post/${sid}`)}
                  labels={{
                    onAir: t('studio.radioOnAir'),
                    queued: (n) => t('studio.radioQueued', { n }),
                    mute: t('studio.radioMute'),
                    unmute: t('studio.radioUnmute'),
                    volume: t('studio.radioVolume'),
                    volumeNote: t('studio.radioVolumeNote'),
                    stop: t('studio.radioStop'),
                  }}
                />
              )}

              {/* Messages dissolve upward into the background instead of being
                  clipped by a hard edge. */}
              <View style={styles.chatWrap}>
                {/* flex:1 inside a FIXED-height strip, rather than the default
                    hug-your-content. Hugging meant the list was only as tall as
                    the messages in it, so the wide empty area above them was
                    not part of the list at all — a drag there hit nothing, and
                    the only place a scroll registered was on a line of text.
                    Filling the strip makes the whole area the scroll surface. */}
                <LiveChatOverlay
                  messages={chat}
                  maxHeight={CHAT_H}
                  style={{ flex: 1 }}
                  onPressName={(m) => router.push(`/profile/${m.userId}`)}
                />
                {/* Only once there is enough chat to actually run under it. The
                    list HUGS ITS CONTENT while the room is quiet, so with one
                    or two messages the box is shorter than this fade — and a
                    gradient starting at opaque black then covered the only
                    message anybody had sent. That is what the very first
                    comment of every session looked like. */}
                {chat.length > 3 && (
                  <LinearGradient
                    colors={['rgba(0,0,0,0.92)', 'rgba(0,0,0,0.45)', 'rgba(0,0,0,0)']}
                    style={styles.chatFade}
                    pointerEvents="none"
                  />
                )}
              </View>

              <View style={styles.actionsRow}>
                <View style={styles.inputWrap}>
                  <TextInput
                    style={styles.input}
                    placeholder={t('live.chatPlaceholder')}
                    placeholderTextColor="rgba(255,255,255,0.45)"
                    value={draft}
                    onChangeText={setDraft}
                    maxLength={300}
                    onSubmitEditing={sendChat}
                    returnKeyType="send"
                  />
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={t('a11y.send')}
                    onPress={sendChat}
                    disabled={!draft.trim()}
                    activeOpacity={0.85}
                    style={!draft.trim() && { opacity: 0.35 }}
                  >
                    <LinearGradient colors={GRADIENTS.primary} style={styles.sendBtn}>
                      <Ionicons name="arrow-up" size={17} color="#fff" />
                    </LinearGradient>
                  </TouchableOpacity>
                </View>

                {/* Tipping is the one action that should look like money. */}
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={t('a11y.tip')}
                  onPress={() => setDonateOpen(true)}
                  activeOpacity={0.85}
                >
                  <LinearGradient colors={GRADIENTS.primaryWarm} style={styles.tipBtn}>
                    <Ionicons name="cash-outline" size={21} color="#fff" />
                  </LinearGradient>
                </TouchableOpacity>

                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={t('studio.requestHint')}
                  style={[
                    styles.roundBtn,
                    reqState === 'pending' && styles.roundBtnPending,
                    reqState === 'declined' && styles.roundBtnDeclined,
                  ]}
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

        {/* Emoji from the chat, drifting up over the stage. Pointer-transparent,
            so it never eats a tap meant for anything underneath. */}
        {phase === 'live' && <FloatingReactions messages={chat} />}

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
  liveBadgeText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  listenerPill: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(255,255,255,0.14)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5, marginLeft: 'auto', marginRight: 6 },
  listenerPillText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 32 },
  stateText: { color: 'rgba(255,255,255,0.7)', fontSize: 14, textAlign: 'center' },
  endedTitle: { color: '#fff', fontSize: 18, fontWeight: '800' },
  endedBtn: { backgroundColor: 'rgba(255,255,255,0.14)', borderRadius: 999, paddingHorizontal: 26, paddingVertical: 11, marginTop: 4 },
  endedBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  meta: { paddingHorizontal: 20, paddingTop: 14, gap: 4, alignItems: 'center' },
  title: { color: '#fff', fontSize: 22, fontWeight: '800', textAlign: 'center' },
  hostLine: { color: 'rgba(255,255,255,0.6)', fontSize: 13 },
  stageWrap: { flex: 1, minHeight: 0, justifyContent: 'center', overflow: 'hidden' },
  bottom: { paddingHorizontal: 14, gap: 10 },
  chatWrap: { position: 'relative', height: CHAT_H },
  chatFade: { position: 'absolute', top: 0, left: 0, right: 0, height: 46 },
  actionsRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  inputWrap: {
    flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.09)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', borderRadius: 999, paddingLeft: 15, paddingRight: 5, height: 46,
  },
  input: { flex: 1, color: '#fff', fontSize: 15, paddingVertical: 0, paddingRight: 8, includeFontPadding: false },
  sendBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  tipBtn: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  roundBtn: {
    width: 46, height: 46, borderRadius: 23, backgroundColor: 'rgba(255,255,255,0.09)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', alignItems: 'center', justifyContent: 'center',
  },
  roundBtnPending: { backgroundColor: 'rgba(242,101,34,0.28)', borderColor: c.primary },
  roundBtnDeclined: { backgroundColor: 'rgba(244,63,94,0.20)', borderColor: 'rgba(244,63,94,0.6)' },
  reqHint: { color: 'rgba(255,255,255,0.42)', fontSize: 11, textAlign: 'center' },
});
