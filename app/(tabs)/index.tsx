import {
  buildAffinityProfile, loadSeenPostIds, recordSeenPostIds, scorePost,
  EMPTY_PROFILE, type UserAffinityProfile,
} from '../../lib/feedScorer';
import { Video, ResizeMode } from 'expo-av';
import { useRouter, useFocusEffect } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { usePagerSwiping, isSwipeTap } from '../../contexts/PagerContext';
import {
  View, Text, StyleSheet, FlatList,
  TouchableOpacity, Image, ActivityIndicator,
  RefreshControl, Dimensions, Alert, Modal, Animated,
} from 'react-native';

const SCREEN_W = Dimensions.get('window').width;
const MAX_VIDEO_H = SCREEN_W * 1.25; // cap feed video at 4:5 so tall (9:16) clips aren't too long
import { useEffect, useState, useCallback, useRef, memo } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { bumpBadge } from '../../lib/badges';
import { SPACING, RADIUS, SHADOWS, GRADIENTS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { timeAgo } from '../../lib/timeAgo';
import { useAudio } from '../../contexts/AudioContext';
import { createNotification } from '../../lib/createNotification';
import { usePostOptions } from '../../contexts/PostOptionsContext';
import { useShare } from '../../contexts/ShareContext';
import { isAudioPost } from '../../lib/genres';
import { fetchBlockedIds } from '../../lib/blocks';
import {
  fetchFeedSpotlights, mergeSpotlights, rankSpotlight,
  recordSpotlightImpression, recordSpotlightTap, type SpotlightMeta,
} from '../../lib/spotlight';
import AddToPlaylistModal from '../../components/AddToPlaylistModal';
import CommentsSheet from '../../components/CommentsSheet';
import ElasticSwipeView from '../../components/ElasticSwipeView';
import FollowButton from '../../components/FollowButton';
import BadgeEmblem from '../../components/BadgeEmblem';
import { aspectToNumber } from '../../lib/aspectRatio';
import { trackVideoProgress } from '../../lib/viewTracker';
import TrackRow from '../../components/TrackRow';
import StoriesTray from '../../components/StoriesTray';
import StoryAvatar from '../../components/StoryAvatar';
import SongAttribution from '../../components/SongAttribution';
import SlideshowCarousel from '../../components/SlideshowCarousel';
import MentionText from '../../components/MentionText';
import TaggedPeopleButton from '../../components/TaggedPeopleButton';
import { parseSlides, isSlideshow } from '../../lib/slideshow';
import { useStories } from '../../contexts/StoriesContext';
import { usePostMusic } from '../../contexts/PostMusicContext';
import type { SourceRect } from '../../lib/stories';

type Post = {
  id: string;
  type: string;
  media_url: string;
  caption: string;
  created_at: string;
  user_id: string;
  profiles: {
    username: string;
    display_name: string;
    avatar_url: string | null;
  };
  likes: { count: number }[];
  comments: { count: number }[];
  save_count?: number;
  aspect_ratio?: string | null;
  stream_count?: number;
  cover_url?: string | null;
  thumbnail_url?: string | null;
  duration_seconds?: number | null;
  genre?: string | null;
  song_id?: string | null;
  song_title?: string | null;
  song_artist?: string | null;
  song_artist_id?: string | null;
  tagged_user_ids?: string[] | null;
  // Present only on served spotlight instances (see lib/spotlight.ts) — drives
  // the Spotlight tag and impression/tap reporting. Spotlights rank via
  // computeSpotlightScore (launch boost → performance, floored), not scorePost.
  __spotlight?: SpotlightMeta;
};

type PostCardProps = {
  item: Post;
  isOwn: boolean;
  isLiked: boolean;
  isSaved: boolean;
  audioActive: boolean;
  videoMuted: boolean;
  songMuted: boolean;
  shouldPlayVideo: boolean;
  onProfile: (item: Post) => void;
  onOptions: (item: Post) => void;
  onOpenPost: (item: Post, src?: SourceRect, index?: number) => void;
  onOpenReel: (item: Post, src?: SourceRect) => void;
  onComments: (item: Post) => void;
  onPlayTrack: (item: Post) => void;
  onExpandTrack: (item: Post) => void;
  onToggleMuted: () => void;
  onToggleSongMute: () => void;
  onLike: (item: Post) => void;
  onSave: (item: Post) => void;
  onShare: (item: Post) => void;
  // A slideshow video slide turned its audio on/off → pause/resume its song.
  onSlideAudioActive: (item: Post, active: boolean) => void;
};

// Memoized so that toggling a like/save on one post (which changes the feed's
// liked/saved sets) only re-renders that card — not all ~50 rows. All callbacks
// from HomeScreen are referentially stable, and `item` keeps its reference for
// unchanged posts, so React.memo's shallow compare skips them.
const PostCard = memo(function PostCard({
  item, isOwn, isLiked, isSaved, audioActive, videoMuted, songMuted, shouldPlayVideo,
  onProfile, onOptions, onOpenPost, onOpenReel, onComments, onPlayTrack, onExpandTrack, onToggleMuted, onToggleSongMute, onLike, onSave, onShare, onSlideAudioActive,
}: PostCardProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const likeCount = item.likes[0]?.count || 0;
  const commentCount = item.comments[0]?.count || 0;
  const saveCount = item.save_count || 0;
  const imgRef = useRef<any>(null);
  const vidRef = useRef<any>(null);
  const slideRef = useRef<any>(null);

  return (
    <View style={styles.postCard}>
      {/* Header */}
      <TouchableOpacity style={styles.postHeader} onPress={() => onProfile(item)}>
        <StoryAvatar
          userId={item.user_id}
          avatarUrl={item.profiles?.avatar_url}
          name={item.profiles?.display_name}
          size={38}
          onPressProfile={() => onProfile(item)}
        />
        <View style={styles.postHeaderInfo}>
          <View style={styles.postNameRow}>
            <Text style={styles.postDisplayName}>{item.profiles?.display_name}</Text>
            <BadgeEmblem profile={item.profiles} ownerId={item.user_id} size={13} />
            {!!item.__spotlight && (
              <View style={styles.spotPill}>
                <Ionicons name="sparkles" size={9} color={colors.primaryLight} />
                <Text style={styles.spotPillText}>Spotlight</Text>
              </View>
            )}
          </View>
          <Text style={styles.postUsername}>
            @{item.profiles?.username} · {timeAgo(item.created_at)}
          </Text>
        </View>
        <FollowButton userId={item.user_id} />
        <TouchableOpacity
          style={styles.typeIconWrap}
          onPress={() => onOptions(item)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="ellipsis-horizontal" size={18} color={colors.textSecondary} />
        </TouchableOpacity>
      </TouchableOpacity>

      {/* Media */}
      {item.type === 'image' && item.media_url && (
        <TouchableOpacity
          ref={imgRef}
          onPress={() => imgRef.current?.measureInWindow((x: number, y: number, w: number, h: number) => onOpenPost(item, { x, y, width: w, height: h }))}
        >
          <Image
            source={{ uri: item.media_url }}
            style={[styles.postMedia, { aspectRatio: aspectToNumber(item.aspect_ratio, 1), backgroundColor: '#000' }]}
            resizeMode="cover"
          />
          {!!item.song_id && (
            <TouchableOpacity style={styles.videoAudioBtn} onPress={onToggleSongMute}>
              <Ionicons name={songMuted ? 'volume-mute' : 'volume-high'} size={18} color={colors.text} />
            </TouchableOpacity>
          )}
          {!!item.song_id && (
            <SongAttribution songId={item.song_id} title={item.song_title} artist={item.song_artist} artistId={item.song_artist_id} />
          )}
          <TaggedPeopleButton userIds={item.tagged_user_ids} style={styles.tagBtnOverlay} />
        </TouchableOpacity>
      )}

      {isSlideshow(item.type) && (
        <View ref={slideRef}>
          <SlideshowCarousel
            slides={parseSlides(item)}
            width={SCREEN_W}
            aspectRatio={aspectToNumber(item.aspect_ratio, 1)}
            active={shouldPlayVideo}
            postId={item.id}
            onVideoAudioActiveChange={(a) => onSlideAudioActive(item, a)}
            onOpen={(idx) => slideRef.current?.measureInWindow((x: number, y: number, w: number, h: number) => onOpenPost(item, { x, y, width: w, height: h }, idx))}
          />
          {!!item.song_id && (
            <SongAttribution songId={item.song_id} title={item.song_title} artist={item.song_artist} artistId={item.song_artist_id} />
          )}
          <TaggedPeopleButton userIds={item.tagged_user_ids} style={styles.tagBtnOverlay} />
        </View>
      )}

      {isAudioPost(item.type) && (
        <View style={styles.audioCardWrap}>
          <TrackRow
            caption={item.caption}
            artist={item.profiles?.display_name}
            username={item.profiles?.username}
            streams={item.stream_count}
            cover={item.cover_url}
            avatarUrl={item.profiles?.avatar_url}
            duration={item.duration_seconds}
            isPlaying={audioActive}
            onPlay={() => onPlayTrack(item)}
            onCoverPress={() => onExpandTrack(item)}
            onOptions={() => onOptions(item)}
          />
        </View>
      )}

      {item.type === 'video' && item.media_url && (
        <View>
          <TouchableOpacity
            ref={vidRef}
            activeOpacity={1}
            onPress={() => vidRef.current?.measureInWindow((x: number, y: number, w: number, h: number) => onOpenReel(item, { x, y, width: w, height: h }))}
          >
            <Video
              source={{ uri: item.media_url }}
              style={[styles.postVideo, { height: Math.min(SCREEN_W / aspectToNumber(item.aspect_ratio, 16 / 9), MAX_VIDEO_H), backgroundColor: '#000' }]}
              resizeMode={ResizeMode.COVER}
              isLooping
              isMuted={item.song_id ? true : videoMuted}
              shouldPlay={shouldPlayVideo}
              // Feed watching counts toward views (muted autoplay included) —
              // the tracker accumulates genuine watch time across surfaces and
              // the server enforces the per-user/device caps.
              onPlaybackStatusUpdate={(st: any) => {
                if (st?.isLoaded) trackVideoProgress(item.id, st.positionMillis ?? 0, st.durationMillis ?? 0);
              }}
            />
          </TouchableOpacity>
          <TouchableOpacity style={styles.videoAudioBtn} onPress={item.song_id ? onToggleSongMute : onToggleMuted}>
            <Ionicons name={(item.song_id ? songMuted : videoMuted) ? 'volume-mute' : 'volume-high'} size={18} color={colors.text} />
          </TouchableOpacity>
          {!!item.song_id && (
            <SongAttribution songId={item.song_id} title={item.song_title} artist={item.song_artist} artistId={item.song_artist_id} />
          )}
          <TaggedPeopleButton userIds={item.tagged_user_ids} style={styles.tagBtnOverlay} />
        </View>
      )}

      {/* Caption */}
      {!!item.caption && !isAudioPost(item.type) && (
        <TouchableOpacity onPress={() => onOpenPost(item)}>
          <MentionText style={styles.caption} numberOfLines={3} text={item.caption} />
        </TouchableOpacity>
      )}

      {/* Actions */}
      <View style={styles.actions}>
        <TouchableOpacity style={styles.actionBtn} onPress={() => onLike(item)} activeOpacity={0.6} hitSlop={8}>
          <Ionicons
            name={isLiked ? 'heart' : 'heart-outline'}
            size={23}
            color={isLiked ? colors.like : colors.textSecondary}
          />
          {likeCount > 0 && (
            <Text style={[styles.actionCount, isLiked && { color: colors.like }]}>{likeCount}</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={styles.actionBtn} onPress={() => onComments(item)} activeOpacity={0.6} hitSlop={8}>
          <Ionicons name="chatbubble-outline" size={22} color={colors.textSecondary} />
          {commentCount > 0 && <Text style={styles.actionCount}>{commentCount}</Text>}
        </TouchableOpacity>

        <TouchableOpacity style={styles.actionBtn} onPress={() => onSave(item)} activeOpacity={0.6} hitSlop={8}>
          <Ionicons
            name={isSaved ? 'bookmark' : 'bookmark-outline'}
            size={22}
            color={isSaved ? colors.text : colors.textSecondary}
          />
          {saveCount > 0 && (
            <Text style={[styles.actionCount, isSaved && { color: colors.text }]}>{saveCount}</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={[styles.actionBtn, styles.actionBtnRight]} onPress={() => onShare(item)} activeOpacity={0.6} hitSlop={8}>
          <Ionicons name="share-social-outline" size={22} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>
    </View>
  );
});

export default function HomeScreen() {
  const { show: showOptions } = usePostOptions();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { share: openShare } = useShare();
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [likedPosts, setLikedPosts] = useState<Set<string>>(new Set());
  const [seenPostIds, setSeenPostIds] = useState<Set<string>>(new Set());
  const affinityProfile = useRef<UserAffinityProfile>(EMPTY_PROFILE);
  const { play, currentTrack, isPlaying, expand, videoMuted, toggleVideoMuted } = useAudio();
  const [savedPosts, setSavedPosts] = useState<Set<string>>(new Set());
  const [unreadCount, setUnreadCount] = useState(0);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [playlistModalPostId, setPlaylistModalPostId] = useState<string | null>(null);
  // `item` rides along so a submitted comment on an ad can be counted as a tap.
  const [commentsFor, setCommentsFor] = useState<{ id: string; ownerId: string; item?: Post } | null>(null);
  const [playlistCount, setPlaylistCount] = useState(0);
  const [visibleVideoId, setVisibleVideoId] = useState<string | null>(null);
  const [visibleMusicId, setVisibleMusicId] = useState<string | null>(null);
  // Slideshow posts whose current video slide has its audio on — their attached
  // song pauses so it doesn't overlap the video. (Separate from the global mute.)
  const [slideAudioActiveIds, setSlideAudioActiveIds] = useState<Set<string>>(new Set());
  const { refresh: refreshStories } = useStories();
  const { playSong, stop: stopSong, muted: songMuted, toggleMuted: toggleSongMuted } = usePostMusic();
  const router = useRouter();

  // Only autoplay feed videos when this tab is settled and focused — not while
  // a swipe is dragging the feed off-screen (saves rendering, matches "land first").
  const isFocused = useIsFocused();
  const swiping = usePagerSwiping();
  const canPlayVideo = isFocused && !swiping;

  // Latest values for the stable card callbacks below. Updating a ref (instead of
  // putting these in useCallback deps) lets the callbacks keep a constant identity
  // — so memoized PostCards don't re-render — while still acting on current state.
  const live = useRef({ currentUserId, likedPosts, savedPosts, playlistCount, router, play, expand, toggleVideoMuted, toggleSongMuted, openShare });
  live.current = { currentUserId, likedPosts, savedPosts, playlistCount, router, play, expand, toggleVideoMuted, toggleSongMuted, openShare };

  // Track which video is on-screen so it auto-plays while others pause.
  // FlatList requires these references to be stable across renders.
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: any[] }) => {
    // A video post, or a slideshow that contains at least one video slide, becomes
    // the "playing" item so its current video slide can autoplay.
    const firstVideo = viewableItems.find(v =>
      v.item?.type === 'video' ||
      (isSlideshow(v.item?.type) && Array.isArray(v.item?.slides) && v.item.slides.some((s: any) => s?.type === 'video'))
    );
    setVisibleVideoId(firstVideo ? firstVideo.item.id : null);
    // The most-visible post that carries an attached song — its track plays ambiently.
    const firstMusic = viewableItems.find(v => v.item?.song_id);
    setVisibleMusicId(firstMusic ? firstMusic.item.id : null);
    // A spotlight card crossing the 60% visibility line counts as one
    // impression (deduped per campaign per session in lib/spotlight, owner
    // views never count).
    for (const v of viewableItems) {
      if (v.item?.__spotlight) recordSpotlightImpression(v.item, live.current.currentUserId);
    }
  }).current;
  const [feedMode, setFeedMode] = useState<'all' | 'following' | 'friends'>('all');
  const [menuOpen, setMenuOpen] = useState(false);
  const [initialized, setInitialized] = useState(false);

  // The dropdown chevron is hidden until the logo is tapped, then fades back out
  // after 8s of no interaction.
  const chevronOpacity = useRef(new Animated.Value(0)).current;
  const chevronTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealChevron = useCallback(() => {
    if (chevronTimer.current) clearTimeout(chevronTimer.current);
    Animated.timing(chevronOpacity, { toValue: 1, duration: 150, useNativeDriver: true }).start();
    chevronTimer.current = setTimeout(() => {
      Animated.timing(chevronOpacity, { toValue: 0, duration: 600, useNativeDriver: true }).start();
    }, 8000);
  }, [chevronOpacity]);
  useEffect(() => () => { if (chevronTimer.current) clearTimeout(chevronTimer.current); }, []);

  useEffect(() => {
    if (initialized) fetchPosts(currentUserId || undefined, seenPostIds);
  }, [feedMode]);

  useEffect(() => {
    if (!currentUserId) return;
    // Channel name carries a per-mount suffix: supabase.channel() RETURNS the
    // existing instance for a repeated name, and calling .on() on an already-
    // subscribed channel throws ("cannot add postgres_changes callbacks ...
    // after subscribe()") — which crashed the app whenever a second HomeScreen
    // instance mounted (e.g. a duplicate (tabs) pushed by cross-modal
    // navigation). The filters below scope the events; the name is arbitrary.
    const channel = supabase
      .channel(`notif-badge-${currentUserId}-${Date.now().toString(36)}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${currentUserId}` },
        () => { setUnreadCount(prev => prev + 1); }
      )
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `receiver_id=eq.${currentUserId}` },
        () => { setUnreadMessages(prev => prev + 1); }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [currentUserId]);

  // Refresh the unread-message badge and playlist count whenever the feed
  // regains focus (these change on other screens).
  const fetchUnreadMessages = useCallback(async (userId: string) => {
    const { count } = await supabase
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('receiver_id', userId).eq('read', false);
    setUnreadMessages(count || 0);
  }, []);

  const fetchPlaylistCount = useCallback(async (userId: string) => {
    const { count } = await supabase
      .from('playlists')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);
    setPlaylistCount(count || 0);
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (currentUserId) {
        fetchUnreadMessages(currentUserId);
        fetchPlaylistCount(currentUserId);
      }
    }, [currentUserId, fetchUnreadMessages, fetchPlaylistCount])
  );

  useEffect(() => {
    setup();
  }, []);

  // Auto-play the attached song of the most-visible music post while the feed is
  // focused; stop when it scrolls away or you leave the tab. A slideshow whose
  // current video slide has its audio on pauses its song so they don't overlap.
  const visibleMusicItem = posts.find((p) => p.id === visibleMusicId);
  useEffect(() => {
    if (isFocused && visibleMusicId && visibleMusicItem?.song_id && !slideAudioActiveIds.has(visibleMusicId)) playSong(visibleMusicId, visibleMusicItem.song_id);
    else if (visibleMusicId) stopSong(visibleMusicId);
    return () => { if (visibleMusicId) stopSong(visibleMusicId); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleMusicId, visibleMusicItem?.song_id, isFocused, slideAudioActiveIds]);

  async function setup() {
    const { data: { user } } = await supabase.auth.getUser();
    const userId = user?.id ?? null;
    if (userId) setCurrentUserId(userId);

    const [seen, profile] = await Promise.all([
      loadSeenPostIds(),
      userId ? buildAffinityProfile(userId) : Promise.resolve(EMPTY_PROFILE),
    ]);
    setSeenPostIds(seen);
    affinityProfile.current = profile;

    await Promise.all([
      fetchPosts(userId ?? undefined, seen),
      userId
        ? supabase.from('notifications').select('*', { count: 'exact', head: true })
            .eq('user_id', userId).eq('read', false)
            .then(({ count }) => setUnreadCount(count || 0))
        : Promise.resolve(),
    ]);
    setInitialized(true);
  }

  async function fetchPosts(userId?: string, seen: Set<string> = seenPostIds) {
    let query = supabase
      .from('posts')
      .select(`
        *,
        profiles!posts_user_id_fkey (username, display_name, avatar_url, badge_tier, badge_show, profile_theme),
        likes(count),
        comments(count)
      `)
      .order('created_at', { ascending: false })
      .limit(50);

    // Fetch the following list for every mode:
    //   • following mode  – needed to filter posts
    //   • friends mode    – combined with my followers to find mutual follows
    //   • discovery mode  – needed to apply the follow-boost multiplier
    let followingData: any[] | null = null;
    if (userId) {
      const { data } = await supabase.from('follows').select('following_id').eq('follower_id', userId);
      followingData = data;
    }

    if (feedMode === 'following') {
      const followingIds = followingData?.map((f: any) => f.following_id) ?? [];
      if (followingIds.length === 0) {
        setPosts([]); setLoading(false); setRefreshing(false); return;
      }
      query = query.in('user_id', followingIds);
    } else if (feedMode === 'friends') {
      // Friends = mutual follows: people I follow who also follow me.
      const iFollow = new Set(followingData?.map((f: any) => f.following_id) ?? []);
      const { data: followers } = userId
        ? await supabase.from('follows').select('follower_id').eq('following_id', userId)
        : { data: null };
      const friendIds = (followers ?? [])
        .map((f: any) => f.follower_id)
        .filter((id: string) => iFollow.has(id));
      if (friendIds.length === 0) {
        setPosts([]); setLoading(false); setRefreshing(false); return;
      }
      query = query.in('user_id', friendIds);
    } else {
      query = query.eq('is_public', true);
    }

    const [{ data }, { data: likesData }, { data: savesData }, blockedIds, spotItems] = await Promise.all([
      query,
      userId ? supabase.from('likes').select('post_id').eq('user_id', userId) : Promise.resolve({ data: null }),
      userId ? supabase.from('saves').select('post_id').eq('user_id', userId) : Promise.resolve({ data: null }),
      userId ? fetchBlockedIds() : Promise.resolve(new Set<string>()),
      // Spotlights serve only in the discovery feed — Following/Friends keep
      // their strict "people you chose" guarantee.
      feedMode === 'all' ? fetchFeedSpotlights() : Promise.resolve([] as any[]),
    ]);

    if (data) {
      const followingSet = new Set<string>(
        followingData?.map((f: any) => f.following_id) ?? []
      );

      // Hide archived posts (owner-only, archived_at set) and posts from blocked
      // users before ranking. archived_at is absent until the column is migrated,
      // so this is a harmless no-op pre-migration.
      const visible = (data as any[]).filter(
        (p) => !p.archived_at && !blockedIds.has(p.user_id)
      );

      // Both feeds use the same recency × engagement × personalization ranking
      // (see scorePost). They differ only in the query above: "all" pulls public
      // posts, "following" is pre-filtered to people you follow — so the same
      // algorithm now surfaces the freshest, most relevant followed posts on top
      // instead of a flat chronological list.
      const now = Date.now();
      const profile = affinityProfile.current;
      const scoredPairs = visible.map((p) => ({
        item: p,
        score: scorePost(p, profile, followingSet, seen, now),
      }));
      // The spotlight anchor is the feed's best organic score WITHOUT the
      // seen-penalty, matching the spotlights' own penalty-free scoring so
      // perf compares like-with-like. Anchoring on the penalized scores would
      // collapse the denominator ~6.7× on a refreshed, all-seen feed and pin
      // every spotlight at the ceiling regardless of real performance.
      const neverSeen = new Set<string>();
      const topScore = visible.reduce(
        (m: number, p: any) => Math.max(m, scorePost(p, profile, followingSet, neverSeen, now)),
        0,
      );

      // Spotlights rank INTO the feed: scored like a regular post times a
      // decaying, never-recovering multiplier (see lib/spotlight). The top
      // spotlight defaults to the 3rd slot — only genuine trending performance
      // lets it climb higher — and a decayed one sinks toward (but never
      // below) the feed's average. mergeSpotlights then guarantees ≥6 regular
      // posts between any two spotlights. They skip the seen-penalty (empty
      // seen-set here) and the seen-set write below — bought reach must not
      // decay like scored reach does.
      const spots = spotItems.filter((s) => !blockedIds.has(s.user_id));
      const spotPostIds = new Set(spots.map((s) => s.id));
      // Anchors must live in the same deduped space mergeSpotlights ranks in:
      // the spotlights' own organic copies are removed there, so counting them
      // here would point the "3rd post" anchor one slot off (or pick a small-
      // feed branch that no longer applies).
      const anchorPairs = scoredPairs.filter((p) => !spotPostIds.has(p.item.id));
      const sortedOrg = [...anchorPairs].sort((a, b) => b.score - a.score);
      const anchors = {
        top: sortedOrg[0]?.score ?? 0,
        second: sortedOrg[1]?.score ?? sortedOrg[0]?.score ?? 0,
        third: sortedOrg[2]?.score ?? 0,
        avg: anchorPairs.length
          ? anchorPairs.reduce((s, x) => s + x.score, 0) / anchorPairs.length
          : 0,
        count: anchorPairs.length,
      };
      // How strongly THIS viewer's demonstrated tastes match a spotlighted
      // post (0..1): top creator counts in full, genre/type progressively
      // less, an explicit follow counts a lot. Feeds the per-viewer trending
      // lift — a spotlight can top the feed of someone who loves its maker.
      const affinityFor = (p: any) => Math.max(
        profile.creatorScores[p.user_id] ?? 0,
        (profile.genreScores[p.genre ?? ''] ?? 0) * 0.8,
        (profile.typeScores[p.type] ?? 0) * 0.6,
        followingSet.has(p.user_id) ? 0.6 : 0,
      );
      const spotPairs = await Promise.all(spots.map(async (s) => ({
        item: s,
        score: await rankSpotlight({
          campaignId: s.__spotlight?.campaignId ?? s.id,
          organicPf: scorePost(s, profile, followingSet, neverSeen, now),
          topPf: topScore,
          anchors,
          startsAt: s.__spotlight?.startsAt ?? null,
          weight: s.__spotlight?.weight ?? 1,
          now,
          affinity: affinityFor(s),
          viewerId: userId ?? null,
        }),
      })));
      setPosts(mergeSpotlights(scoredPairs, spotPairs));
      // Persist post IDs shown to the user so they can be deprioritised next
      // session — spotlighted posts excluded, so a campaign never leaves its
      // post pre-penalised in organic ranking once it ends.
      recordSeenPostIds(visible.filter((p: any) => !spotPostIds.has(p.id)).map((p: any) => p.id));
    }
    if (likesData) setLikedPosts(new Set(likesData.map((l: any) => l.post_id)));
    if (savesData) setSavedPosts(new Set(savesData.map((s: any) => s.post_id)));
    setLoading(false);
    setRefreshing(false);
  }

  // Stable card callbacks — identity never changes (empty deps + the `live` ref),
  // so memoized PostCards only re-render when their own props change.
  const onLike = useCallback(async (item: Post) => {
    const { currentUserId: uid, likedPosts: liked } = live.current;
    if (!uid) return;
    const isLiked = liked.has(item.id);
    setLikedPosts(prev => {
      const next = new Set(prev);
      isLiked ? next.delete(item.id) : next.add(item.id);
      return next;
    });
    setPosts(prev => prev.map(post => {
      if (post.id !== item.id) return post;
      const c = post.likes[0]?.count || 0;
      return { ...post, likes: [{ count: isLiked ? c - 1 : c + 1 }] };
    }));
    if (isLiked) {
      await supabase.from('likes').delete().eq('user_id', uid).eq('post_id', item.id);
    } else {
      await supabase.from('likes').insert({ user_id: uid, post_id: item.id });
      bumpBadge('likes');
      if (item.__spotlight) recordSpotlightTap(item, 'like', uid);
      if (item.user_id !== uid) {
        createNotification({ userId: item.user_id, actorId: uid, type: 'like', postId: item.id });
      }
    }
  }, []);

  const onSave = useCallback(async (item: Post) => {
    const { currentUserId: uid, savedPosts: saved, playlistCount: plCount } = live.current;
    if (!uid) return;
    const wasSaved = saved.has(item.id);
    setSavedPosts(prev => {
      const next = new Set(prev);
      wasSaved ? next.delete(item.id) : next.add(item.id);
      return next;
    });
    setPosts(prev => prev.map(p => {
      if (p.id !== item.id) return p;
      const c = p.save_count || 0;
      return { ...p, save_count: wasSaved ? Math.max(c - 1, 0) : c + 1 };
    }));
    if (wasSaved) {
      await supabase.from('saves').delete().eq('user_id', uid).eq('post_id', item.id);
    } else {
      await supabase.from('saves').insert({ user_id: uid, post_id: item.id });
      if (item.__spotlight) recordSpotlightTap(item, 'save', uid);
      // Audio: if the user has playlists, offer to add the just-saved track to one.
      if (item.type === 'audio' && plCount > 0) setPlaylistModalPostId(item.id);
    }
  }, []);

  const onShare = useCallback((item: Post) => {
    if (item.__spotlight) recordSpotlightTap(item, 'share', live.current.currentUserId);
    live.current.openShare({
      postId: item.id,
      caption: item.caption,
      username: item.profiles?.username,
      type: item.type,
      mediaUrl: item.media_url,
      cover: item.cover_url ?? item.thumbnail_url ?? (item.type === 'image' ? item.media_url : null),
    });
  }, []);

  // isSwipeTap guards: a tab swipe gliding over the feed must not open
  // posts/reels/profiles (the swipe's touch can read as a tap on a card).
  const onProfile = useCallback((item: Post) => { if (isSwipeTap()) return; live.current.router.push(`/profile/${item.user_id}`); }, []);
  const onOpenPost = useCallback((item: Post, src?: SourceRect, index?: number) => { if (isSwipeTap()) return; live.current.router.push({ pathname: '/post/[id]', params: { id: item.id, post: JSON.stringify(item), ...(src ? { src: JSON.stringify(src) } : {}), ...(index != null ? { index: String(index) } : {}) } }); }, []);
  const onOpenReel = useCallback((item: Post, src?: SourceRect) => { if (isSwipeTap()) return; live.current.router.push({ pathname: '/reel/[id]', params: { id: item.id, post: JSON.stringify(item), ...(src ? { src: JSON.stringify(src) } : {}) } }); }, []);
  // The spotlight tap is NOT recorded here — opening the sheet to read isn't
  // an engagement. It's counted in the sheet's onPosted, on actual submission.
  const onComments = useCallback((item: Post) => {
    setCommentsFor({ id: item.id, ownerId: item.user_id, item });
  }, []);
  // Track which slideshows have their video audio on (idempotent — returns the same
  // set when nothing changes so it never triggers an extra render).
  const onSlideAudioActive = useCallback((item: Post, on: boolean) => {
    setSlideAudioActiveIds(prev => {
      if (on === prev.has(item.id)) return prev;
      const n = new Set(prev);
      if (on) n.add(item.id); else n.delete(item.id);
      return n;
    });
  }, []);

  const onPlayTrack = useCallback((item: Post) => {
    if (isSwipeTap()) return; // never start audio from a swipe glide
    live.current.play({ id: item.id, uri: item.media_url, caption: item.caption, artist: item.profiles?.display_name, cover: item.cover_url });
  }, []);
  const onExpandTrack = useCallback((item: Post) => {
    live.current.play({ id: item.id, uri: item.media_url, caption: item.caption, artist: item.profiles?.display_name, cover: item.cover_url });
    live.current.expand();
  }, []);
  const onToggleMuted = useCallback(() => live.current.toggleVideoMuted(), []);
  const onToggleSongMute = useCallback(() => live.current.toggleSongMuted(), []);

  const onOptions = useCallback((item: Post) => {
    showOptions({
      postId: item.id,
      isOwn: item.user_id === live.current.currentUserId,
      authorId: item.user_id,
      authorName: item.profiles?.username,
      mediaType: item.type,
      onEdit: () => live.current.router.push(`/edit-post/${item.id}`),
      onDeleted: () => setPosts(prev => prev.filter(p => p.id !== item.id)),
      onArchived: () => setPosts(prev => prev.filter(p => p.id !== item.id)),
      onBlocked: () => setPosts(prev => prev.filter(p => p.user_id !== item.user_id)),
    });
  }, []);

  const renderPost = useCallback(({ item }: { item: Post }) => (
    <ElasticSwipeView>
      <PostCard
        item={item}
        isOwn={item.user_id === currentUserId}
        isLiked={likedPosts.has(item.id)}
        isSaved={savedPosts.has(item.id)}
        audioActive={isPlaying && currentTrack?.id === item.id}
        videoMuted={videoMuted}
        songMuted={songMuted}
        shouldPlayVideo={canPlayVideo && visibleVideoId === item.id}
        onProfile={onProfile}
        onOptions={onOptions}
        onOpenPost={onOpenPost}
        onOpenReel={onOpenReel}
        onComments={onComments}
        onPlayTrack={onPlayTrack}
        onExpandTrack={onExpandTrack}
        onToggleMuted={onToggleMuted}
        onToggleSongMute={onToggleSongMute}
        onLike={onLike}
        onSave={onSave}
        onShare={onShare}
        onSlideAudioActive={onSlideAudioActive}
      />
    </ElasticSwipeView>
  ), [currentUserId, likedPosts, savedPosts, isPlaying, currentTrack, videoMuted, songMuted, canPlayVideo, visibleVideoId,
      onProfile, onOptions, onOpenPost, onOpenReel, onComments, onPlayTrack, onExpandTrack, onToggleMuted, onToggleSongMute, onLike, onSave, onShare, onSlideAudioActive]);

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.logoBtn}
          onPress={() => { revealChevron(); setMenuOpen(true); }}
          activeOpacity={0.7}
        >
          <Text style={styles.headerLogo}>Laybell</Text>
          <Animated.View style={[styles.logoChevron, { opacity: chevronOpacity }]} pointerEvents="none">
            <Ionicons name="chevron-down" size={20} color={colors.primaryLight} />
          </Animated.View>
        </TouchableOpacity>
        <View style={styles.headerRight}>
          <TouchableOpacity
            style={styles.headerIconBtn}
            onPress={() => { setUnreadCount(0); router.push('/notifications'); }}
          >
            <Ionicons name="notifications-outline" size={28} color={colors.text} />
            {unreadCount > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{unreadCount > 9 ? '9+' : unreadCount}</Text>
              </View>
            )}
          </TouchableOpacity>

          <TouchableOpacity style={styles.headerIconBtn} onPress={() => router.push('/messages')}>
            <Ionicons name="chatbubbles-outline" size={28} color={colors.text} />
            {unreadMessages > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{unreadMessages > 9 ? '9+' : unreadMessages}</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>
      </View>

      {/* Feed-mode dropdown */}
      <Modal
        visible={menuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuOpen(false)}
      >
        <TouchableOpacity
          style={styles.menuOverlay}
          activeOpacity={1}
          onPress={() => setMenuOpen(false)}
        >
          <View style={styles.menuCard}>
            {([
              { key: 'all', label: 'All', icon: 'globe-outline' },
              { key: 'following', label: 'Following', icon: 'person-add-outline' },
              { key: 'friends', label: 'Friends', icon: 'people-outline' },
            ] as const).map((opt) => {
              const active = feedMode === opt.key;
              return (
                <TouchableOpacity
                  key={opt.key}
                  style={[styles.menuItem, active && styles.menuItemActive]}
                  onPress={() => { setFeedMode(opt.key); setMenuOpen(false); }}
                >
                  <Ionicons
                    name={opt.icon}
                    size={20}
                    color={active ? colors.primaryLight : colors.textSecondary}
                  />
                  <Text style={[styles.menuItemText, active && styles.menuItemTextActive]}>{opt.label}</Text>
                  {active && (
                    <Ionicons name="checkmark" size={18} color={colors.primaryLight} style={styles.menuCheck} />
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        </TouchableOpacity>
      </Modal>

      <FlatList
        data={posts}
        // Spotlight instances key off their campaign so a promoted post can
        // never key-collide with itself (organic copies are filtered at merge).
        keyExtractor={(item) => (item.__spotlight ? `spot:${item.__spotlight.campaignId}` : item.id)}
        renderItem={renderPost}
        ListHeaderComponent={<StoriesTray />}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.feedContent}
        removeClippedSubviews
        windowSize={5}
        maxToRenderPerBatch={5}
        initialNumToRender={5}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            // Reload the seen-set from storage first so posts shown in prior
            // loads get the seen-penalty and genuinely new/unseen recent posts
            // rise to the top on every pull-to-refresh.
            onRefresh={async () => {
              setRefreshing(true);
              refreshStories();
              const seen = await loadSeenPostIds();
              setSeenPostIds(seen);
              await fetchPosts(currentUserId || undefined, seen);
            }}
            tintColor={colors.primary}
          />
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Ionicons name="musical-notes" size={48} color={colors.textTertiary} />
            <Text style={styles.emptyTitle}>
              {feedMode === 'following'
                ? 'No posts from people you follow'
                : feedMode === 'friends'
                ? 'No posts from your friends'
                : 'No posts yet'}
            </Text>
            <Text style={styles.emptySubtitle}>
              {feedMode === 'following'
                ? 'Follow some artists to see their posts here'
                : feedMode === 'friends'
                ? 'When you and someone follow each other you become friends — their posts show up here'
                : 'Be the first to post on Laybell'}
            </Text>
            {feedMode !== 'all' && (
              <TouchableOpacity style={styles.exploreBtn} onPress={() => router.push('/(tabs)/explore')}>
                <Text style={styles.exploreBtnText}>Discover Artists</Text>
                <Ionicons name="arrow-forward" size={16} color={colors.text} />
              </TouchableOpacity>
            )}
          </View>
        }
      />

      <AddToPlaylistModal
        visible={!!playlistModalPostId}
        postId={playlistModalPostId ?? ''}
        onClose={() => setPlaylistModalPostId(null)}
      />

      <CommentsSheet
        visible={!!commentsFor}
        postId={commentsFor?.id ?? ''}
        ownerId={commentsFor?.ownerId}
        onClose={() => setCommentsFor(null)}
        onPosted={() => {
          const it = commentsFor?.item;
          if (it?.__spotlight) recordSpotlightTap(it, 'comment', currentUserId);
        }}
      />
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  loadingContainer: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.xxl + SPACING.sm,
    paddingBottom: SPACING.sm,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  logoBtn: { flexDirection: 'row', alignItems: 'center' },
  headerLogo: {
    color: colors.primaryLight,
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  logoChevron: { marginLeft: 2, marginTop: 4 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  headerIconBtn: { position: 'relative', padding: 2 },

  menuOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  menuCard: {
    position: 'absolute',
    top: SPACING.xxl + SPACING.sm + 44,
    left: SPACING.md,
    minWidth: 200,
    backgroundColor: colors.surfaceElevated,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: SPACING.xs,
    ...SHADOWS.md,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: SPACING.sm + 2,
    paddingHorizontal: SPACING.md,
  },
  menuItemActive: { backgroundColor: colors.primary + '14' },
  menuItemText: { color: colors.textSecondary, fontSize: 16, fontWeight: '600' },
  menuItemTextActive: { color: colors.text, fontWeight: '700' },
  menuCheck: { marginLeft: 'auto' },

  badge: {
    position: 'absolute', top: -2, right: -2,
    minWidth: 16, height: 16, borderRadius: 8,
    backgroundColor: colors.error,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3,
  },
  badgeText: { color: colors.text, fontSize: 9, fontWeight: 'bold' },

  feedContent: { paddingBottom: SPACING.xxl + 60 },

  postCard: {
    backgroundColor: colors.background,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.borderSubtle,
    paddingBottom: SPACING.xs,
  },

  postHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm + 2,
    gap: SPACING.sm,
  },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: RADIUS.full,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  postHeaderInfo: { flex: 1 },
  postNameRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  spotPill: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    marginLeft: 2,
    paddingHorizontal: 6, paddingVertical: 1,
    borderRadius: RADIUS.full,
    backgroundColor: colors.primary + '22',
    borderWidth: 1, borderColor: colors.primary + '66',
  },
  spotPillText: { color: colors.primaryLight, fontSize: 10, fontWeight: '800', letterSpacing: 0.3 },
  postDisplayName: { color: colors.text, fontSize: 14, fontWeight: '700', letterSpacing: 0.1 },
  postUsername: { color: colors.textMeta, fontSize: 12, marginTop: 1 },
  typeIconWrap: {
    width: 28, height: 28, borderRadius: RADIUS.full,
    backgroundColor: colors.primary + '18',
    alignItems: 'center', justifyContent: 'center',
  },

  postMedia: {
    width: '100%',
    backgroundColor: colors.surfaceLight,
  },
  postVideo: {
    width: '100%',
    backgroundColor: '#000',
  },
  videoAudioBtn: {
    position: 'absolute', top: SPACING.sm, right: SPACING.sm,
    width: 34, height: 34, borderRadius: RADIUS.full,
    backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center',
  },
  tagBtnOverlay: { position: 'absolute', left: SPACING.sm, bottom: SPACING.sm },
  postImage: {
    width: '100%',
    height: 320,
    backgroundColor: colors.surfaceLight,
  },

  audioCardWrap: { marginHorizontal: SPACING.md, marginVertical: SPACING.sm, borderRadius: RADIUS.md, overflow: 'hidden' },
  audioCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: SPACING.md,
    borderRadius: RADIUS.md,
  },
  audioLeft: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, flex: 1 },
  audioIconRing: {
    width: 44, height: 44, borderRadius: RADIUS.full,
    backgroundColor: colors.primary + '44',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: colors.primary + '88',
  },
  audioCover: { width: 48, height: 48, borderRadius: RADIUS.sm, overflow: 'hidden' },
  audioCoverImg: { width: 48, height: 48 },
  audioCoverOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.35)',
  },
  audioIconRingActive: {
    backgroundColor: colors.primaryDark,
    borderColor: colors.primaryLight,
    ...SHADOWS.glow,
  },
  audioTitle: { color: colors.text, fontSize: 14, fontWeight: '600', maxWidth: 180 },
  audioMeta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  audioArtist: { color: colors.textSecondary, fontSize: 12 },
  audioStreams: { color: colors.textTertiary, fontSize: 12 },

  caption: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 21,
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.sm,
  },

  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.sm,
    paddingBottom: SPACING.xs,
    gap: SPACING.lg,
  },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  actionBtnRight: { marginLeft: 'auto' },
  actionCount: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },

  emptyContainer: { alignItems: 'center', paddingTop: 100, gap: SPACING.md },
  emptyTitle: { color: colors.text, fontSize: 20, fontWeight: '700' },
  emptySubtitle: { color: colors.textSecondary, fontSize: 14, textAlign: 'center', paddingHorizontal: SPACING.lg },
  exploreBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.primary, borderRadius: RADIUS.full,
    paddingVertical: SPACING.sm + 2, paddingHorizontal: SPACING.lg,
    marginTop: SPACING.sm,
  },
  exploreBtnText: { color: colors.text, fontSize: 14, fontWeight: '700' },
});
