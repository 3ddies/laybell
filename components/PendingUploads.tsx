import { memo } from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, Dimensions } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import AppVideo from './AppVideo';
import SongAttribution from './SongAttribution';
import TaggedPeopleButton from './TaggedPeopleButton';
import Spinner from './Spinner';
import { useUploadQueue, useUploadActions, type PendingUpload } from '../contexts/UploadQueueContext';
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
  // Row actions only — the row's own progress comes in as props, so it shouldn't
  // re-subscribe to the whole queue.
  const { retry, dismiss } = useUploadActions();
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
          // Working state: a light scrim over the frame and one small ring,
          // centred. No percentage, no "Processing…" — a number that jumps and a
          // word that changes are two things to read on a card whose only job is
          // to say "not yet". The scrim alone reads as not-ready; the ring says
          // it's moving.
          <View style={styles.workingOverlay} pointerEvents="none">
            <View style={styles.workingDisc}>
              <Spinner size={22} thickness={2} color="#fff" />
            </View>
          </View>
        )}

        {/* Music credit — same "uses <song>" element the real post shows. */}
        {p.song && (
          <SongAttribution songId={p.song.id} title={p.song.title} artist={p.song.artist} artistId={p.song.artistId} />
        )}
        {/* Tagged people. */}
        {!!p.taggedIds?.length && <TaggedPeopleButton userIds={p.taggedIds} style={styles.tagBtnOverlay} />}

        {/* Real progress, as a hairline on the frame's bottom EDGE rather than a
            bar in its own strip under the card — that strip is what made the
            thing read bulky. It carries what the percentage did without asking
            anyone to read anything. (A determinate RING would need
            react-native-svg, a native dep, so a rebuild.) */}
        {p.phase === 'uploading' && (
          <View style={styles.track}><View style={[styles.fill, { width: `${pct}%` }]} /></View>
        )}
      </View>

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
  // Light, not heavy: enough to read as "not ready yet" without hiding the frame
  // the user just shot. The error state keeps its darker scrim — that one needs
  // the retry button to dominate.
  workingOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.22)' },
  workingDisc: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  videoAudioBtn: {
    position: 'absolute', top: SPACING.sm, right: SPACING.sm,
    width: 34, height: 34, borderRadius: RADIUS.full,
    backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center',
  },
  tagBtnOverlay: { position: 'absolute', left: SPACING.sm, bottom: SPACING.sm },
  errorOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.35)' },
  retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(0,0,0,0.72)', paddingHorizontal: 18, paddingVertical: 10, borderRadius: 22 },
  retryText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  // 2px hairline riding the bottom edge of the frame, not a 3px bar in its own
  // strip below the card — that strip is what made the whole thing read bulky.
  track: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 2, backgroundColor: 'rgba(255,255,255,0.22)' },
  fill: { height: 2, backgroundColor: c.primary },
  caption: { color: c.text, fontSize: 14, paddingHorizontal: 12, paddingTop: 8 },
});
