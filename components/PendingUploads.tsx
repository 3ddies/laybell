import { memo, useEffect, useMemo, useRef } from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, Dimensions, Animated, Easing } from 'react-native';
import { Canvas, Path, Skia, Group, vec } from '@shopify/react-native-skia';
import { useSharedValue, withTiming, Easing as REasing } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useUploadEta, useEncodeEta, formatEta, overallProgress, useSmoothProgress } from './uploadEta';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import AppVideo from './AppVideo';
import SongAttribution from './SongAttribution';
import TaggedPeopleButton from './TaggedPeopleButton';
import { useFeedFocused } from '../lib/feedVideo';
import { useUploadQueue, useUploadActions, type PendingUpload } from '../contexts/UploadQueueContext';
import { useProfile } from '../contexts/ProfileContext';
import { useShare } from '../contexts/ShareContext';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { aspectToNumber } from '../lib/aspectRatio';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';

const SCREEN_W = Dimensions.get('window').width;
const MAX_VIDEO_H = Dimensions.get('window').height * 0.62;
// Neutral celebration confetti (soft whites/greys) to match the card's palette.
const CONFETTI_COLORS = ['#F2F1ED', '#D7D5CD', '#B4B2A9', '#E6E5E1', '#9A9893'];

// Determinate progress ring, drawn with Skia (already in the build — no react-native-svg).
// A faint full track + a bright arc trimmed to `progress` (0..1), rotated so it starts at
// 12 o'clock and fills clockwise. The arc is animated on the UI thread so it GLIDES to each
// new value instead of stepping with the throttled byte-progress updates.
const UploadRing = memo(function UploadRing({ size, stroke, progress }: { size: number; stroke: number; progress: number }) {
  const r = (size - stroke) / 2;
  const c = size / 2;
  const path = useMemo(() => { const p = Skia.Path.Make(); p.addCircle(c, c, r); return p; }, [c, r]);
  const end = useSharedValue(0.001);
  useEffect(() => {
    end.value = withTiming(Math.max(0.001, Math.min(1, progress)), { duration: 300, easing: REasing.out(REasing.cubic) });
  }, [progress, end]);
  return (
    <Canvas style={{ width: size, height: size }}>
      <Group origin={vec(c, c)} transform={[{ rotate: -Math.PI / 2 }]}>
        <Path path={path} style="stroke" strokeWidth={stroke} color="rgba(255,255,255,0.18)" />
        <Path path={path} style="stroke" strokeWidth={stroke} strokeCap="round" color="white" start={0} end={end} />
      </Group>
    </Canvas>
  );
});

// One-shot celebration burst that fires when the card reaches the 'done' state. Pure RN
// Animated on the native driver; pieces fly out from the centre and fade.
const Confetti = memo(function Confetti() {
  const a = useRef(new Animated.Value(0)).current;
  const pieces = useMemo(() => Array.from({ length: 18 }, (_, i) => {
    const ang = (Math.PI * 2 * i) / 18 + (Math.random() - 0.5);
    const dist = 80 + Math.random() * 80;
    return { x: Math.cos(ang) * dist, y: Math.sin(ang) * dist - 24, rot: Math.random() * 540 - 270, color: CONFETTI_COLORS[i % CONFETTI_COLORS.length] };
  }), []);
  useEffect(() => {
    Animated.timing(a, { toValue: 1, duration: 1150, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [a]);
  return (
    <View style={[StyleSheet.absoluteFillObject, { alignItems: 'center', justifyContent: 'center' }]} pointerEvents="none">
      {pieces.map((pc, i) => (
        <Animated.View
          key={i}
          style={{
            position: 'absolute', width: 10, height: 10, borderRadius: 2, backgroundColor: pc.color,
            opacity: a.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 1, 0] }),
            transform: [
              { translateX: a.interpolate({ inputRange: [0, 1], outputRange: [0, pc.x] }) },
              { translateY: a.interpolate({ inputRange: [0, 1], outputRange: [0, pc.y] }) },
              { rotate: a.interpolate({ inputRange: [0, 1], outputRange: ['0deg', `${pc.rot}deg`] }) },
            ],
          }}
        />
      ))}
    </View>
  );
});

// The player is isolated behind memo so the frequent upload-progress re-renders
// (which update the ring) never reach it — otherwise each render would hand it a
// fresh source and restart playback, so it'd never actually play. Only a change to
// the source uri / height / active state re-renders it.
const PendingVideo = memo(function PendingVideo({ uri, poster, height, active, muted }: {
  uri: string; poster: string | null; height: number; active: boolean; muted: boolean;
}) {
  return (
    <AppVideo
      source={{ uri }}
      style={{ width: '100%', height }}
      poster={poster}
      contentFit="cover"
      loop
      muted={muted}
      active={active}
      // Standalone player living in the feed: resume if the ambient song player's audio
      // session interruption pauses it (expo-video won't on its own), so a just-posted video
      // doesn't sit stuck until a scroll re-kicks it.
      selfHeal
    />
  );
});

// One optimistic card — a full stand-in for the real post (video, music credit,
// tagged people) so a freshly-posted video is complete and playing before the DB
// row ever loads, with no manual refresh.
function PendingCard({ p }: { p: PendingUpload }) {
  const { retry, dismiss } = useUploadActions();
  const { profile } = useProfile();
  const { share } = useShare();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  // Pause the card's video when the feed is blurred (a screen pushed over it, e.g. tapping
  // View opens the post) — otherwise it keeps playing UNMUTED behind the opened post and you
  // hear both at once. The feed's own cards gate on this too.
  const focused = useFeedFocused();

  const h = Math.min(SCREEN_W / aspectToNumber(p.aspectRatio, 16 / 9), MAX_VIDEO_H);
  // ONE value across the whole publish. For a FILM the three stages are weighted into one
  // climb (overallProgress). For a short video the byte progress never reaches 1 and isn't
  // updated during the encode wait — so map it to 0→90% for the upload and snap to 100% the
  // moment it's past uploading, instead of freezing at 99% through processing.
  const rawOverall = p.isFilm
    ? overallProgress(p.phase, p.progress, p.processingPct)
    : (p.phase === 'uploading' || p.phase === 'preparing') ? p.progress * 0.9 : 1;
  const prog = useSmoothProgress(rawOverall, p.phase);
  const pct = Math.round(prog * 100);

  // Films only: live "time left" (accuracy-gated — see components/uploadEta.ts).
  const uploadEta = useUploadEta(p.progress, p.phase === 'uploading' && !!p.isFilm);
  const procPct = (p.processingPct ?? 0) / 100;
  const procEta = useEncodeEta(procPct, p.phase === 'processing' && !!p.isFilm, p.durationSec ?? 0);
  const stageLabel = p.phase === 'preparing'
    ? t('upload.stagePreparing')
    : p.phase === 'uploading'
      ? t('upload.stageUploading')
      : p.phase === 'processing'
        ? t('upload.stageProcessing')
        : null;
  const timeLeft = p.phase === 'uploading'
    ? formatEta(t, uploadEta)
    : p.phase === 'processing' && p.isFilm
      ? ((p.processingPct ?? 0) >= 95 || (procEta != null && procEta < 60) ? t('upload.almostDone') : formatEta(t, procEta))
      : null;
  const working = p.phase === 'uploading' || p.phase === 'preparing' || p.phase === 'processing';
  // Status lives in the HEADER so the video frame stays clean. 'done' reads as a normal post.
  const subline = p.phase === 'error'
    ? t('upload.failed')
    : p.phase === 'done'
      ? t('upload.justNow')
      : [stageLabel, timeLeft, p.slowLink && p.phase === 'uploading' ? t('upload.slowLink') : null].filter(Boolean).join(' · ');

  const ringSize = Math.min(104, Math.round(SCREEN_W * 0.28));

  return (
    <View style={styles.card}>
      {/* Header — matches the feed card's author row, with a live status subline. */}
      <View style={styles.header}>
        {profile?.avatar_url
          ? <Image source={{ uri: profile.avatar_url }} style={styles.avatar} />
          : <View style={[styles.avatar, styles.avatarFallback]}><Ionicons name="person" size={16} color={colors.textTertiary} /></View>}
        <View style={styles.headerText}>
          <Text style={styles.name} numberOfLines={1}>{profile?.display_name || profile?.username || ''}</Text>
          {!!subline && <Text style={styles.subline} numberOfLines={1}>{subline}</Text>}
        </View>
        {p.phase === 'error' && (
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.close')} onPress={() => dismiss(p.tempId)} hitSlop={10} style={styles.dismissBtn}>
            <Ionicons name="close" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        )}
      </View>

      {/* Thumbnail while uploading; once uploaded, the real Cloudflare video (HLS)
          plays — poster shown until encoding finishes. (Local files render black in
          expo-video, so we never play those.) */}
      <View style={[styles.media, { height: h }]}>
        {p.hlsUri
          ? <PendingVideo uri={p.hlsUri} poster={p.thumbnailUri} height={h} active={p.phase !== 'error' && focused} muted={p.phase !== 'done'} />
          : p.thumbnailUri
            ? <ExpoImage source={{ uri: p.thumbnailUri }} style={{ width: '100%', height: h }} contentFit="cover" />
            : null}

        {p.phase === 'error' ? (
          <View style={styles.errorOverlay}>
            <TouchableOpacity style={styles.retryBtn} onPress={() => retry(p.tempId)}>
              <Ionicons name="refresh" size={18} color="#fff" />
              <Text style={styles.retryText}>{t('common.retry')}</Text>
            </TouchableOpacity>
            {p.errorCode === 'compress_failed_detail' ? (
              <Text style={styles.errorReason}>{p.errorMsg}</Text>
            ) : p.errorCode === 'compress_unavailable' ? (
              <Text style={styles.errorReason}>{t('upload.errCompressUnavailable')}</Text>
            ) : p.errorCode === 'upload_incomplete' || p.errorCode === 'resume_check_failed' ? (
              <Text style={styles.errorReason}>{t('upload.errResumable')}</Text>
            ) : p.errorCode === 'video_too_large' ? (
              <Text style={styles.errorReason}>{t('upload.errTooLarge')}</Text>
            ) : p.errorMsg ? (
              <Text style={styles.errorReason}>{p.errorMsg}</Text>
            ) : null}
          </View>
        ) : working ? (
          // Working state: a scrim keeps the frame readable as "not ready", with a bold
          // determinate ring and the percentage as the hero. The status word is in the header.
          <View style={styles.workingOverlay} pointerEvents="none">
            <View style={{ width: ringSize, height: ringSize, alignItems: 'center', justifyContent: 'center' }}>
              <UploadRing size={ringSize} stroke={3} progress={prog} />
              <View style={styles.pctWrap} pointerEvents="none">
                <Text style={styles.pctBig}>{pct}<Text style={styles.pctSign}>%</Text></Text>
              </View>
            </View>
          </View>
        ) : p.phase === 'done' ? (
          // It's live: the clean video plays, a one-shot confetti fires, and View/Share
          // appear. These are ephemeral — a pull-to-refresh clears the card and the real
          // post takes its place with no buttons.
          <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
            <Confetti />
            <View style={styles.doneActions} pointerEvents="box-none">
              <TouchableOpacity
                style={styles.doneGhost}
                activeOpacity={0.85}
                onPress={() => { if (p.postId) router.push({ pathname: '/post/[id]', params: { id: p.postId } }); }}
              >
                <Ionicons name="eye-outline" size={18} color="#fff" />
                <Text style={styles.doneGhostText}>{t('upload.view')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.doneSolid}
                activeOpacity={0.85}
                onPress={() => { if (p.postId) share({ postId: p.postId, caption: p.caption, username: profile?.username, cover: p.thumbnailUri, type: 'video', mediaUrl: p.hlsUri }); }}
              >
                <Ionicons name="paper-plane-outline" size={18} color="#1C1C1E" />
                <Text style={styles.doneSolidText}>{t('upload.share')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}

        {/* Music credit + tagged people — same elements the real post shows. Hidden in the
            'done' state so they don't collide with the View/Share row (they come back on the
            real post once it's refreshed in). */}
        {p.song && p.phase !== 'done' && (
          <SongAttribution songId={p.song.id} title={p.song.title} artist={p.song.artist} artistId={p.song.artistId} />
        )}
        {!!p.taggedIds?.length && p.phase !== 'done' && <TaggedPeopleButton userIds={p.taggedIds} style={styles.tagBtnOverlay} />}
      </View>

      {!!p.caption && <Text style={styles.caption} numberOfLines={2}>{p.caption}</Text>}
    </View>
  );
}

// Optimistic cards for videos still uploading/encoding in the background. Rendered
// at the top of the feed (below the stories tray).
export default function PendingUploads() {
  const { pending } = useUploadQueue();
  // A finished upload hands off to its REAL feed card (pinned, with the PostCelebration
  // overlay) the instant it completes, so a 'done' item should never reach this list —
  // filter defensively so a stray one can't double up with the pinned card.
  const active = pending.filter((p) => p.phase !== 'done');
  if (!active.length) return null;
  return <View>{active.map((p) => <PendingCard key={p.tempId} p={p} />)}</View>;
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  card: { backgroundColor: c.surface, marginBottom: 8, paddingBottom: 10 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, gap: 10 },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: c.border },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  headerText: { flex: 1 },
  name: { color: c.text, fontWeight: '600', fontSize: 14.5, letterSpacing: -0.2 },
  subline: { color: c.textSecondary, fontSize: 12, marginTop: 1, letterSpacing: -0.1 },
  dismissBtn: { padding: 4 },
  media: { width: '100%', backgroundColor: '#000', overflow: 'hidden' },
  workingOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.4)' },
  pctWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  pctBig: { color: '#fff', fontSize: 24, fontWeight: '700', letterSpacing: -0.6, fontVariant: ['tabular-nums'] },
  pctSign: { fontSize: 14, fontWeight: '600' },
  // Completion buttons — iOS-style pills at the bottom of the frame. View is a frosted
  // ghost, Share a solid white; both ephemeral until the next refresh.
  doneActions: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', gap: 10, padding: 14 },
  doneGhost: { flex: 1, height: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: 'rgba(255,255,255,0.18)', borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.28)', borderRadius: 14 },
  doneGhostText: { color: '#fff', fontSize: 15, fontWeight: '600', letterSpacing: -0.2 },
  doneSolid: { flex: 1, height: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: '#fff', borderRadius: 14 },
  doneSolidText: { color: '#1C1C1E', fontSize: 15, fontWeight: '600', letterSpacing: -0.2 },
  tagBtnOverlay: { position: 'absolute', left: SPACING.sm, bottom: SPACING.sm },
  errorOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.35)' },
  retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(0,0,0,0.72)', paddingHorizontal: 18, paddingVertical: 10, borderRadius: 22 },
  retryText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  errorReason: { color: '#fff', fontSize: 12.5, textAlign: 'center', marginTop: 10, paddingHorizontal: 28, opacity: 0.92 },
  caption: { color: c.text, fontSize: 14, paddingHorizontal: 12, paddingTop: 8 },
});
