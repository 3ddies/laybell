import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Image, TextInput,
  KeyboardAvoidingView, Platform, RefreshControl,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ScreenOrientation from 'expo-screen-orientation';
import SwipeBackPager from '../../components/SwipeBackPager';
import { GRADIENTS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { useProfile } from '../../contexts/ProfileContext';
import { supabase } from '../../lib/supabase';
import {
  fetchLiveStreams, joinLiveChannel, type LiveStream, type LiveDonationEvent,
} from '../../lib/live';
import { hostCanReceive } from '../../lib/donations';
import { displayedTier } from '../../lib/badges';
import LiveChatOverlay, { nameColor, useBufferedChat } from '../../components/LiveChatOverlay';
import LiveDonateModal from '../../components/LiveDonateModal';
import LiveDonationAlerts from '../../components/LiveDonationAlerts';
import { WhepPlayer, getRTCView, webrtcAvailable } from '../../lib/whip';
import AppVideo from '../../components/AppVideo';
import { Skeleton, SkeletonCircle } from '../../components/Skeleton';

// The Live feed, opened from the tv button next to the Laybell logo on Home:
// a reels-style vertical pager of CURRENT livestreams — the only place
// broadcasts surface in the app. webrtc-mode streams play over WHEP
// (sub-second); rtmp-mode streams (OBS broadcasters) play their live HLS
// manifest through the normal AppVideo pipeline. Only the visible card runs a
// player, mirroring the home feed's one-player rule.

// Plays a webrtc-mode broadcast. Mounted ONLY for the visible card. `contain`
// letterboxes instead of cropping — used for horizontal broadcasts.
function WhepView({ url, style, contain }: { url: string; style: object; contain?: boolean }) {
  const [streamURL, setStreamURL] = useState<string | null>(null);
  const RTCView = getRTCView();
  useEffect(() => {
    if (!RTCView) return;
    const player = new WhepPlayer();
    let alive = true;
    player
      .play(url)
      .then((stream) => { if (alive) setStreamURL(stream.toURL()); })
      .catch(() => { /* broadcast may have just ended */ });
    return () => { alive = false; player.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  if (!RTCView || !streamURL) return <View style={[style, { backgroundColor: '#000' }]} />;
  return <RTCView streamURL={streamURL} objectFit={contain ? 'contain' : 'cover'} style={style} />;
}

function LiveCard({
  stream, height, active, ended, onOpenProfile,
}: {
  stream: LiveStream;
  height: number;
  active: boolean;
  // The broadcast officially ended while the viewer was on this card — show
  // the "livestream ended" screen instead of yanking the page away.
  ended?: boolean;
  onOpenProfile: (userId: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { profile } = useProfile();
  const insets = useSafeAreaInsets();
  const [viewers, setViewers] = useState(0);
  // Burst-buffered chat (see LiveChatOverlay) — busy rooms coalesce into a few
  // renders per second instead of one per message.
  const { messages: chat, push: pushChat, clear: clearChat } = useBufferedChat();
  const [draft, setDraft] = useState('');
  const [donateOpen, setDonateOpen] = useState(false);
  // Latest donation broadcast → drives the Twitch-style alert overlay.
  const [donationEvent, setDonationEvent] = useState<LiveDonationEvent | null>(null);
  const channelRef = useRef<ReturnType<typeof joinLiveChannel> | null>(null);
  // Donations unlock only for a Premium host (also enforced server-side).
  const canDonate = hostCanReceive(stream.profile?.premium_until);

  // Presence + chat only while this card is the visible one.
  useEffect(() => {
    if (!active || !profile?.id) return;
    const handle = joinLiveChannel({
      streamId: stream.id,
      userId: profile.id,
      name: profile.display_name || profile.username || 'Someone',
      avatarUrl: profile.avatar_url ?? null,
      tier: displayedTier(profile),
      onViewers: setViewers,
      onChat: pushChat,
      onDonation: setDonationEvent,
    });
    channelRef.current = handle;
    return () => { handle.leave(); channelRef.current = null; clearChat(); setViewers(0); };
  }, [active, stream.id, profile?.id, profile?.display_name, profile?.username, profile?.avatar_url, pushChat, clearChat]);

  const send = () => {
    const text = draft.trim();
    if (!text || !channelRef.current) return;
    channelRef.current.sendChat(text);
    setDraft('');
  };

  const name = stream.profile?.display_name || stream.profile?.username || '';
  const hostTier = displayedTier(stream.profile);
  // Horizontal broadcasts letterbox (black bars top/bottom, like vertical
  // Laybell TV playback) instead of cover-cropping into a fake vertical.
  // 'vertical' and 'both' are framed for the portrait feed, so they still fill.
  const letterbox = stream.orientation === 'horizontal';

  // After all hooks so the hook order never changes when a live ends mid-view.
  if (ended) {
    return (
      <View style={{ height, backgroundColor: '#000' }}>
        <View style={[StyleSheet.absoluteFill, styles.center]}>
          {stream.profile?.avatar_url ? (
            <Image source={{ uri: stream.profile.avatar_url }} style={styles.endedAvatar} />
          ) : (
            <LinearGradient colors={GRADIENTS.primary} style={styles.endedAvatar}>
              <Text style={styles.endedInitial}>{(name || '?').charAt(0).toUpperCase()}</Text>
            </LinearGradient>
          )}
          <Text style={[styles.endedHost, nameColor(hostTier)]} numberOfLines={1}>{name}</Text>
          <Text style={styles.endedTitle}>{t('live.endedTitle')}</Text>
          <Text style={styles.endedSub}>{t('live.endedSub')}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={{ height, backgroundColor: '#000' }}>
      {active && (
        stream.mode === 'webrtc' ? (
          webrtcAvailable() ? (
            <WhepView url={stream.playback_url} style={StyleSheet.absoluteFill} contain={letterbox} />
          ) : (
            <View style={[StyleSheet.absoluteFill, styles.center]}>
              <Ionicons name="cloud-offline-outline" size={34} color="rgba(255,255,255,0.6)" />
              <Text style={styles.fallbackText}>{t('live.rebuildNeeded')}</Text>
            </View>
          )
        ) : (
          <AppVideo
            source={{ uri: stream.playback_url }}
            style={StyleSheet.absoluteFill}
            contentFit={letterbox ? 'contain' : 'cover'}
            active={active}
          />
        )
      )}

      {/* Twitch-style donation alert — plays over the stream for the whole room. */}
      <LiveDonationAlerts event={donationEvent} />

      {/* Top overlay: broadcaster + LIVE pill + viewers (inset right of the back button) */}
      <View style={[styles.topRow, { top: insets.top + 12 }]}>
        <TouchableOpacity style={styles.hostRow} onPress={() => onOpenProfile(stream.user_id)} activeOpacity={0.8}>
          {stream.profile?.avatar_url ? (
            <Image source={{ uri: stream.profile.avatar_url }} style={styles.hostAvatar} />
          ) : (
            <LinearGradient colors={GRADIENTS.primary} style={styles.hostAvatar}>
              <Text style={styles.hostInitial}>{(name || '?').charAt(0).toUpperCase()}</Text>
            </LinearGradient>
          )}
          <Text style={[styles.hostName, nameColor(hostTier)]} numberOfLines={1}>{name}</Text>
        </TouchableOpacity>
        <View style={styles.livePill}>
          <Text style={styles.livePillText}>{t('live.live')}</Text>
        </View>
        <View style={styles.viewerPill}>
          <Ionicons name="eye-outline" size={13} color="#fff" />
          <Text style={styles.viewerText}>{viewers}</Text>
        </View>
        {canDonate && (
          <TouchableOpacity style={styles.donatePill} onPress={() => setDonateOpen(true)} activeOpacity={0.85}>
            <Ionicons name="gift" size={14} color="#fff" />
            <Text style={styles.donateText}>{t('live.donate.button')}</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Bottom overlay: title + chat + input. iOS KAV 'padding' REPLACES its
          own style's paddingBottom with the keyboard height (0 when closed) —
          so the real bottom padding, including the home-indicator inset, must
          live on the inner view or the input row renders under the system bar. */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.bottomWrap}
        pointerEvents="box-none"
      >
        <View style={[styles.bottomInner, { paddingBottom: insets.bottom + 14 }]} pointerEvents="box-none">
          {!!stream.title && <Text style={styles.title} numberOfLines={2}>{stream.title}</Text>}
          <LiveChatOverlay messages={chat} />
          <View style={styles.inputRow}>
            <TextInput
              style={[styles.input, { color: '#fff' }]}
              placeholder={t('live.chatPlaceholder')}
              placeholderTextColor="rgba(255,255,255,0.55)"
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={send}
              returnKeyType="send"
              maxLength={300}
            />
            <TouchableOpacity onPress={send} style={styles.sendBtn} disabled={!draft.trim()}>
              <Ionicons name="arrow-up" size={18} color={draft.trim() ? '#fff' : 'rgba(255,255,255,0.4)'} />
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>

      {canDonate && (
        <LiveDonateModal
          visible={donateOpen}
          stream={stream}
          onClose={() => setDonateOpen(false)}
          // Broadcast the tip to the room — the host + every viewer (and the
          // donor, self:true) get the emphasized alert overlay.
          onDonated={(cents, message) => channelRef.current?.sendDonation(cents, message)}
        />
      )}
    </View>
  );
}

export default function LiveScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  // Opened from Laybell TV with a specific stream to start on. Consumed once.
  const { streamId } = useLocalSearchParams<{ streamId?: string }>();
  const startStreamId = useRef<string | null>(streamId ?? null);
  const [streams, setStreams] = useState<LiveStream[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [visibleId, setVisibleId] = useState<string | null>(null);
  const [pageH, setPageH] = useState(0);
  // Streams whose broadcast officially ended (status → 'ended') while this feed
  // was open. The card being watched stays mounted, flagged, and shows the
  // "livestream ended" screen instead of vanishing mid-view. Refs mirror the
  // state so load()'s stable closure reads current values.
  const [endedIds, setEndedIds] = useState<Set<string>>(() => new Set());
  const endedRef = useRef(endedIds);
  const visibleRef = useRef<string | null>(null);
  useEffect(() => { visibleRef.current = visibleId; }, [visibleId]);

  // Watching a horizontal broadcast lets the viewer turn the phone — sensor
  // rotation unlocks (same as landscape reels) so the letterboxed stream can go
  // fullscreen-landscape. Any other card (or an ended one) locks portrait, and
  // leaving the screen always restores portrait.
  const visibleStream = streams.find((s) => s.id === visibleId);
  const visibleHorizontal =
    !!visibleStream && visibleStream.orientation === 'horizontal' && !endedIds.has(visibleStream.id);
  useEffect(() => {
    if (isFocused && visibleHorizontal) ScreenOrientation.unlockAsync().catch(() => {});
    else ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
  }, [isFocused, visibleHorizontal]);
  useEffect(() => () => { ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {}); }, []);

  // Rotating swaps the pager's page height while the scroll offset stays in
  // pixels — re-align the list to the card being watched so it never lands
  // half-way between two streams after a turn.
  const listRef = useRef<FlatList<LiveStream>>(null);
  useEffect(() => {
    if (!pageH || !visibleRef.current) return;
    const idx = streams.findIndex((s) => s.id === visibleRef.current);
    if (idx > 0) listRef.current?.scrollToOffset({ offset: idx * pageH, animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageH]);

  const markEnded = useCallback((id: string) => {
    setEndedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      endedRef.current = next;
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    try {
      const rows = await fetchLiveStreams();
      setStreams((prev) => {
        // Keep the card the viewer is actually watching in the list after its
        // broadcast ends (it drops out of the live-only fetch). Re-inserting at
        // its previous index keeps the pager's scroll position on the same card.
        const keepId = visibleRef.current;
        if (keepId && endedRef.current.has(keepId) && !rows.some((r) => r.id === keepId)) {
          const kept = prev.find((r) => r.id === keepId);
          if (kept) {
            const next = [...rows];
            const idx = prev.findIndex((r) => r.id === keepId);
            next.splice(Math.max(0, Math.min(idx, next.length)), 0, kept);
            return next;
          }
        }
        return rows;
      });
      setVisibleId((cur) => {
        // First load from TV: honor the requested stream if it's live.
        const want = startStreamId.current;
        if (want && rows.some((r) => r.id === want)) { startStreamId.current = null; return want; }
        // An ended-but-kept card stays current until the viewer moves on.
        if (cur && (rows.some((r) => r.id === cur) || endedRef.current.has(cur))) return cur;
        return rows[0]?.id ?? null;
      });
    } catch { /* offline / pre-migration */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!isFocused) return;
    load();
    // Streams starting/ending while you're here update the rail live.
    const channel = supabase
      .channel('live-streams-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'live_streams' }, (payload: any) => {
        // An official end (host tapped End, status flips to 'ended') — or the
        // row being deleted — flags the card before the refetch prunes it.
        const id = payload?.new?.id ?? payload?.old?.id;
        if (id && (payload?.eventType === 'DELETE' || payload?.new?.status === 'ended')) markEnded(id);
        load();
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [isFocused, load, markEnded]);

  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: Array<{ item: LiveStream }> }) => {
      if (viewableItems[0]?.item) setVisibleId(viewableItems[0].item.id);
    },
  ).current;

  const openProfile = (userId: string) => router.push(`/profile/${userId}`);

  return (
    <SwipeBackPager>
      <View style={styles.root} onLayout={(e) => setPageH(e.nativeEvent.layout.height)}>
        {loading ? (
          <View style={styles.skeletonWrap}>
            <View style={styles.skeletonTop}>
              <SkeletonCircle size={34} />
              <Skeleton width={120} height={12} radius={6} />
            </View>
            <Skeleton width={'62%' as never} height={14} radius={7} />
            <Skeleton width={'40%' as never} height={12} radius={6} />
          </View>
        ) : streams.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="tv-outline" size={44} color={colors.textTertiary} />
            <Text style={styles.emptyTitle}>{t('live.empty')}</Text>
            <Text style={styles.emptySub}>{t('live.emptySub')}</Text>
            <TouchableOpacity style={styles.goLiveCta} onPress={() => router.push('/live/go-live')} activeOpacity={0.85}>
              <LinearGradient colors={GRADIENTS.primary} style={styles.goLiveCtaBg}>
                <Ionicons name="radio-outline" size={18} color="#fff" />
                <Text style={styles.goLiveCtaText}>{t('live.goLive')}</Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>
        ) : (
          pageH > 0 && (
            <FlatList
              ref={listRef}
              data={streams}
              keyExtractor={(s) => s.id}
              pagingEnabled
              snapToInterval={pageH}
              snapToAlignment="start"
              decelerationRate="fast"
              showsVerticalScrollIndicator={false}
              getItemLayout={(_, i) => ({ length: pageH, offset: pageH * i, index: i })}
              initialScrollIndex={Math.max(0, streams.findIndex((s) => s.id === visibleId))}
              onViewableItemsChanged={onViewableItemsChanged}
              viewabilityConfig={{ itemVisiblePercentThreshold: 80, minimumViewTime: 90 }}
              windowSize={3}
              maxToRenderPerBatch={2}
              initialNumToRender={1}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  tintColor={colors.textSecondary}
                  onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
                />
              }
              renderItem={({ item }) => (
                <LiveCard
                  stream={item}
                  height={pageH}
                  active={isFocused && item.id === visibleId && !endedIds.has(item.id)}
                  ended={endedIds.has(item.id)}
                  onOpenProfile={openProfile}
                />
              )}
            />
          )
        )}

        {/* Floating back (pushed screen — swipe-back also works) */}
        <TouchableOpacity
          style={[styles.backFab, { top: insets.top + 12 }]}
          onPress={() => router.back()}
          activeOpacity={0.85}
        >
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>

        {/* Floating actions: Studio hub + Go Live */}
        <View style={[styles.fabCol, { top: insets.top + 12 }]}>
          <TouchableOpacity style={styles.fab} onPress={() => router.push('/studio')} activeOpacity={0.85}>
            <Ionicons name="headset-outline" size={20} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.fab} onPress={() => router.push('/live/go-live')} activeOpacity={0.85}>
            <Ionicons name="radio-outline" size={20} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>
    </SwipeBackPager>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center', gap: 10 },
  fallbackText: { color: 'rgba(255,255,255,0.7)', fontSize: 13, textAlign: 'center', paddingHorizontal: 40 },
  // Starts right of the floating back button (14 + 40 + 8).
  topRow: { position: 'absolute', left: 62, right: 14, flexDirection: 'row', alignItems: 'center', gap: 8, zIndex: 5 },
  hostRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, marginRight: 96 },
  hostAvatar: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  hostInitial: { color: '#fff', fontSize: 14, fontWeight: '700' },
  hostName: { color: '#fff', fontSize: 14, fontWeight: '700', flexShrink: 1, textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 4 },
  livePill: { backgroundColor: '#F43F5E', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  livePillText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.8 },
  viewerPill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  viewerText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  donatePill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: c.success, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  donateText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  bottomWrap: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  bottomInner: { paddingHorizontal: 14, gap: 8 },
  // "Livestream ended" screen (host avatar + name over black).
  endedAvatar: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  endedInitial: { color: '#fff', fontSize: 28, fontWeight: '700' },
  endedHost: { color: '#fff', fontSize: 15, fontWeight: '700', maxWidth: '80%' },
  endedTitle: { color: '#fff', fontSize: 20, fontWeight: '800', marginTop: 4 },
  endedSub: { color: 'rgba(255,255,255,0.6)', fontSize: 13, textAlign: 'center', paddingHorizontal: 40 },
  title: { color: '#fff', fontSize: 14, fontWeight: '600', textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 4 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: { flex: 1, backgroundColor: 'rgba(255,255,255,0.14)', borderRadius: 20, paddingHorizontal: 14, paddingVertical: Platform.OS === 'ios' ? 10 : 7, fontSize: 14 },
  sendBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center' },
  backFab: { position: 'absolute', left: 14, width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.25)', zIndex: 6 },
  fabCol: { position: 'absolute', right: 14, gap: 10, zIndex: 6, marginTop: 52 },
  fab: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.25)' },
  skeletonWrap: { flex: 1, justifyContent: 'flex-end', padding: 18, gap: 12 },
  skeletonTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 36 },
  emptyTitle: { color: '#fff', fontSize: 17, fontWeight: '700', marginTop: 6 },
  emptySub: { color: c.textTertiary, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  goLiveCta: { marginTop: 14, borderRadius: 22, overflow: 'hidden' },
  goLiveCtaBg: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 22, paddingVertical: 11 },
  goLiveCtaText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
