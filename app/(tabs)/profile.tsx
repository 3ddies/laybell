import { useRouter, useFocusEffect } from 'expo-router';
import { useNavigation, useIsFocused } from '@react-navigation/native';
import { useAudio } from '../../contexts/AudioContext';
import { useAudioPlayer } from '../../hooks/useAudioPlayer';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, RefreshControl, PanResponder,
  Animated, Easing, Dimensions,
} from 'react-native';
// Content thumbnails use expo-image: memory+disk cached, so re-renders and
// remounts repaint instantly instead of flashing (RN's core Image flickers when
// list rows re-render with fresh source objects under the new architecture).
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { memo, useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { tabTick } from '../../lib/haptics';
import { usePostOptions } from '../../contexts/PostOptionsContext';
import { useTabSwipeControl } from '../../contexts/PagerContext';
import { useProfile } from '../../contexts/ProfileContext';
import { usePremium } from '../../contexts/PremiumContext';
import { applyMusicOrder, parseMusicOrder } from '../../lib/musicOrder';
import { useStories } from '../../contexts/StoriesContext';
import StoryAvatar from '../../components/StoryAvatar';
import BadgeEmblem from '../../components/BadgeEmblem';
import ProfileQRModal from '../../components/ProfileQRModal';
import { resolveRingColors, resolveBannerColors, chosenTier, specialRingTier, rawTier } from '../../lib/badges';
import { activePublicIds, fetchFirstTrackCovers } from '../../lib/playlists';
import { formatCount } from '../../lib/format';
import { displayUrl } from '../../lib/profileOptions';
import { useLinkGuard } from '../../contexts/LinkGuardContext';
import { activeLayout, usedPostIds, type PageLayout } from '../../lib/pageLayout';
import ProfileLayoutGrid from '../../components/ProfileLayoutGrid';
import { isAudioPost } from '../../lib/genres';
import { slideshowThumb } from '../../lib/slideshow';
import VideoThumb from '../../components/VideoThumb';
import ThumbStat from '../../components/ThumbStat';
import SpotlightThumbBadge from '../../components/SpotlightThumbBadge';
import TrackRow from '../../components/TrackRow';
import { fetchSpotlightedPostIds } from '../../lib/spotlight';
import { SPACING, RADIUS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { unseenShopActivityCount } from '../../lib/shop';
import TranslatableText from '../../components/TranslatableText';
import { ProfileSkeleton } from '../../components/Skeleton';

type Profile = {
  id: string; username: string; display_name: string;
  bio: string | null; avatar_url: string | null; badge_tier: string; created_at: string;
  link?: string | null;
};
type Stats = { followers: number; following: number; posts: number };

// Liked/Saved deliberately have no profile tabs anymore — they live in the
// Music page's pills. Playlists showcases the user's PUBLIC playlists.
const TABS = [
  { key: 'posts', label: 'Posts', icon: 'grid-outline' },
  { key: 'music', label: 'Music', icon: 'musical-notes-outline' },
  { key: 'videos', label: 'Videos', icon: 'videocam-outline' },
  { key: 'playlists', label: 'Playlists', icon: 'albums-outline' },
  { key: 'reposts', label: 'Reposts', icon: 'repeat-outline' },
];
const TAB_KEYS = TABS.map(t => t.key);
const SCREEN_W = Dimensions.get('window').width;

// Black or white, whichever reads on a given background — so a SOLID accent pill
// (light-mode active tab) stays legible whether the badge color is a light metal
// (gold/silver → dark text) or a saturated hue (→ white text).
function readableOn(hex: string): string {
  const h = hex.replace('#', '');
  if (h.length < 6) return '#FFFFFF';
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? '#16161A' : '#FFFFFF';
}

// Shared empty array so "no leftovers" keeps a stable identity across renders
// (a fresh [] every render would bust the memoized Posts page below).
const NO_POSTS: any[] = [];

// ── Memoized sub-tab content ─────────────────────────────────────────────────
// All five sub-tab pages stay MOUNTED (see the pager note in the render), so
// before this every parent re-render — a focus, an audio tick, a refetch that
// returned identical rows — rebuilt all five grids cell by cell. Each page is a
// memo() component taking data + identity-stable handlers, so a re-render that
// doesn't change what a page shows bails out instead of walking every cell.

type CellAction = (post: any) => void;

// One grid thumbnail. Re-renders only when its own post or spotlight flag moves.
const GridCell = memo(function GridCell({ post, spotlighted, onOpen, onLongPress, registerRef }: {
  post: any;
  spotlighted: boolean;
  onOpen: CellAction;
  onLongPress?: CellAction;
  registerRef: (id: string, node: any) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <TouchableOpacity
      ref={(n) => { if (n) registerRef(post.id, n); }}
      style={styles.gridItem}
      onLongPress={onLongPress ? () => onLongPress(post) : undefined}
      onPress={() => onOpen(post)}
    >
      {post.type === 'slideshow' ? (
        <>
          {/* Slide 1's screenshot (video) or slide 1 itself (image) */}
          <Image source={{ uri: slideshowThumb(post) ?? undefined }} style={styles.gridImage} contentFit="cover" />
          <View style={styles.gridPlayOverlay}>
            <Ionicons name="copy" size={13} color="#fff" />
          </View>
        </>
      ) : post.type === 'video' ? (
        <>
          <VideoThumb thumbnailUrl={post.thumbnail_url} mediaUrl={post.media_url} style={styles.gridImage} />
          <View style={styles.gridPlayOverlay}>
            <Ionicons name="play" size={14} color="#fff" />
          </View>
        </>
      ) : post.type === 'image' ? (
        <Image source={{ uri: post.media_url }} style={styles.gridImage} contentFit="cover" />
      ) : isAudioPost(post.type) && post.cover_url ? (
        <>
          <Image source={{ uri: post.cover_url }} style={styles.gridImage} contentFit="cover" />
          <View style={styles.gridPlayOverlay}>
            <Ionicons name="musical-notes" size={13} color="#fff" />
          </View>
        </>
      ) : (
        <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.gridPlaceholder}>
          <Ionicons
            name={isAudioPost(post.type) ? 'musical-notes' : 'videocam'}
            size={28} color={colors.primary}
          />
        </LinearGradient>
      )}
      {/* Subtle yellow sparkle when this post has a live spotlight. */}
      {spotlighted && <SpotlightThumbBadge />}
      {/* View count (video) / listen count (audio) */}
      <ThumbStat type={post.type} viewCount={post.view_count} streamCount={post.stream_count} />
    </TouchableOpacity>
  );
});

// The 3-up thumbnail grid shared by Posts / Videos / Reposts.
const PostsGrid = memo(function PostsGrid({
  data, tabKey, spotlightIds, fallbackArtist, onOpenVisual, onLongPressPost, onPlayQueue,
}: {
  data: any[];
  tabKey: string;
  spotlightIds: Set<string>;
  fallbackArtist: string;
  onOpenVisual: (post: any, node?: any) => void;
  onLongPressPost: (post: any, tabKey: string) => void;
  onPlayQueue: (queue: any[], index: number, alsoExpand?: boolean) => void;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  // Per-grid node map so opening a post expands out of the cell you actually
  // tapped. (One shared map across all five mounted tabs meant a post that
  // appears in two of them resolved to whichever hidden tab registered last.)
  const cellRefs = useRef<Record<string, any>>({});
  const registerRef = useCallback((id: string, node: any) => { cellRefs.current[id] = node; }, []);

  const handleOpen = useCallback((post: any) => {
    if (isAudioPost(post.type)) {
      const songs = data.filter((s: any) => isAudioPost(s.type));
      const idx = songs.findIndex((s: any) => s.id === post.id);
      onPlayQueue(
        songs.map((s: any) => ({ id: s.id, uri: s.media_url, caption: s.caption, artist: s.profiles?.display_name ?? fallbackArtist, cover: s.cover_url })),
        Math.max(0, idx),
      );
    } else {
      onOpenVisual(post, cellRefs.current[post.id]);
    }
  }, [data, fallbackArtist, onOpenVisual, onPlayQueue]);

  const handleLongPress = useCallback((post: any) => onLongPressPost(post, tabKey), [onLongPressPost, tabKey]);

  if (data.length === 0) {
    return (
      <View style={styles.emptyGrid}>
        <Ionicons
          name={tabKey === 'reposts' ? 'repeat-outline' : 'images-outline'}
          size={40}
          color={colors.textTertiary}
        />
        <Text style={styles.emptyGridText}>
          {t(`profile.empty.${tabKey}`)}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.postsGrid}>
      {data.map((post: any) => (
        <GridCell
          key={post.id}
          post={post}
          spotlighted={spotlightIds.has(post.id)}
          onOpen={handleOpen}
          // Own content (Posts / Videos) — long-press for edit/delete.
          // Reposts — long-press to remove the repost (via the options sheet).
          onLongPress={handleLongPress}
          registerRef={registerRef}
        />
      ))}
    </View>
  );
});

// The Posts tab: a custom feature layout (when active) above the normal grid of
// any leftover posts, or just the normal grid.
const PostsPage = memo(function PostsPage({
  pageLayout, allPosts, ordered, leftovers, spotlightIds, playingId, ownerTier, artistName,
  isActiveTab, fallbackArtist, onOpenVisual, onLongPressPost, onPlayQueue,
}: {
  pageLayout: PageLayout | null;
  allPosts: any[];
  ordered: any[];
  leftovers: any[];
  spotlightIds: Set<string>;
  playingId: string | null;
  ownerTier: string | null;
  artistName?: string;
  isActiveTab: boolean;
  fallbackArtist: string;
  onOpenVisual: (post: any, node?: any) => void;
  onLongPressPost: (post: any, tabKey: string) => void;
  onPlayQueue: (queue: any[], index: number, alsoExpand?: boolean) => void;
}) {
  // Focus is read HERE rather than in the screen body: it only ever feeds the
  // looping hero below, so the whole profile no longer re-renders every time
  // the tab gains or loses focus.
  const isFocused = useIsFocused();
  const grid = (
    <PostsGrid
      data={pageLayout ? leftovers : ordered}
      tabKey="posts"
      spotlightIds={spotlightIds}
      fallbackArtist={fallbackArtist}
      onOpenVisual={onOpenVisual}
      onLongPressPost={onLongPressPost}
      onPlayQueue={onPlayQueue}
    />
  );
  if (!pageLayout) return grid;
  return (
    <>
      <ProfileLayoutGrid
        layout={pageLayout}
        posts={allPosts}
        ownerTier={ownerTier}
        spotlightIds={spotlightIds}
        playingId={playingId}
        artistName={artistName}
        // Pause the looping hero when this sub-tab is hidden or the profile is
        // off-screen — a detached VideoView that plays to its end stalls black.
        active={isActiveTab && isFocused}
        onOpenVisual={onOpenVisual}
        onPlaySongs={(queue, idx) => onPlayQueue(queue, idx)}
        onLongPressPost={(post) => onLongPressPost(post, 'posts')}
      />
      {leftovers.length > 0 && grid}
    </>
  );
});

// Music tab: a scrollable list of "sound cards" (spotify-style TrackRows) —
// NOT the picture-thumbnail grid the other tabs use. The main Posts grid still
// shows audio posts as thumbnails (PostsGrid, default). `tracks` arrives already
// ordered by the screen (custom order, else spotlighted-first newest-first).
const MusicPage = memo(function MusicPage({
  tracks, spotlightIds, playingId, badgeProfile, ownerId, ownerName, ownerUsername,
  showReorder, onReorder, onPlayQueue, onTrackOptions,
}: {
  tracks: any[];
  spotlightIds: Set<string>;
  playingId: string | null;
  badgeProfile: any;
  ownerId?: string;
  ownerName: string;
  ownerUsername: string;
  showReorder: boolean;
  onReorder: () => void;
  onPlayQueue: (queue: any[], index: number, alsoExpand?: boolean) => void;
  onTrackOptions: (track: any) => void;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const queue = useMemo(
    () => tracks.map((tr: any) => ({
      id: tr.id, uri: tr.media_url, caption: tr.caption,
      artist: tr.profiles?.display_name ?? ownerName, cover: tr.cover_url,
    })),
    [tracks, ownerName],
  );

  if (tracks.length === 0) {
    return (
      <View style={styles.emptyGrid}>
        <Ionicons name="musical-notes-outline" size={40} color={colors.textTertiary} />
        <Text style={styles.emptyGridText}>{t('profile.noMusic')}</Text>
      </View>
    );
  }
  return (
    <View style={styles.musicList}>
      {/* Premium: arrange the Music tab in a custom order (see /music-order). */}
      {showReorder && (
        <TouchableOpacity style={styles.reorderMusicBtn} onPress={onReorder} activeOpacity={0.8}>
          <Ionicons name="swap-vertical" size={16} color={colors.primary} />
          <Text style={styles.reorderMusicText}>{t('profile.reorderMusic')}</Text>
        </TouchableOpacity>
      )}
      {tracks.map((track: any, i: number) => (
        <TrackRow
          key={track.id}
          caption={track.caption}
          artist={track.profiles?.display_name ?? ownerName}
          username={track.profiles?.username ?? ownerUsername}
          duration={track.duration_seconds}
          streams={track.stream_count ?? 0}
          cover={track.cover_url}
          badgeProfile={badgeProfile}
          badgeOwnerId={ownerId}
          spotlighted={spotlightIds.has(track.id)}
          isPlaying={playingId === track.id}
          onPlay={() => onPlayQueue(queue, i)}
          onCoverPress={() => onPlayQueue(queue, i, true)}
          onOptions={() => onTrackOptions(track)}
        />
      ))}
    </View>
  );
});

// Public playlists as showcase cards: cover art, name, listen count.
const PlaylistsPage = memo(function PlaylistsPage({ playlists, onOpen }: {
  playlists: any[];
  onOpen: (id: string) => void;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  // Same string countLabel('listen', n) builds, but through the CONTEXT-bound
  // translator: countLabel reads a module singleton the language provider only
  // syncs in an effect, so it lags one render behind a language switch — which
  // this memoized page would then never repaint away.
  const listens = (n: number) => t(`count.listen.${n === 1 ? 'one' : 'other'}`, { n: formatCount(n) });
  if (playlists.length === 0) {
    return (
      <View style={styles.emptyGrid}>
        <Ionicons name="albums-outline" size={40} color={colors.textTertiary} />
        <Text style={styles.emptyGridText}>{t('profile.noPlaylists')}</Text>
      </View>
    );
  }
  return (
    <View style={styles.plGrid}>
      {playlists.map((pl: any) => (
        <TouchableOpacity key={pl.id} style={styles.plCard} activeOpacity={0.8} onPress={() => onOpen(pl.id)}>
          {pl.cover ? (
            <Image source={{ uri: pl.cover }} style={styles.plCover} />
          ) : (
            <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.plCover}>
              <Ionicons name="musical-notes" size={26} color={colors.primary} />
            </LinearGradient>
          )}
          <Text style={styles.plName} numberOfLines={1}>{pl.name}</Text>
          <View style={styles.plMetaRow}>
            <Ionicons name="headset" size={11} color={colors.textTertiary} />
            <Text style={styles.plMeta}>{listens(pl.play_count ?? 0)}</Text>
          </View>
        </TouchableOpacity>
      ))}
    </View>
  );
});

export default function ProfileScreen() {
  const { show: showOptions } = usePostOptions();
  const { profile: liveProfile } = useProfile();
  const { isPremium } = usePremium();
  const { openCamera } = useStories();
  const { colors, mode } = useTheme();
  // Inactive category tabs used textTertiary, which reads too faint on white
  // next to the badge-tinted active-tab pill. In light mode step them up to the
  // stronger secondary gray so the tab row looks balanced; dark/grey stay put.
  const inactiveTabTint = mode === 'light' ? colors.textSecondary : colors.textTertiary;
  const { t } = useTranslation();
  const linkGuard = useLinkGuard();
  const styles = useThemedStyles(makeStyles);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [stats, setStats] = useState<Stats>({ followers: 0, following: 0, posts: 0 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [qrVisible, setQrVisible] = useState(false);
  const [activeTab, setActiveTab] = useState('posts');
  const [userPosts, setUserPosts] = useState<any[]>([]);
  // Post ids with a LIVE spotlight → a subtle sparkle on their grid thumbnail.
  const [spotlightIds, setSpotlightIds] = useState<Set<string>>(new Set());
  const [repostedPosts, setRepostedPosts] = useState<any[]>([]);
  // Active public playlists (over-limit "locked" ones stay hidden, same as in
  // public discovery), faced with their first track's cover.
  const [publicPlaylists, setPublicPlaylists] = useState<any[]>([]);
  const router = useRouter();
  const navigation = useNavigation();
  const { playQueue, expand } = useAudio();
  const { playingId } = useAudioPlayer();

  // The audio and post-options providers hand out fresh callbacks on every one
  // of their renders — parking them behind a ref lets every handler below stay
  // identity-stable, which is what keeps the memoized sub-tab pages from
  // re-rendering on unrelated updates (an audio tick, a sheet opening).
  const liveRef = useRef({ playQueue, expand, showOptions, router });
  liveRef.current = { playQueue, expand, showOptions, router };

  // Unaddressed/unseen shop activity (pending sale requests, freshly delivered
  // or declined orders) → red alert dot on the Shop button, refreshed whenever
  // the profile regains focus (e.g. returning from the shop hub clears it).
  const [shopAlertCount, setShopAlertCount] = useState(0);
  useFocusEffect(useCallback(() => {
    unseenShopActivityCount().then(setShopAlertCount).catch(() => {});
  }, []));

  // ── Sub-tab navigation: Music-page pattern, NO pager ──────────────────────
  // One fling PanResponder on the page ROOT steps the sub-tabs (with the same
  // slide-in animation as the Music pills). Taps and vertical scrolls are
  // untouched (decisive horizontal moves only).
  //
  // EXIT (Posts → Music tab): while the Posts sub-tab is active, the OUTER tab
  // pager is enabled, so a rightward swipe is the real app-pager drag — live
  // finger tracking, drag-and-hold, exactly like swiping between main tabs.
  // The fling responder deliberately ignores rightward moves on Posts (the
  // pager owns them) and keeps owning leftward steps + both directions on the
  // other sub-tabs (pager off there, so nothing fights).
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const setTabSwipe = useTabSwipeControl();
  // True while a fling gesture owns the touch — the activeTab effect below must
  // NOT re-enable the pager mid-gesture (stepping INTO Posts would let it grab
  // the rest of the same touch); release/terminate restore it instead.
  const gestureActiveRef = useRef(false);
  useFocusEffect(useCallback(() => {
    setTabSwipe(activeTabRef.current === 'posts');
    return () => setTabSwipe(true); // leaving Profile — other tabs manage their own
  }, [setTabSwipe]));
  useEffect(() => {
    if (!gestureActiveRef.current) setTabSwipe(activeTab === 'posts');
  }, [activeTab, setTabSwipe]);

  // Slide the incoming sub-tab in from the travel direction (Music-pill style).
  const tabAnimX = useRef(new Animated.Value(0)).current;
  const prevTabIdxRef = useRef(0);
  useEffect(() => {
    const idx = TAB_KEYS.indexOf(activeTab);
    if (idx !== prevTabIdxRef.current) {
      const dir = idx > prevTabIdxRef.current ? 1 : -1;
      tabAnimX.setValue(dir * SCREEN_W);
      Animated.timing(tabAnimX, { toValue: 0, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    }
    prevTabIdxRef.current = idx;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // While a finger is on the tabs PILL ROW, the page responder stands down so
  // the row scrolls (traversal) instead of stepping the sub-tab.
  const tabsRowTouchRef = useRef(false);
  // One step per gesture — armed on grant, spent the moment a step fires.
  const swipeFiredRef = useRef(false);

  // Step the sub-tab for a decisive horizontal gesture. On Posts, rightward
  // moves never reach here (the outer pager owns the live exit drag); the
  // navigate('music') branch is only a release-time safety net.
  const stepForGesture = (dx: number, allowExit: boolean) => {
    const idx = TAB_KEYS.indexOf(activeTabRef.current);
    if (dx < 0) {
      if (idx < TAB_KEYS.length - 1) { swipeFiredRef.current = true; setActiveTab(TAB_KEYS[idx + 1]); }
    } else if (idx === 0) {
      // Swipe-driven exit to the Music tab (release-time fallback when the outer
      // pager didn't claim the drag) — tick like any swipe landing on a new tab.
      if (allowExit) { swipeFiredRef.current = true; tabTick(); (navigation as any).navigate('music'); }
    } else {
      swipeFiredRef.current = true; setActiveTab(TAB_KEYS[idx - 1]);
    }
  };

  const pageSwipePan = useRef(PanResponder.create({
    // Forgiving dominance bar (1.25×) so slightly diagonal side-swipes register.
    // On Posts, rightward moves are left to the OUTER pager (the live exit
    // drag) — claiming them here would kill its finger tracking.
    onMoveShouldSetPanResponder: (_e, g) =>
      !tabsRowTouchRef.current &&
      !(activeTabRef.current === 'posts' && g.dx > 0) &&
      Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.25,
    // A LEFTWARD step claimed on Posts must shut the outer pager off for the
    // rest of the gesture (same in-touch toggle the Music rails use), so it
    // can't also start dragging; restored on release/terminate.
    onPanResponderGrant: () => {
      swipeFiredRef.current = false;
      gestureActiveRef.current = true;
      if (activeTabRef.current === 'posts') setTabSwipe(false);
    },
    // Once claimed, never surrender mid-gesture — a child stealing the responder
    // meant the release handler never ran and the swipe silently vanished.
    onPanResponderTerminationRequest: () => false,
    // Fire the step the moment the gesture is DECISIVE (distance or flick) —
    // not on finger lift — so the switch starts with no perceptible delay.
    onPanResponderMove: (_e, g) => {
      if (swipeFiredRef.current) return;
      if (Math.abs(g.dx) < 40 && Math.abs(g.vx) < 0.3) return;
      stepForGesture(g.dx, false);
    },
    onPanResponderRelease: (_e, g) => {
      gestureActiveRef.current = false;
      if (swipeFiredRef.current === false && (Math.abs(g.dx) >= 40 || Math.abs(g.vx) >= 0.3)) {
        stepForGesture(g.dx, true);
      }
      // Gesture over — hand the outer pager back if we ended up on Posts.
      setTabSwipe(activeTabRef.current === 'posts');
    },
    onPanResponderTerminate: () => {
      gestureActiveRef.current = false;
      setTabSwipe(activeTabRef.current === 'posts');
    },
  })).current;

  // Refetch signatures. The focus refetch below still runs on EVERY focus (so a
  // post reposted elsewhere shows up), but it only pushes state when the rows
  // actually changed — identical data means zero setState, zero re-render, and
  // stable array/Set identities so every memo on the page holds. Local edits
  // (delete / archive / un-repost) clear the matching signature so the next
  // fetch is always applied on top of them.
  const profileSigRef = useRef('');
  const postsSigRef = useRef('');
  const repostsSigRef = useRef('');
  const playlistsSigRef = useRef('');
  const spotlightSigRef = useRef('');

  // Refetch on focus so a post reposted elsewhere shows up in the Reposts tab.
  useFocusEffect(useCallback(() => { fetchProfile(); }, []));

  async function fetchProfile() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const [profileRes, followersRes, followingRes, postsCountRes, postsRes, repostsRes, playlistsRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', user.id).single(),
      supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', user.id),
      supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', user.id),
      // Exclude archived posts so the count matches the grid (which filters them too).
      supabase.from('posts').select('*', { count: 'exact', head: true }).eq('user_id', user.id).is('archived_at', null),
      supabase.from('posts').select('*').eq('user_id', user.id).eq('is_public', true).order('created_at', { ascending: false }),
      supabase.from('reposts').select('posts(*, profiles!posts_user_id_fkey(display_name))').eq('user_id', user.id).order('created_at', { ascending: false }).limit(100),
      supabase.from('playlists').select('*').eq('user_id', user.id).eq('is_public', true).order('play_count', { ascending: false }),
    ]);

    if (profileRes.data) {
      const sig = JSON.stringify(profileRes.data);
      if (sig !== profileSigRef.current) { profileSigRef.current = sig; setProfile(profileRes.data); }
    }
    const followers = followersRes.count || 0, following = followingRes.count || 0, posts = postsCountRes.count || 0;
    setStats(prev => (prev.followers === followers && prev.following === following && prev.posts === posts)
      ? prev
      : { followers, following, posts });
    // Archived posts (archived_at set) are hidden from the grid but kept in the
    // Archive screen. archived_at is absent pre-migration → harmless no-op.
    if (postsRes.data) {
      const visible = postsRes.data.filter((p: any) => !p.archived_at);
      const sig = JSON.stringify(visible);
      if (sig !== postsSigRef.current) { postsSigRef.current = sig; setUserPosts(visible); }
      // Flag which of these are currently spotlighted (one batched query).
      fetchSpotlightedPostIds(visible.map((p: any) => p.id)).then((ids) => {
        const idSig = [...ids].sort().join(',');
        if (idSig !== spotlightSigRef.current) { spotlightSigRef.current = idSig; setSpotlightIds(ids); }
      });
    }
    // `reposts` may not be migrated yet — degrade to an empty tab if so.
    const reposted = (repostsRes.data ?? []).map((r: any) => r.posts).filter(Boolean);
    const repostSig = JSON.stringify(reposted);
    if (repostSig !== repostsSigRef.current) { repostsSigRef.current = repostSig; setRepostedPosts(reposted); }
    // Public playlists tab: only the ones holding an active badge slot, faced
    // with their first track's cover. Degrades to empty pre-migration.
    try {
      const pls = playlistsRes.data ?? [];
      const active = activePublicIds(pls as any, rawTier(profileRes.data));
      const shown = pls.filter((p: any) => active.has(p.id));
      const covers = await fetchFirstTrackCovers(shown.map((p: any) => p.id));
      const faced = shown.map((p: any) => ({ ...p, cover: covers[p.id] ?? null }));
      const plSig = JSON.stringify(faced);
      if (plSig !== playlistsSigRef.current) { playlistsSigRef.current = plSig; setPublicPlaylists(faced); }
    } catch {
      if (playlistsSigRef.current !== '[]') { playlistsSigRef.current = '[]'; setPublicPlaylists([]); }
    }
    setLoading(false);
    setRefreshing(false);
  }

  // ── Stable handlers ────────────────────────────────────────────────────────
  // Every callback handed to a memoized page below is created once, reading
  // anything volatile through liveRef.

  // Drop a post from the grid after a delete/archive. Clearing the signature
  // makes the next focus refetch authoritative again even if the server still
  // reports the old row set.
  const removePost = useCallback((id: string) => {
    postsSigRef.current = '';
    setUserPosts(prev => prev.filter(p => p.id !== id));
    setStats(prev => ({ ...prev, posts: Math.max(0, prev.posts - 1) }));
  }, []);

  // Open an image/slideshow post or a reel, expanding out of the tapped cell
  // (shared by the normal grid and the custom layout blocks).
  const openVisual = useCallback((post: any, node?: any) => {
    const pathname = post.type === 'video' ? '/reel/[id]' : '/post/[id]';
    const seed = JSON.stringify(post);
    if (node?.measureInWindow) {
      node.measureInWindow((x: number, y: number, width: number, height: number) =>
        liveRef.current.router.push({ pathname, params: { id: post.id, post: seed, src: JSON.stringify({ x, y, width, height }) } }));
    } else {
      liveRef.current.router.push({ pathname, params: { id: post.id, post: seed } });
    }
  }, []);

  // Long-press sheet. Own content (Posts / Videos, and the custom layout blocks)
  // → edit / delete / archive; Reposts → remove the repost.
  const onLongPressPost = useCallback((post: any, tabKey: string) => {
    if (tabKey === 'reposts') {
      liveRef.current.showOptions({
        postId: post.id,
        isOwn: false,
        onRepostChanged: (reposted) => {
          if (!reposted) {
            repostsSigRef.current = '';
            setRepostedPosts(prev => prev.filter(p => p.id !== post.id));
          }
        },
      });
      return;
    }
    liveRef.current.showOptions({
      postId: post.id,
      isOwn: true,
      mediaType: post.type,
      aspect: post.aspect_ratio,
      caption: post.caption,
      thumbnail: post.thumbnail_url,
      onEdit: () => liveRef.current.router.push(`/edit-post/${post.id}`),
      onDeleted: () => removePost(post.id),
      onArchived: () => removePost(post.id),
    });
  }, [removePost]);

  // The Music tab's own sheet (no aspect/caption/thumbnail — a sound card has
  // no thumbnail preview to hand the sheet).
  const onTrackOptions = useCallback((track: any) => {
    liveRef.current.showOptions({
      postId: track.id,
      isOwn: true,
      mediaType: track.type,
      onEdit: () => liveRef.current.router.push(`/edit-post/${track.id}`),
      onDeleted: () => removePost(track.id),
      onArchived: () => removePost(track.id),
    });
  }, [removePost]);

  const playTracks = useCallback((queue: any[], index: number, alsoExpand = false) => {
    liveRef.current.playQueue(queue, index);
    if (alsoExpand) liveRef.current.expand();
  }, []);

  const openPlaylist = useCallback((id: string) => { liveRef.current.router.push(`/playlist/${id}`); }, []);
  const openMusicOrder = useCallback(() => { liveRef.current.router.push('/music-order'); }, []);

  // ── Derived per-tab data ───────────────────────────────────────────────────
  // Memoized (and above the loading early-return, so the hook order never
  // changes): these used to be recomputed for every tab on every render.

  // Prefer the global ProfileContext copy (live tier + avatar, kept in sync after
  // edits / badge changes); fall back to this screen's own fetch on first paint.
  const badgeProfile = liveProfile ?? profile;

  // The custom Posts-grid layout, if the user has one AND still qualifies for its
  // tier (activeLayout re-checks earned tier + resolves blocks against live posts).
  const pageLayout = useMemo(() => activeLayout(badgeProfile, userPosts), [badgeProfile, userPosts]);

  const musicPosts = useMemo(() => userPosts.filter((p: any) => p.type === 'audio'), [userPosts]);
  const videoPosts = useMemo(() => userPosts.filter((p: any) => p.type === 'video'), [userPosts]);

  // Posts tab ordering: float live-spotlighted posts to the TOP (newest-first
  // among them), everyone else newest-first. When a spotlight expires the post
  // drops out of spotlightIds → it returns to default placement. Skipped entirely
  // if the user runs a custom page layout — then their own arrangement wins.
  const orderedPosts = useMemo(() => {
    if (pageLayout) return userPosts;
    return [...userPosts].sort((a, b) => {
      const sa = spotlightIds.has(a.id) ? 1 : 0;
      const sb = spotlightIds.has(b.id) ? 1 : 0;
      if (sa !== sb) return sb - sa;
      return String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
    });
  }, [userPosts, spotlightIds, pageLayout]);

  // Posts a custom layout doesn't already show — they fall through to the grid
  // underneath it.
  const layoutLeftovers = useMemo(() => {
    if (!pageLayout) return NO_POSTS;
    const used = usedPostIds(pageLayout.blocks);
    return userPosts.filter((p: any) => !used.has(p.id));
  }, [pageLayout, userPosts]);

  // A saved custom order (Premium perk — see /music-order) WINS: the tab shows
  // the user's exact arrangement (new songs appended newest-first). With no
  // custom order, live-spotlighted tracks float to the TOP (newest-first among
  // them), the rest most-recent → least-recent.
  const musicTracks = useMemo(() => {
    const order = parseMusicOrder((profile as any)?.music_order);
    if (order.length) return applyMusicOrder([...musicPosts], order);
    return [...musicPosts].sort((a, b) => {
      const sa = spotlightIds.has(a.id) ? 1 : 0;
      const sb = spotlightIds.has(b.id) ? 1 : 0;
      if (sa !== sb) return sb - sa;
      return String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
    });
  }, [musicPosts, spotlightIds, profile]);

  if (loading) {
    return <View style={[styles.loadingContainer, { justifyContent: 'flex-start' }]}><ProfileSkeleton /></View>;
  }

  const myTier = chosenTier(badgeProfile);
  const ringColors = resolveRingColors(badgeProfile, myTier);
  const bannerColors = resolveBannerColors(myTier, colors.background);
  const avatarUrl = liveProfile?.avatar_url ?? profile?.avatar_url;
  // Active sub-tab pill + glow take the user's emblem-theme color (orange default
  // when they have no badge). Visible on public profiles too (owner's tier).
  const tabAccent = myTier ? ringColors[0] : colors.primary;
  // Light mode: a SOLID accent pill so the active tab clearly separates from the
  // white background (a faint tint let light/metallic badge colors blend in).
  // Dark/grey keep the softer tinted pill (they already read fine).
  const solidActive = mode === 'light';
  const activeTabDyn = solidActive
    ? {
        backgroundColor: tabAccent, borderColor: tabAccent,
        shadowColor: tabAccent, shadowOpacity: 0.32, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 3,
      }
    : {
        backgroundColor: tabAccent + '1F', borderColor: tabAccent + '4D',
        shadowColor: tabAccent, shadowOpacity: 0.28, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 2,
      };
  // On the solid pill, text/icon flip to black/white for contrast; otherwise the
  // accent color on the tinted pill (unchanged).
  const activeContent = solidActive ? readableOn(tabAccent) : tabAccent;

  return (
    // pageSwipePan lives on the ROOT: flings anywhere — header, grid, empty
    // space — step the sub-tabs; a right-fling on Posts exits to Music.
    <View style={styles.container} {...pageSwipePan.panHandlers}>
      <View>
      <View style={styles.headerBar}>
        <Text style={styles.usernameHeader}>@{profile?.username}</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity
            onPress={() => setQrVisible(true)}
            style={styles.settingsBtn}
            accessibilityRole="button"
            accessibilityLabel={t('qr.a11y')}
            disabled={!profile?.id}
          >
            <Ionicons name="qr-code-outline" size={22} color={colors.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.push('/settings')} style={styles.settingsBtn}>
            <Ionicons name="settings-outline" size={22} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      </View>

      {!!profile?.id && (
        <ProfileQRModal
          visible={qrVisible}
          onClose={() => setQrVisible(false)}
          userId={profile.id}
          username={profile.username}
          displayName={profile.display_name}
          avatarUrl={avatarUrl}
        />
      )}

      {/* Banner — tinted by the user's chosen profile theme (gated by tier) */}
      <LinearGradient colors={bannerColors} style={styles.banner}>
        <View style={styles.avatarWrap}>
          <StoryAvatar
            userId={profile?.id}
            avatarUrl={avatarUrl}
            name={profile?.display_name}
            size={88}
            badgeRing={specialRingTier(myTier) ? ringColors : undefined}
            onPressProfile={() => router.push('/edit-profile')}
            showAdd
            addColors={myTier ? ringColors : undefined}
            onPressAdd={openCamera}
          />
        </View>
        <View style={styles.statsRow}>
          {[
            { label: t('profile.tab.posts'), val: stats.posts, onPress: undefined },
            { label: t('profile.followers'), val: stats.followers, onPress: () => router.push(`/followers/${profile?.id}`) },
            { label: t('profile.following'), val: stats.following, onPress: () => router.push(`/following/${profile?.id}`) },
          ].map(({ label, val, onPress }) => (
            <TouchableOpacity key={label} style={styles.statItem} onPress={onPress} disabled={!onPress}>
              <Text style={styles.statNumber}>{val}</Text>
              <Text style={styles.statLabel}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </LinearGradient>

      {/* Name + bio — with the Spotlight shortcut on the right */}
      <View style={styles.infoSection}>
        <View style={styles.infoRow}>
          <View style={styles.infoLeft}>
            <View style={styles.nameRow}>
              <Text style={styles.displayName}>{profile?.display_name}</Text>
              {myTier ? (
                <BadgeEmblem profile={badgeProfile} size={17} />
              ) : (
                // No badge chosen (Default theme) → a tappable outline placeholder that
                // only YOU see (visitors see nothing), linking to the Badges page.
                <TouchableOpacity
                  style={styles.badgeOutline}
                  activeOpacity={0.7}
                  hitSlop={8}
                  onPress={() => router.push('/badges')}
                >
                  <Ionicons name="add" size={12} color={colors.textTertiary} />
                </TouchableOpacity>
              )}
            </View>
            {profile?.bio
              ? <TranslatableText text={profile.bio} style={styles.bio} />
              : <Text style={styles.bioEmpty}>{t('profile.noBio')}</Text>
            }
            {badgeProfile?.link ? (
              <TouchableOpacity style={styles.linkRow} onPress={() => linkGuard.open(badgeProfile.link!, { context: 'bio' })}>
                <Ionicons name="link-outline" size={14} color={colors.primary} />
                <Text style={styles.linkText} numberOfLines={1}>{displayUrl(badgeProfile.link)}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          <View style={styles.sideBtns}>
            <TouchableOpacity
              style={styles.shopBtn}
              activeOpacity={0.8}
              // With pending activity the tap lands straight on the Orders tab
              // (the thing the red dot is about); otherwise My Shop as usual.
              onPress={() => router.push(shopAlertCount > 0 ? '/shop?tab=orders' : '/shop?tab=mine')}
            >
              <Ionicons name="storefront" size={15} color="#fff" />
              <Text style={styles.shopBtnText}>{t('shop.title')}</Text>
              {/* Unaddressed/unseen shop activity (new sale request, delivered
                  file, declined offer) — same red alert treatment as the
                  notification/message bells, anchored top-left per design. */}
              {shopAlertCount > 0 && (
                <View style={styles.shopAlertDot}>
                  <Text style={styles.shopAlertText}>{shopAlertCount > 9 ? '9+' : shopAlertCount}</Text>
                </View>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.spotlightBtn}
              activeOpacity={0.8}
              onPress={() => router.push('/spotlight')}
            >
              <Ionicons name="sparkles" size={15} color="#fff" />
              <Text style={styles.spotlightBtnText}>Spotlight</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* Action buttons */}
      <View style={styles.actionButtons}>
        <TouchableOpacity style={styles.editButton} onPress={() => router.push('/edit-profile')}>
          <Text style={styles.editButtonText}>{t('profile.editProfile')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryButton} onPress={() => router.push('/friends')}>
          <Ionicons name="people-outline" size={18} color={colors.text} />
        </TouchableOpacity>
      </View>

      {/* Tabs — tap to switch; swiping ON this row scrolls the pills
          (traversal) rather than stepping the sub-tab. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tabsScroll}
        onTouchStart={() => { tabsRowTouchRef.current = true; }}
        onTouchEnd={() => { tabsRowTouchRef.current = false; }}
        onTouchCancel={() => { tabsRowTouchRef.current = false; }}
      >
        <View style={styles.tabsRow}>
          {TABS.map((tab) => (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tab, activeTab === tab.key && activeTabDyn]}
              onPress={() => setActiveTab(tab.key)}
            >
              <Ionicons
                name={activeTab === tab.key ? tab.icon.replace('-outline', '') as any : tab.icon as any}
                size={16}
                color={activeTab === tab.key ? activeContent : inactiveTabTint}
              />
              <Text style={[
                styles.tabText,
                activeTab === tab.key ? { color: activeContent, fontWeight: '700' } : { color: inactiveTabTint },
              ]}>
                {t(`profile.tab.${tab.key}`)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
      </View>

      {/* Sub-tab pages — ALL stay mounted; switching just flips visibility, so
          a step never pays a grid-mount cost mid-swipe (that mount was what
          made non-Posts swipes feel slow). The visible page slides in from the
          travel direction (same pattern as the Music pills). */}
      <Animated.View style={[styles.pager, { transform: [{ translateX: tabAnimX }] }]}>
        {TAB_KEYS.map((key) => (
          <View key={key} style={key === activeTab ? styles.pager : styles.pageHidden}>
            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.pageContent}
              refreshControl={
                <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchProfile(); }} tintColor={tabAccent} colors={[tabAccent]} />
              }
            >
              {key === 'playlists' ? (
                <PlaylistsPage playlists={publicPlaylists} onOpen={openPlaylist} />
              ) : key === 'music' ? (
                <MusicPage
                  tracks={musicTracks}
                  spotlightIds={spotlightIds}
                  playingId={playingId}
                  badgeProfile={badgeProfile}
                  ownerId={profile?.id}
                  ownerName={profile?.display_name ?? ''}
                  ownerUsername={profile?.username ?? ''}
                  showReorder={isPremium && musicTracks.length > 1}
                  onReorder={openMusicOrder}
                  onPlayQueue={playTracks}
                  onTrackOptions={onTrackOptions}
                />
              ) : key === 'posts' ? (
                <PostsPage
                  pageLayout={pageLayout}
                  allPosts={userPosts}
                  ordered={orderedPosts}
                  leftovers={layoutLeftovers}
                  spotlightIds={spotlightIds}
                  playingId={playingId}
                  ownerTier={rawTier(badgeProfile)}
                  artistName={profile?.display_name}
                  isActiveTab={activeTab === 'posts'}
                  fallbackArtist={profile?.display_name ?? ''}
                  onOpenVisual={openVisual}
                  onLongPressPost={onLongPressPost}
                  onPlayQueue={playTracks}
                />
              ) : (
                <PostsGrid
                  data={key === 'videos' ? videoPosts : repostedPosts}
                  tabKey={key}
                  spotlightIds={spotlightIds}
                  fallbackArtist={profile?.display_name ?? ''}
                  onOpenVisual={openVisual}
                  onLongPressPost={onLongPressPost}
                  onPlayQueue={playTracks}
                />
              )}
            </ScrollView>
          </View>
        ))}
      </Animated.View>
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  loadingContainer: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },

  headerBar: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: SPACING.md, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.sm,
  },
  usernameHeader: { color: colors.text, fontSize: 24, fontWeight: '900' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  settingsBtn: { padding: 4 },

  banner: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: SPACING.md, paddingTop: SPACING.md, paddingBottom: SPACING.lg, gap: SPACING.lg,
    borderBottomLeftRadius: RADIUS.xl, borderBottomRightRadius: RADIUS.xl,
  },
  avatarWrap: { alignItems: 'center', justifyContent: 'center' },
  avatarRing: { width: 88, height: 88, borderRadius: RADIUS.full, padding: 3, alignItems: 'center', justifyContent: 'center' },
  avatarImage: { width: 82, height: 82, borderRadius: RADIUS.full },
  avatarPlaceholder: { width: 82, height: 82, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.text, fontSize: 32, fontWeight: '700' },

  statsRow: {
    flex: 1, flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.28)', borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', paddingVertical: SPACING.sm,
  },
  statItem: { flex: 1, alignItems: 'center', gap: 3 },
  statNumber: { color: '#FFFFFF', fontSize: 21, fontWeight: '800', letterSpacing: -0.3 },
  statLabel: { color: 'rgba(245,245,245,0.7)', fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 },

  infoSection: { paddingHorizontal: SPACING.md, paddingTop: SPACING.md },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  infoLeft: { flex: 1, gap: 4 },
  // Shop (green) stacked above Spotlight (orange) — both solid with white text.
  sideBtns: { gap: SPACING.sm, alignItems: 'stretch' },
  shopBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    backgroundColor: colors.success,
    borderRadius: RADIUS.full,
    paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md,
  },
  shopBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  // Red alert circle (top-left of the Shop button) for unaddressed/unseen shop
  // activity — same recipe as the home header's notification badge, with a
  // background ring so it pops off the green pill.
  shopAlertDot: {
    position: 'absolute', top: -5, left: -5,
    minWidth: 17, height: 17, borderRadius: 8.5,
    backgroundColor: colors.error, paddingHorizontal: 3,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: colors.background,
  },
  shopAlertText: { color: '#fff', fontSize: 9, fontWeight: '800' },
  spotlightBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    backgroundColor: colors.primary,
    borderRadius: RADIUS.full,
    paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md,
  },
  spotlightBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  displayName: { color: colors.text, fontSize: 17, fontWeight: '800', letterSpacing: -0.2 },
  badgeOutline: {
    width: 19, height: 19, borderRadius: RADIUS.full,
    borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center',
  },
  bio: { color: colors.textSecondary, fontSize: 14, lineHeight: 20 },
  bioEmpty: { color: colors.textTertiary, fontSize: 14, fontStyle: 'italic' },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  linkText: { color: colors.primary, fontSize: 13, fontWeight: '600' },

  actionButtons: { flexDirection: 'row', paddingHorizontal: SPACING.md, paddingTop: SPACING.md, gap: SPACING.sm },
  editButton: {
    flex: 1, backgroundColor: colors.surfaceElevated,
    borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.full, paddingVertical: SPACING.sm + 2, alignItems: 'center',
  },
  editButtonText: { color: colors.text, fontSize: 14, fontWeight: '700', letterSpacing: 0.2 },
  secondaryButton: {
    backgroundColor: colors.surfaceElevated, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.full, paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm + 2, alignItems: 'center', justifyContent: 'center',
  },

  tabsScroll: { marginTop: SPACING.md, borderBottomWidth: 0.5, borderBottomColor: colors.border, flexGrow: 0 },
  tabsRow: { flexDirection: 'row', paddingHorizontal: SPACING.sm, paddingVertical: SPACING.sm, gap: 4 },
  tab: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.full, borderWidth: 1, borderColor: 'transparent',
  },
  activeTab: { backgroundColor: colors.primary + '18', borderColor: colors.primary + '3A' },
  tabText: { color: colors.textTertiary, fontSize: 12, fontWeight: '600' },
  activeTabText: { color: colors.primary, fontWeight: '700' },

  pager: { flex: 1 },
  // Off-tab pages stay MOUNTED but invisible — flipping display is what makes
  // a sub-tab step instant (no grid mount mid-swipe).
  pageHidden: { display: 'none' },
  pageContent: { paddingBottom: SPACING.xxl + 80 },

  // 2px gutters between cells (gap needs pixel-sized items — thirds would overflow the row).
  postsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 2 },
  musicList: { paddingHorizontal: SPACING.md, paddingTop: SPACING.sm, gap: SPACING.sm },
  reorderMusicBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: SPACING.sm, borderRadius: RADIUS.full,
    borderWidth: 1, borderColor: colors.primary + '44', backgroundColor: colors.primary + '10',
  },
  reorderMusicText: { color: colors.primaryLight, fontSize: 13.5, fontWeight: '700' },
  gridItem: { width: (SCREEN_W - 4) / 3, aspectRatio: 1, position: 'relative' },
  gridImage: { width: '100%', height: '100%' },
  gridPlaceholder: {
    width: '100%', height: '100%',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 0.5, borderColor: colors.border,
  },
  // (kept for reposts overlay parity if needed later)
  gridBadge: {
    position: 'absolute', top: 6, right: 6,
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  gridPlayOverlay: {
    position: 'absolute', top: 6, left: 6,
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center',
  },
  emptyGrid: { alignItems: 'center', paddingTop: SPACING.xxl, gap: SPACING.sm },
  emptyGridText: { color: colors.textTertiary, fontSize: 14 },

  // Public playlists tab — 2-up showcase cards (cover, name, listens).
  plGrid: {
    flexDirection: 'row', flexWrap: 'wrap',
    paddingHorizontal: SPACING.md, paddingTop: SPACING.md,
    columnGap: SPACING.md, rowGap: SPACING.lg,
  },
  plCard: { width: '47%' },
  plCover: {
    width: '100%', aspectRatio: 1, borderRadius: RADIUS.md,
    backgroundColor: colors.surfaceLight, alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden',
  },
  plName: { color: colors.text, fontSize: 14, fontWeight: '700', marginTop: 8 },
  plMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  plMeta: { color: colors.textTertiary, fontSize: 12 },
});
