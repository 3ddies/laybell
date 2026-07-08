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
import SwipeBackPager from '../../components/SwipeBackPager';
import { GRADIENTS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { useProfile } from '../../contexts/ProfileContext';
import { supabase } from '../../lib/supabase';
import {
  fetchLiveStreams, joinLiveChannel, type LiveChatMessage, type LiveStream,
} from '../../lib/live';
import { hostCanReceive, fmtCents } from '../../lib/donations';
import LiveDonateModal from '../../components/LiveDonateModal';
import { WhepPlayer, getRTCView, webrtcAvailable } from '../../lib/whip';
import AppVideo from '../../components/AppVideo';
import { Skeleton, SkeletonCircle } from '../../components/Skeleton';

// The Live feed, opened from the tv button next to the Laybell logo on Home:
// a reels-style vertical pager of CURRENT livestreams — the only place
// broadcasts surface in the app. webrtc-mode streams play over WHEP
// (sub-second); rtmp-mode streams (OBS broadcasters) play their live HLS
// manifest through the normal AppVideo pipeline. Only the visible card runs a
// player, mirroring the home feed's one-player rule.

// Plays a webrtc-mode broadcast. Mounted ONLY for the visible card.
function WhepView({ url, style }: { url: string; style: object }) {
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
  return <RTCView streamURL={streamURL} objectFit="cover" style={style} />;
}

function LiveCard({
  stream, height, active, onOpenProfile,
}: {
  stream: LiveStream;
  height: number;
  active: boolean;
  onOpenProfile: (userId: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { profile } = useProfile();
  const insets = useSafeAreaInsets();
  const [viewers, setViewers] = useState(0);
  const [chat, setChat] = useState<LiveChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [donateOpen, setDonateOpen] = useState(false);
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
      onViewers: setViewers,
      onChat: (msg) => setChat((prev) => [...prev.slice(-40), msg]),
    });
    channelRef.current = handle;
    return () => { handle.leave(); channelRef.current = null; setChat([]); setViewers(0); };
  }, [active, stream.id, profile?.id, profile?.display_name, profile?.username, profile?.avatar_url]);

  const send = () => {
    const text = draft.trim();
    if (!text || !channelRef.current) return;
    channelRef.current.sendChat(text);
    setDraft('');
  };

  const name = stream.profile?.display_name || stream.profile?.username || '';

  return (
    <View style={{ height, backgroundColor: '#000' }}>
      {active && (
        stream.mode === 'webrtc' ? (
          webrtcAvailable() ? (
            <WhepView url={stream.playback_url} style={StyleSheet.absoluteFill} />
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
            contentFit="cover"
            active={active}
          />
        )
      )}

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
          <Text style={styles.hostName} numberOfLines={1}>{name}</Text>
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

      {/* Bottom overlay: title + chat + input */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.bottomWrap}
        pointerEvents="box-none"
      >
        {!!stream.title && <Text style={styles.title} numberOfLines={2}>{stream.title}</Text>}
        <View style={styles.chatList} pointerEvents="none">
          {chat.slice(-6).map((m) => (
            <Text key={m.id} style={styles.chatLine} numberOfLines={2}>
              <Text style={styles.chatName}>{m.name}  </Text>
              {m.text}
            </Text>
          ))}
        </View>
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
      </KeyboardAvoidingView>

      {canDonate && (
        <LiveDonateModal
          visible={donateOpen}
          stream={stream}
          onClose={() => setDonateOpen(false)}
          // Announce the tip in chat so the host + room see it (uses the donor's name).
          onDonated={(cents) => channelRef.current?.sendChat(t('live.donate.chat', { amount: fmtCents(cents) }))}
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

  const load = useCallback(async () => {
    try {
      const rows = await fetchLiveStreams();
      setStreams(rows);
      setVisibleId((cur) => {
        // First load from TV: honor the requested stream if it's live.
        const want = startStreamId.current;
        if (want && rows.some((r) => r.id === want)) { startStreamId.current = null; return want; }
        return cur && rows.some((r) => r.id === cur) ? cur : rows[0]?.id ?? null;
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'live_streams' }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [isFocused, load]);

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
                  active={isFocused && item.id === visibleId}
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
  donatePill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: c.primary, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  donateText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  bottomWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 14, paddingBottom: 14, gap: 8 },
  title: { color: '#fff', fontSize: 14, fontWeight: '600', textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 4 },
  chatList: { gap: 5 },
  chatLine: { color: 'rgba(255,255,255,0.92)', fontSize: 13, textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 4 },
  chatName: { fontWeight: '700', color: '#fff' },
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
