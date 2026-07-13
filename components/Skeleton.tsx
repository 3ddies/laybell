// Skeleton placeholders — grey, gently-pulsating blocks shaped like the content
// that's about to load (Instagram-style), shown instead of a spinning
// ActivityIndicator so a screen reads as "content is filling into its slots".
//
// Built on the RN Animated API (no reanimated dep) with a SINGLE shared,
// native-driven opacity loop, so every block on screen pulses in perfect sync
// and the animation costs one driver regardless of how many blocks render.
//
// Usage:
//   <Skeleton width={120} height={12} radius={6} />
//   <SkeletonCircle size={38} />
//   <FeedSkeleton />            // home feed (stories tray + post cards)
//   <GridSkeleton />           // 3-col square media grid (profile / explore)
//   <ProfileSkeleton />        // profile header + tab strip + grid
//   <ListRowsSkeleton />       // avatar + 2 text lines (followers / messages / search)
//   <CommentsSkeleton />       // comment thread
//   <ChatThreadSkeleton />     // chat bubbles
//   <TrackListSkeleton />      // music rows (cover + title/subtitle)
//   <CardsSkeleton />          // stacked cards (campaigns / playlists / generic)
//   <DetailSkeleton />         // generic stacked blocks (forms / detail screens)

import { useEffect, useRef } from 'react';
import {
  View, StyleSheet, Animated, Easing, Dimensions, type ViewStyle, type StyleProp,
} from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { SPACING, RADIUS, type ThemeMode } from '../constants/theme';

const SCREEN_W = Dimensions.get('window').width;
const SCREEN_H = Dimensions.get('window').height;

// ─── Shared pulse ────────────────────────────────────────────────────────────
// One module-level value, looped lazily. Each block reads the same value, so
// they pulse together and we never spin up more than one native animation.
// REF-COUNTED: the loop stops when the last skeleton unmounts — un-stopped it
// kept the native display link ticking for the rest of the session (plus a
// small JS re-arm every cycle) with zero skeletons on screen.
const pulse = new Animated.Value(0);
let pulseUsers = 0;
let pulseAnim: Animated.CompositeAnimation | null = null;
function retainPulse() {
  pulseUsers++;
  if (pulseUsers > 1) return;
  pulse.setValue(0);
  pulseAnim = Animated.loop(
    Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 750, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0, duration: 750, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]),
  );
  pulseAnim.start();
}
function releasePulse() {
  pulseUsers = Math.max(0, pulseUsers - 1);
  if (pulseUsers === 0 && pulseAnim) { pulseAnim.stop(); pulseAnim = null; }
}

// A grey that reads clearly against each theme's background (the light theme's
// elevated surfaces are near-white and would vanish, so it gets a darker tone).
function toneFor(mode: ThemeMode): string {
  switch (mode) {
    case 'light': return '#D8D5CD';
    case 'grey': return '#3C3A37';
    default: return '#262626';
  }
}

// ─── Primitive ───────────────────────────────────────────────────────────────
export function Skeleton({
  width, height, radius = RADIUS.sm, style,
}: {
  width?: number | `${number}%`;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { mode } = useTheme();
  const opacity = useRef(pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] })).current;
  useEffect(() => { retainPulse(); return releasePulse; }, []);
  return (
    <Animated.View
      style={[
        { width, height, borderRadius: radius, backgroundColor: toneFor(mode), opacity },
        style,
      ]}
    />
  );
}

export function SkeletonCircle({ size, style }: { size: number; style?: StyleProp<ViewStyle> }) {
  return <Skeleton width={size} height={size} radius={size / 2} style={style} />;
}

// A single text-line block. `w` is the fraction of available width (or a number).
export function SkeletonLine({
  w = '100%', h = 12, style,
}: { w?: number | `${number}%`; h?: number; style?: StyleProp<ViewStyle> }) {
  return <Skeleton width={w} height={h} radius={h / 2} style={style} />;
}

// ─── Building blocks ─────────────────────────────────────────────────────────

// One feed post: header (avatar + name lines) → square media → action row → caption.
export function PostCardSkeleton() {
  return (
    <View style={s.post}>
      <View style={s.postHeader}>
        <SkeletonCircle size={38} />
        <View style={s.postHeaderText}>
          <SkeletonLine w={140} h={12} />
          <SkeletonLine w={90} h={10} style={{ marginTop: 6 }} />
        </View>
      </View>
      <Skeleton width={SCREEN_W} height={SCREEN_W} radius={0} />
      <View style={s.postActions}>
        <SkeletonCircle size={24} />
        <SkeletonCircle size={24} />
        <SkeletonCircle size={24} />
        <View style={{ flex: 1 }} />
        <SkeletonCircle size={24} />
      </View>
      <View style={s.postCaption}>
        <SkeletonLine w="90%" h={11} />
        <SkeletonLine w="60%" h={11} style={{ marginTop: 7 }} />
      </View>
    </View>
  );
}

// Horizontal stories rail (circles + a label tick under each).
export function StoriesTraySkeleton() {
  return (
    <View style={s.storiesRow}>
      {Array.from({ length: 6 }).map((_, i) => (
        <View key={i} style={s.storyItem}>
          <SkeletonCircle size={62} />
          <SkeletonLine w={44} h={8} style={{ marginTop: 6 }} />
        </View>
      ))}
    </View>
  );
}

// avatar + two text lines, optional trailing block (e.g. a Follow button).
export function ListRowSkeleton({ trailing = true }: { trailing?: boolean }) {
  return (
    <View style={s.listRow}>
      <SkeletonCircle size={48} />
      <View style={s.listRowText}>
        <SkeletonLine w={150} h={12} />
        <SkeletonLine w={100} h={10} style={{ marginTop: 7 }} />
      </View>
      {trailing && <Skeleton width={76} height={30} radius={RADIUS.full} />}
    </View>
  );
}

// rounded-square cover + title/subtitle (music tracks, playlists in a list).
export function TrackRowSkeleton() {
  return (
    <View style={s.listRow}>
      <Skeleton width={52} height={52} radius={RADIUS.sm} />
      <View style={s.listRowText}>
        <SkeletonLine w={170} h={12} />
        <SkeletonLine w={110} h={10} style={{ marginTop: 7 }} />
      </View>
      <SkeletonCircle size={22} />
    </View>
  );
}

// ─── Full layouts ────────────────────────────────────────────────────────────

export function FeedSkeleton({ posts = 3 }: { posts?: number }) {
  return (
    <View style={s.flex}>
      <StoriesTraySkeleton />
      {Array.from({ length: posts }).map((_, i) => <PostCardSkeleton key={i} />)}
    </View>
  );
}

// 3-column flush square grid (profile / explore / archive / tagged etc.).
export function GridSkeleton({
  columns = 3, count = 12, gap = 1.5, padding = 0,
}: { columns?: number; count?: number; gap?: number; padding?: number }) {
  const { mode } = useTheme();
  const size = (SCREEN_W - padding * 2 - gap * (columns - 1)) / columns;
  return (
    <View style={[s.grid, { padding }]}>
      {Array.from({ length: count }).map((_, i) => (
        <View
          key={i}
          style={{
            width: size, height: size,
            marginRight: (i + 1) % columns === 0 ? 0 : gap,
            marginBottom: gap,
            backgroundColor: toneFor(mode),
          }}
        />
      ))}
    </View>
  );
}

export function ProfileSkeleton() {
  return (
    <View style={s.flex}>
      <View style={s.profileHead}>
        <SkeletonCircle size={86} />
        <View style={s.profileStats}>
          {Array.from({ length: 3 }).map((_, i) => (
            <View key={i} style={s.profileStat}>
              <SkeletonLine w={32} h={16} />
              <SkeletonLine w={48} h={10} style={{ marginTop: 6 }} />
            </View>
          ))}
        </View>
      </View>
      <View style={s.profileBio}>
        <SkeletonLine w={130} h={13} />
        <SkeletonLine w="80%" h={11} style={{ marginTop: 9 }} />
        <SkeletonLine w="55%" h={11} style={{ marginTop: 7 }} />
      </View>
      <View style={s.profileButtons}>
        <Skeleton width={(SCREEN_W - SPACING.md * 2 - SPACING.sm) / 2} height={34} radius={RADIUS.md} />
        <Skeleton width={(SCREEN_W - SPACING.md * 2 - SPACING.sm) / 2} height={34} radius={RADIUS.md} />
      </View>
      <View style={s.tabStrip}>
        {Array.from({ length: 4 }).map((_, i) => <SkeletonCircle key={i} size={22} />)}
      </View>
      <GridSkeleton />
    </View>
  );
}

export function ListRowsSkeleton({ rows = 8, trailing = true }: { rows?: number; trailing?: boolean }) {
  return (
    <View style={s.flex}>
      {Array.from({ length: rows }).map((_, i) => <ListRowSkeleton key={i} trailing={trailing} />)}
    </View>
  );
}

export function TrackListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <View style={s.flex}>
      {Array.from({ length: rows }).map((_, i) => <TrackRowSkeleton key={i} />)}
    </View>
  );
}

export function CommentsSkeleton({ rows = 7 }: { rows?: number }) {
  return (
    <View style={s.flex}>
      {Array.from({ length: rows }).map((_, i) => (
        <View key={i} style={s.comment}>
          <SkeletonCircle size={34} />
          <View style={s.commentBody}>
            <SkeletonLine w={110} h={10} />
            <SkeletonLine w="92%" h={11} style={{ marginTop: 8 }} />
            {i % 2 === 0 && <SkeletonLine w="70%" h={11} style={{ marginTop: 6 }} />}
          </View>
        </View>
      ))}
    </View>
  );
}

export function ChatThreadSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <View style={[s.flex, { padding: SPACING.md, gap: SPACING.md }]}>
      {Array.from({ length: rows }).map((_, i) => {
        const mine = i % 3 === 0;
        const w = 120 + ((i * 37) % 130); // varied bubble widths
        return (
          <View key={i} style={[s.bubbleRow, mine ? s.bubbleRight : s.bubbleLeft]}>
            <Skeleton width={w} height={38 + ((i * 13) % 26)} radius={RADIUS.lg} />
          </View>
        );
      })}
    </View>
  );
}

// Generic stacked cards (spotlight campaigns, playlists list, ad campaigns).
export function CardsSkeleton({ cards = 4 }: { cards?: number }) {
  const { mode } = useTheme();
  return (
    <View style={[s.flex, { padding: SPACING.md, gap: SPACING.md }]}>
      {Array.from({ length: cards }).map((_, i) => (
        <View key={i} style={[s.card, { borderColor: toneFor(mode) }]}>
          <View style={s.cardTop}>
            <Skeleton width={54} height={54} radius={RADIUS.sm} />
            <View style={s.listRowText}>
              <SkeletonLine w={160} h={12} />
              <SkeletonLine w={110} h={10} style={{ marginTop: 7 }} />
              <SkeletonLine w={80} h={10} style={{ marginTop: 7 }} />
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}

// Generic detail / form screen: a stack of blocks of varied widths.
export function DetailSkeleton() {
  return (
    <View style={[s.flex, { padding: SPACING.md, gap: SPACING.md }]}>
      <Skeleton width={SCREEN_W - SPACING.md * 2} height={170} radius={RADIUS.lg} />
      <SkeletonLine w="55%" h={16} />
      <SkeletonLine w="90%" h={12} />
      <SkeletonLine w="80%" h={12} />
      <SkeletonLine w="68%" h={12} />
      <Skeleton width={SCREEN_W - SPACING.md * 2} height={48} radius={RADIUS.full} style={{ marginTop: SPACING.sm }} />
    </View>
  );
}

// Notifications: avatar + 2 lines + a small trailing thumbnail (the post/preview).
export function NotificationsSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <View style={s.flex}>
      {Array.from({ length: rows }).map((_, i) => (
        <View key={i} style={s.listRow}>
          <SkeletonCircle size={44} />
          <View style={s.listRowText}>
            <SkeletonLine w="78%" h={11} />
            <SkeletonLine w="42%" h={9} style={{ marginTop: 7 }} />
          </View>
          {i % 3 !== 0 && <Skeleton width={40} height={40} radius={RADIUS.xs} />}
        </View>
      ))}
    </View>
  );
}

// Horizontal rail of circular avatars + name tick (share sheet "send to people").
export function AvatarRowSkeleton({ count = 6 }: { count?: number }) {
  return (
    <View style={s.avatarRow}>
      {Array.from({ length: count }).map((_, i) => (
        <View key={i} style={s.avatarRowItem}>
          <SkeletonCircle size={56} />
          <SkeletonLine w={42} h={8} style={{ marginTop: 7 }} />
        </View>
      ))}
    </View>
  );
}

// Full-screen vertical reel: full-bleed media + right action rail + bottom author/caption.
export function ReelSkeleton() {
  return (
    <View style={s.fullContainer}>
      <Skeleton width={SCREEN_W} height={SCREEN_H} radius={0} />
      <View style={s.reelRail}>
        {Array.from({ length: 5 }).map((_, i) => (
          <View key={i} style={s.reelRailItem}>
            <SkeletonCircle size={36} />
            <SkeletonLine w={22} h={8} style={{ marginTop: 6 }} />
          </View>
        ))}
      </View>
      <View style={s.reelBottom}>
        <View style={s.reelAuthor}>
          <SkeletonCircle size={32} />
          <SkeletonLine w={120} h={11} />
        </View>
        <SkeletonLine w="80%" h={10} style={{ marginTop: SPACING.sm }} />
        <SkeletonLine w="55%" h={10} style={{ marginTop: 6 }} />
      </View>
    </View>
  );
}

// Full-screen story viewer: full-bleed media + top progress segments + author row.
export function StorySkeleton() {
  return (
    <View style={s.fullContainer}>
      <Skeleton width={SCREEN_W} height={SCREEN_H} radius={0} />
      <View style={s.storyTop}>
        <View style={s.storyProgress}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} height={3} radius={2} style={{ flex: 1 }} />
          ))}
        </View>
        <View style={s.storyAuthor}>
          <SkeletonCircle size={32} />
          <SkeletonLine w={110} h={11} />
        </View>
      </View>
    </View>
  );
}

// Playlist / album detail: big cover + title/meta, then a track list.
export function PlaylistDetailSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <View style={s.flex}>
      <View style={s.plHeader}>
        <Skeleton width={150} height={150} radius={RADIUS.md} />
        <SkeletonLine w={190} h={18} style={{ marginTop: SPACING.md }} />
        <SkeletonLine w={130} h={12} style={{ marginTop: 9 }} />
        <SkeletonLine w={90} h={10} style={{ marginTop: 8 }} />
      </View>
      <TrackListSkeleton rows={rows} />
    </View>
  );
}

// Community detail: banner + name/desc/stats header, then a 3-col post grid.
export function CommunityDetailSkeleton() {
  return (
    <View style={s.flex}>
      <Skeleton width={SCREEN_W} height={140} radius={0} />
      <View style={s.communityHead}>
        <SkeletonLine w={180} h={18} />
        <SkeletonLine w="92%" h={11} style={{ marginTop: 10 }} />
        <SkeletonLine w="68%" h={11} style={{ marginTop: 7 }} />
        <View style={s.communityStats}>
          {Array.from({ length: 3 }).map((_, i) => (
            <View key={i} style={s.profileStat}>
              <SkeletonLine w={30} h={14} />
              <SkeletonLine w={48} h={9} style={{ marginTop: 6 }} />
            </View>
          ))}
        </View>
      </View>
      <GridSkeleton />
    </View>
  );
}

// Communities home: stacked horizontal rails of community cards.
export function CommunitiesSkeleton({ sections = 3 }: { sections?: number }) {
  return (
    <View style={[s.flex, { paddingTop: SPACING.sm }]}>
      {Array.from({ length: sections }).map((_, si) => (
        <View key={si} style={{ marginBottom: SPACING.lg }}>
          <SkeletonLine w={150} h={14} style={{ marginHorizontal: SPACING.md, marginBottom: SPACING.sm }} />
          <View style={s.railRow}>
            {Array.from({ length: 4 }).map((_, i) => (
              <View key={i} style={{ marginRight: SPACING.md }}>
                <Skeleton width={140} height={92} radius={RADIUS.md} />
                <SkeletonLine w={96} h={11} style={{ marginTop: 8 }} />
                <SkeletonLine w={62} h={9} style={{ marginTop: 6 }} />
              </View>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

// Analytics dashboard: stat-card grid + a wide rate card + toggle pills + chart cards.
export function AnalyticsSkeleton() {
  const W = SCREEN_W - SPACING.md * 2;
  const half = (W - SPACING.sm) / 2;
  const third = (W - SPACING.sm * 2) / 3;
  return (
    <View style={[s.flex, { padding: SPACING.md, gap: SPACING.md }]}>
      <View style={s.statGrid}>
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} width={half} height={86} radius={RADIUS.lg} style={{ marginBottom: SPACING.sm }} />
        ))}
      </View>
      <Skeleton width={W} height={72} radius={RADIUS.lg} />
      <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} width={third} height={32} radius={RADIUS.full} />)}
      </View>
      {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} width={W} height={150} radius={RADIUS.lg} />)}
    </View>
  );
}

// Discover content stack (music): section title + genre pills + track rows + card/artist rails.
export function DiscoverSkeleton() {
  return (
    <View style={[s.flex, { paddingTop: SPACING.sm }]}>
      <SkeletonLine w={120} h={22} style={{ marginHorizontal: SPACING.md, marginBottom: SPACING.sm }} />
      <View style={s.railRow}>
        {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} width={70} height={30} radius={RADIUS.full} style={{ marginRight: SPACING.sm }} />)}
      </View>
      <SkeletonLine w={100} h={14} style={{ marginHorizontal: SPACING.md, marginTop: SPACING.md, marginBottom: SPACING.sm }} />
      {Array.from({ length: 4 }).map((_, i) => <TrackRowSkeleton key={i} />)}
      <SkeletonLine w={130} h={14} style={{ marginHorizontal: SPACING.md, marginTop: SPACING.md, marginBottom: SPACING.sm }} />
      <View style={s.railRow}>
        {Array.from({ length: 3 }).map((_, i) => (
          <View key={i} style={{ marginRight: SPACING.md }}>
            <Skeleton width={120} height={120} radius={RADIUS.md} />
            <SkeletonLine w={92} h={11} style={{ marginTop: 8 }} />
            <SkeletonLine w={60} h={9} style={{ marginTop: 6 }} />
          </View>
        ))}
      </View>
      <SkeletonLine w={120} h={14} style={{ marginHorizontal: SPACING.md, marginTop: SPACING.md, marginBottom: SPACING.sm }} />
      <View style={s.railRow}>
        {Array.from({ length: 5 }).map((_, i) => (
          <View key={i} style={{ marginRight: SPACING.md, alignItems: 'center' }}>
            <SkeletonCircle size={64} />
            <SkeletonLine w={50} h={9} style={{ marginTop: 8 }} />
          </View>
        ))}
      </View>
    </View>
  );
}

// Full music screen: header title + Listen pill + search bar + 4 toggle pills + Discover.
export function MusicScreenSkeleton() {
  const W = SCREEN_W - SPACING.md * 2;
  return (
    <View style={s.flex}>
      <View style={s.musicHead}>
        <View style={s.musicHeadRow}>
          <SkeletonLine w={130} h={26} />
          <Skeleton width={84} height={32} radius={RADIUS.full} />
        </View>
        <Skeleton width={W} height={42} radius={RADIUS.full} style={{ marginTop: SPACING.md }} />
        <View style={{ flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.md }}>
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} width={(W - SPACING.sm * 3) / 4} height={34} radius={RADIUS.full} />)}
        </View>
      </View>
      <DiscoverSkeleton />
    </View>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  fullContainer: { flex: 1, backgroundColor: '#000' },

  post: { paddingBottom: SPACING.sm },
  postHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, gap: SPACING.sm },
  postHeaderText: { flex: 1 },
  postActions: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm },
  postCaption: { paddingHorizontal: SPACING.md, paddingTop: 2 },

  storiesRow: { flexDirection: 'row', paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, gap: SPACING.md },
  storyItem: { alignItems: 'center' },

  listRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm + 2, gap: SPACING.md },
  listRowText: { flex: 1 },

  grid: { flexDirection: 'row', flexWrap: 'wrap' },

  profileHead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.md, paddingTop: SPACING.md, gap: SPACING.lg },
  profileStats: { flex: 1, flexDirection: 'row', justifyContent: 'space-around' },
  profileStat: { alignItems: 'center' },
  profileBio: { paddingHorizontal: SPACING.md, paddingTop: SPACING.md },
  profileButtons: { flexDirection: 'row', gap: SPACING.sm, paddingHorizontal: SPACING.md, paddingTop: SPACING.md },
  tabStrip: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: SPACING.md, marginTop: SPACING.sm },

  comment: { flexDirection: 'row', gap: SPACING.sm, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm },
  commentBody: { flex: 1 },

  bubbleRow: { flexDirection: 'row' },
  bubbleLeft: { justifyContent: 'flex-start' },
  bubbleRight: { justifyContent: 'flex-end' },

  card: { borderWidth: 1, borderRadius: RADIUS.lg, padding: SPACING.md },
  cardTop: { flexDirection: 'row', gap: SPACING.sm },

  avatarRow: { flexDirection: 'row', paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, gap: SPACING.md },
  avatarRowItem: { alignItems: 'center' },

  reelRail: { position: 'absolute', right: SPACING.md, bottom: 120, gap: SPACING.lg, alignItems: 'center' },
  reelRailItem: { alignItems: 'center' },
  reelBottom: { position: 'absolute', left: SPACING.md, right: 72, bottom: SPACING.xl },
  reelAuthor: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },

  storyTop: { position: 'absolute', top: SPACING.xxl, left: SPACING.md, right: SPACING.md },
  storyProgress: { flexDirection: 'row', gap: 4 },
  storyAuthor: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginTop: SPACING.md },

  plHeader: { alignItems: 'center', paddingHorizontal: SPACING.md, paddingTop: SPACING.lg, paddingBottom: SPACING.md },

  communityHead: { paddingHorizontal: SPACING.md, paddingTop: SPACING.md },
  communityStats: { flexDirection: 'row', gap: SPACING.xl, marginTop: SPACING.md },

  railRow: { flexDirection: 'row', paddingHorizontal: SPACING.md },
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },

  musicHead: { paddingHorizontal: SPACING.md, paddingTop: SPACING.sm },
  musicHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
