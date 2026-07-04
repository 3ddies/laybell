import { memo, useEffect, useMemo, useRef } from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, Dimensions, Animated, Easing } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import AppVideo from './AppVideo';
import SongAttribution from './SongAttribution';
import TaggedPeopleButton from './TaggedPeopleButton';
import { useUploadQueue, type PendingUpload } from '../contexts/UploadQueueContext';
import { useProfile } from '../contexts/ProfileContext';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { aspectToNumber } from '../lib/aspectRatio';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';

const SCREEN_W = Dimensions.get('window').width;
const MAX_VIDEO_H = Dimensions.get('window').height * 0.62;

// The player is isolated behind memo so the frequent upload-progress re-renders
// (which update the pill) never reach it — otherwise each render would hand it a
// fresh source and restart playback, so it'd never actually play. Only a change to
// the source uri / height / active state re-renders it.
// RN has no text stroke, so we fake a bold black outline by stacking offset black
// copies behind the white fill (same trick as the explore header).
const STROKE = 1.4;
const OUTLINE: ReadonlyArray<readonly [number, number]> = [
  [-STROKE, 0], [STROKE, 0], [0, -STROKE], [0, STROKE],
  [-STROKE, -STROKE], [STROKE, -STROKE], [-STROKE, STROKE], [STROKE, STROKE],
];

const stripTrailingDots = (s: string) => s.replace(/[.…]+$/, '');

// A single outlined (white-with-black-stroke) character.
function OutlinedChar({ ch }: { ch: string }) {
  return (
    <View>
      {OUTLINE.map(([x, y], i) => (
        <Text key={i} style={[stStyles.txt, stStyles.stroke, { position: 'absolute', left: x, top: y }]}>{ch}</Text>
      ))}
      <Text style={stStyles.txt}>{ch}</Text>
    </View>
  );
}

// A whole outlined string (no animation) — used for the % readout.
function Outlined({ children }: { children: string }) {
  return (
    <View style={stStyles.row}>
      {[...children].map((ch, i) => <OutlinedChar key={i} ch={ch} />)}
    </View>
  );
}

// Status word that keeps fading in letter-by-letter from left to right, then holds
// and repeats — a soft "typewriter fade" reveal (native-driven opacity).
function AnimatedReveal({ text }: { text: string }) {
  const chars = useMemo(() => [...text], [text]);
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    anim.setValue(0);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 850, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.delay(650),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [text, anim]);
  return (
    <View style={stStyles.row}>
      {chars.map((ch, i) => {
        const start = chars.length > 1 ? (i / chars.length) * 0.65 : 0;
        const opacity = anim.interpolate({ inputRange: [start, Math.min(1, start + 0.35)], outputRange: [0, 1], extrapolate: 'clamp' });
        return (
          <Animated.View key={i} style={{ opacity }}>
            <OutlinedChar ch={ch} />
          </Animated.View>
        );
      })}
    </View>
  );
}

function StatusText({ text, animate }: { text: string; animate: boolean }) {
  return animate ? <AnimatedReveal text={text} /> : <Outlined>{text}</Outlined>;
}

const stStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  txt: { color: '#fff', fontSize: 14, fontWeight: '900', letterSpacing: 0.2 },
  stroke: { color: '#000' },
});

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
    />
  );
});

// One optimistic card — a full stand-in for the real post (video, music credit,
// tagged people, audio toggle) so a freshly-posted video is complete and playing
// before the DB row ever loads, with no manual refresh.
function PendingCard({ p }: { p: PendingUpload }) {
  const { retry, dismiss } = useUploadQueue();
  const { profile } = useProfile();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();

  const h = Math.min(SCREEN_W / aspectToNumber(p.aspectRatio, 16 / 9), MAX_VIDEO_H);
  const pct = Math.round(p.progress * 100);

  return (
    <View style={styles.card}>
      {/* Header — matches the feed card's author row. */}
      <View style={styles.header}>
        {profile?.avatar_url
          ? <Image source={{ uri: profile.avatar_url }} style={styles.avatar} />
          : <View style={[styles.avatar, styles.avatarFallback]}><Ionicons name="person" size={16} color={colors.textTertiary} /></View>}
        <Text style={styles.name} numberOfLines={1}>{profile?.display_name || profile?.username || ''}</Text>
        {p.phase === 'error' && (
          <TouchableOpacity onPress={() => dismiss(p.tempId)} hitSlop={10} style={styles.dismissBtn}>
            <Ionicons name="close" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        )}
      </View>

      {/* Thumbnail while uploading; once uploaded, the real Cloudflare video (HLS)
          plays — poster shown until encoding finishes. (Local files render black in
          expo-video, so we never play those.) */}
      <View style={[styles.media, { height: h }]}>
        {p.hlsUri
          ? <PendingVideo uri={p.hlsUri} poster={p.thumbnailUri} height={h} active={p.phase !== 'error'} muted />
          : p.thumbnailUri
            ? <ExpoImage source={{ uri: p.thumbnailUri }} style={{ width: '100%', height: h }} contentFit="cover" />
            : null}

        {p.phase === 'error' ? (
          <View style={styles.errorOverlay}>
            <TouchableOpacity style={styles.retryBtn} onPress={() => retry(p.tempId)}>
              <Ionicons name="refresh" size={18} color="#fff" />
              <Text style={styles.retryText}>{t('common.retry')}</Text>
            </TouchableOpacity>
          </View>
        ) : p.phase === 'done' ? null : (
          <View style={styles.status} pointerEvents="none">
            <StatusText
              text={p.phase === 'processing'
                ? stripTrailingDots(t('post.uploadProcessing'))
                : pct >= 100 ? stripTrailingDots(t('post.uploadFinishing')) : `${pct}%`}
              animate={p.phase === 'processing' || pct >= 100}
            />
          </View>
        )}

        {/* Music credit — same "uses <song>" element the real post shows. */}
        {p.song && (
          <SongAttribution songId={p.song.id} title={p.song.title} artist={p.song.artist} artistId={p.song.artistId} />
        )}
        {/* Tagged people. */}
        {!!p.taggedIds?.length && <TaggedPeopleButton userIds={p.taggedIds} style={styles.tagBtnOverlay} />}
      </View>

      {/* Thin progress bar during upload. */}
      {p.phase === 'uploading' && (
        <View style={styles.track}><View style={[styles.fill, { width: `${pct}%` }]} /></View>
      )}

      {!!p.caption && <Text style={styles.caption} numberOfLines={2}>{p.caption}</Text>}
    </View>
  );
}

// Optimistic cards for videos still uploading/encoding in the background. Rendered
// at the top of the feed (below the stories tray) and pinned there until refresh.
export default function PendingUploads() {
  const { pending } = useUploadQueue();
  if (!pending.length) return null;
  return <View>{pending.map((p) => <PendingCard key={p.tempId} p={p} />)}</View>;
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  card: { backgroundColor: c.surface, marginBottom: 8, paddingBottom: 10 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, gap: 10 },
  avatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: c.border },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  name: { flex: 1, color: c.text, fontWeight: '700', fontSize: 14 },
  dismissBtn: { padding: 4 },
  media: { width: '100%', backgroundColor: '#000', overflow: 'hidden' },
  // Outlined status text pinned to the top-right so the video stays fully visible.
  status: { position: 'absolute', top: 10, right: 12 },
  videoAudioBtn: {
    position: 'absolute', top: SPACING.sm, right: SPACING.sm,
    width: 34, height: 34, borderRadius: RADIUS.full,
    backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center',
  },
  tagBtnOverlay: { position: 'absolute', left: SPACING.sm, bottom: SPACING.sm },
  errorOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.35)' },
  retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(0,0,0,0.72)', paddingHorizontal: 18, paddingVertical: 10, borderRadius: 22 },
  retryText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  track: { height: 3, backgroundColor: c.border, marginTop: 2 },
  fill: { height: 3, backgroundColor: c.primary },
  caption: { color: c.text, fontSize: 14, paddingHorizontal: 12, paddingTop: 8 },
});
