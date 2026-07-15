import {
  buildAffinityProfile, loadSeenPostIds, recordSeenPostIds, scorePost, arrangeFeed,
  EMPTY_PROFILE, type UserAffinityProfile, type ScoreOpts,
} from '../../lib/feedScorer';
import { fetchGirlSpaceCommunityIds } from '../../lib/communities';
import FeedVideo from '../../components/FeedVideo';
// FlashList v2: RECYCLES card views instead of mounting/destroying them while
// scrolling — the structural fix for mount-burst micro-hitches (same philosophy
// as the video player pool). Recycling means components receive a NEW item
// without remounting, so all cell-local state carries reset guards (see the
// key={item.id} on SlideshowCarousel, resetKey on ElasticSwipeView, the
// render-phase resets in FeedVideo/TaggedPeopleButton/useAutoTranslate).
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useRouter, useFocusEffect } from 'expo-router';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import { isSwipeTap } from '../../contexts/PagerContext';
import {
  setVisibleVideoId, setWarmVideoIds, setFeedFastScrolling, setFeedFocused, resetFeedVideo, useCardPlayback,
} from '../../lib/feedVideo';
import { acquireFeedPlayer } from '../../lib/feedVideoPool';
import { feedChromeTop, feedDragEnd, feedDragStart, setFeedChromeHidden, settleFeedChrome, trackFeedScroll } from '../../lib/feedChrome';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  View, Text, StyleSheet,
  TouchableOpacity, Platform,
  RefreshControl, Dimensions, Modal, Animated, ActivityIndicator,
} from 'react-native';
import { FeedSkeleton } from '../../components/Skeleton';

const SCREEN_W = Dimensions.get('window').width;
const MAX_VIDEO_H = SCREEN_W * 1.25; // cap feed video at 4:5 so tall (9:16) clips aren't too long
// Home feed candidate POOL — how many recent posts we pull to sample the shown
// arrangement from (see lib/feedScorer.arrangeFeed). Bigger = more genuinely
// different content per refresh; capped by how many posts actually exist.
const POOL_SIZE = 120;

// Map a feed post to a playable audio Track.
const toTrack = (p: any): Track => ({
  id: p.id, uri: p.media_url, caption: p.caption,
  artist: p.profiles?.display_name ?? '', cover: p.cover_url ?? null,
});
import { useEffect, useState, useCallback, useRef, useMemo, memo } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { bumpBadge } from '../../lib/badges';
import { SPACING, RADIUS, SHADOWS, GRADIENTS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { timeAgo } from '../../lib/timeAgo';
import { useAudio, type Track } from '../../contexts/AudioContext';
import { attachEngagementCountsAll } from '../../lib/postCounts';
import { createNotification } from '../../lib/createNotification';
import { selection, impactLight } from '../../lib/haptics';
import { usePostOptions } from '../../contexts/PostOptionsContext';
import { useShare } from '../../contexts/ShareContext';
import { useLinkGuard } from '../../contexts/LinkGuardContext';
import { isAudioPost } from '../../lib/genres';
import { fetchBlockedIds } from '../../lib/blocks';
import { countGroupUnread } from '../../lib/groups';
import {
  fetchFeedSpotlights, mergeSpotlights, rankSpotlight,
  recordSpotlightImpression, recordSpotlightTap, type SpotlightMeta,
} from '../../lib/spotlight';
import {
  fetchFeedAds, injectFeedAds, recordAdImpression, recordAdClick,
  type AdViewer,
} from '../../lib/ads';
import { openAdOptions } from '../../contexts/AdOptionsContext';
import SponsoredCard from '../../components/SponsoredCard';
import { useProfile } from '../../contexts/ProfileContext';
import AddToPlaylistModal from '../../components/AddToPlaylistModal';
import CommentsSheet from '../../components/CommentsSheet';
import ElasticSwipeView from '../../components/ElasticSwipeView';
import FollowButton from '../../components/FollowButton';
import BadgeEmblem from '../../components/BadgeEmblem';
import { aspectToNumber } from '../../lib/aspectRatio';
import { trackVideoProgress } from '../../lib/viewTracker';
import TrackRow from '../../components/TrackRow';
import StoriesTray from '../../components/StoriesTray';
import PendingUploads from '../../components/PendingUploads';
import { useUploadQueue } from '../../contexts/UploadQueueContext';
import StoryAvatar from '../../components/StoryAvatar';
import SongAttribution from '../../components/SongAttribution';
import SlideshowCarousel from '../../components/SlideshowCarousel';
import MentionText from '../../components/MentionText';
import TranslatableText from '../../components/TranslatableText';
import TaggedPeopleButton from '../../components/TaggedPeopleButton';
import CommunityTag from '../../components/CommunityTag';
import { parseSlides, isSlideshow } from '../../lib/slideshow';
import { useStories } from '../../contexts/StoriesContext';
import { usePostMusicActions, usePostMusicMuted } from '../../contexts/PostMusicContext';
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
  community_id?: string | null;
  community_hashtag?: string | null;
  community_tags?: { id: string; hashtag: string }[] | null;
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

// Stable feed header (stories tray + any in-flight upload cards). Defined at module
// scope so feed re-renders / refetches never remount it — which would restart the
// optimistic upload card's local video mid-playback.
const FeedHeader = memo(function FeedHeader() {
  return (
    <>
      <StoriesTray />
      <PendingUploads />
    </>
  );
});

// Memoized so that toggling a like/save on one post (which changes the feed's
// liked/saved sets) only re-renders that card — not all ~50 rows. All callbacks
// from HomeScreen are referentially stable, and `item` keeps its reference for
// unchanged posts, so React.memo's shallow compare skips them.
const PostCard = memo(function PostCard({
  item, isOwn, isLiked, isSaved, audioActive, videoMuted, songMuted,
  onProfile, onOptions, onOpenPost, onOpenReel, onComments, onPlayTrack, onExpandTrack, onToggleMuted, onToggleSongMute, onLike, onSave, onShare, onSlideAudioActive,
}: PostCardProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  // Per-card playback subscription (lib/feedVideo): this card re-renders on a
  // viewability/gate change ONLY when its own booleans flip — the rest of the
  // list isn't touched (not even a memo compare).
  // isVisibleVideo → centered OR near-viewport neighbor: mounts the player.
  // shouldPlayVideo → mounted AND centered AND settled/focused: actually plays.
  const { isVisibleVideo, shouldPlayVideo } = useCardPlayback(item.id);
  const likeCount = item.likes[0]?.count || 0;
  const commentCount = item.comments[0]?.count || 0;
  const saveCount = item.save_count || 0;
  const imgRef = useRef<any>(null);
  const vidRef = useRef<any>(null);
  const slideRef = useRef<any>(null);
  // Simple like pop: a quick scale bounce on the heart when tapped.
  const likeScale = useRef(new Animated.Value(1)).current;
  // Recycling reset (FlashList reuses this instance across items): a mid-bounce
  // like-pop must not ride onto the next post's heart.
  useEffect(() => { likeScale.stopAnimation(); likeScale.setValue(1); }, [item.id, likeScale]);
  const popLike = () => {
    likeScale.setValue(1);
    Animated.sequence([
      Animated.timing(likeScale, { toValue: 1.3, duration: 110, useNativeDriver: true }),
      Animated.spring(likeScale, { toValue: 1, friction: 3, useNativeDriver: true }),
    ]).start();
  };

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
            <Text style={styles.postDisplayName} numberOfLines={1}>{item.profiles?.display_name}</Text>
            <BadgeEmblem profile={item.profiles} ownerId={item.user_id} size={13} />
            {!!item.__spotlight && (
              <View style={styles.spotPill}>
                <Ionicons name="sparkles" size={12} color={colors.primaryLight} />
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
          {/* expo-image: decodes at DISPLAYED size (RN Image decodes the full
              multi-MP original — memory spikes + dropped frames mid-scroll). */}
          <ExpoImage
            source={{ uri: item.media_url }}
            // Recycled cells must never flash the PREVIOUS post's image while
            // the new one decodes — recyclingKey clears the view on reuse.
            recyclingKey={item.id}
            style={[styles.postMedia, { aspectRatio: aspectToNumber(item.aspect_ratio, 1), backgroundColor: '#000' }]}
            contentFit="cover"
            cachePolicy="memory-disk"
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
          {/* key={item.id}: the carousel holds REAL local state (slide index,
              scroll-x, unmute) that must never carry onto a recycled cell's
              new post. Keying just this subtree remounts only the carousel —
              the rest of the card still recycles. */}
          <SlideshowCarousel
            key={item.id}
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
            <View style={[styles.postVideo, { height: Math.min(SCREEN_W / aspectToNumber(item.aspect_ratio, 16 / 9), MAX_VIDEO_H), backgroundColor: '#000' }]}>
              {/* Thumbnail for every card; the real player mounts only for the
                  visible card and its nearest video neighbors (pre-warmed, paused)
                  so fast scrolling never spins up a player per row while landing
                  on a video still plays instantly. */}
              {!!item.thumbnail_url && (
                <ExpoImage source={{ uri: item.thumbnail_url }} recyclingKey={item.id} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory-disk" />
              )}
              {isVisibleVideo && (
                // POOLED player (lib/feedVideoPool): assignment is a cheap
                // source swap on a persistent player — no creation, no freeze —
                // so it can happen while scrolling and starts feel instant.
                // The card's thumbnail above stays visible until the first
                // frame is ready (FeedVideo hides its surface until then).
                <FeedVideo
                  id={item.id}
                  uri={item.media_url}
                  play={shouldPlayVideo}
                  muted={item.song_id ? true : videoMuted}
                  // Feed watching counts toward views (muted autoplay included) —
                  // the tracker accumulates genuine watch time across surfaces and
                  // the server enforces the per-user/device caps.
                  onProgress={(pos, dur) => trackVideoProgress(item.id, pos, dur)}
                />
              )}
            </View>
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

      {/* Caption + community hashtag on the SAME line (wrapping row): the tag
          sits right after the caption when it fits on one line and drops to the
          next line only when the caption itself wraps. The media above opens the
          post; the tag opens its community. */}
      {(!!item.caption || (item.community_tags?.length ?? 0) > 0) && !isAudioPost(item.type) && (
        <TranslatableText
          text={item.caption ?? ''}
          render={(s) => (
            <View style={styles.captionRow}>
              {!!s && <MentionText style={styles.caption} numberOfLines={3} text={s} />}
              {(item.community_tags ?? []).map((ct, i) => (
                <CommunityTag key={ct.id} communityId={ct.id} hashtag={ct.hashtag} leading={i === 0 && !!s} />
              ))}
            </View>
          )}
        />
      )}

      {/* Actions */}
      <View style={styles.actions}>
        <TouchableOpacity style={styles.actionBtn} onPress={() => { selection(); popLike(); onLike(item); }} activeOpacity={0.6} hitSlop={8}>
          <Animated.View style={{ transform: [{ scale: likeScale }] }}>
            <Ionicons
              name={isLiked ? 'heart' : 'heart-outline'}
              size={23}
              color={isLiked ? colors.like : colors.textSecondary}
            />
          </Animated.View>
          {likeCount > 0 && (
            <Text style={[styles.actionCount, isLiked && { color: colors.like }]}>{likeCount}</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={styles.actionBtn} onPress={() => onComments(item)} activeOpacity={0.6} hitSlop={8}>
          <Ionicons name="chatbubble-outline" size={22} color={colors.textSecondary} />
          {commentCount > 0 && <Text style={styles.actionCount}>{commentCount}</Text>}
        </TouchableOpacity>

        <TouchableOpacity style={styles.actionBtn} onPress={() => { selection(); onSave(item); }} activeOpacity={0.6} hitSlop={8}>
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

// ── The feed gate ────────────────────────────────────────────────────────────
// Instagram-style progressive unlock: only the first GATE_POSTS posts exist in
// the list until the gate has run the feed's optimization pass. TWO phases
// (owner design): background prep starts the moment the gate card is drawn
// (FlashList draws ahead, so this overlaps the user finishing post 3), and the
// visible 4–6s loading dwell starts only when the user actually HITS the
// bottom bound. Everything below the gate literally does not render, mount, or
// buffer until unlock, so the opening posts settle with ZERO competition and
// the unlocked feed scrolls into pre-warmed content. Pull-to-refresh RE-GATES:
// fresh content gets a fresh pass every time.
const GATE_POSTS = 3;
const FEED_GATE_BOUND_MS = 5000; // dwell AFTER the user reaches the bound

// A slim, quiet bound — just a small neutral spinner, no dead space.
function FeedGateCard({ onArm }: { onArm: () => void }) {
  const { colors } = useTheme();
  useEffect(() => { onArm(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <View style={{ height: 64, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator size="small" color={colors.textSecondary} />
    </View>
  );
}

export default function HomeScreen() {
  const { show: showOptions } = usePostOptions();
  const { colors, mode } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { share: openShare } = useShare();
  const linkGuard = useLinkGuard();
  const [posts, setPosts] = useState<Post[]>([]);
  // Background video uploads: optimistic cards render at the top of the feed while
  // the upload/encode runs (see PendingUploads), and completedTick pulls the real
  // row in once it lands.
  const { pending, completedTick, pinnedIds, clearPinned, homeScrollTick } = useUploadQueue();
  const [pinnedPosts, setPinnedPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [likedPosts, setLikedPosts] = useState<Set<string>>(new Set());
  const [seenPostIds, setSeenPostIds] = useState<Set<string>>(new Set());
  const affinityProfile = useRef<UserAffinityProfile>(EMPTY_PROFILE);
  // Live mirrors read by the song-queue builder / loader (see playFeedSong).
  const postsRef = useRef<Post[]>([]);
  // Bumped at the start of every fetchPosts; the deferred spotlight/ad "paint 2"
  // checks it's still the latest before writing, so a slow promoted-layer weave
  // can't clobber a newer fetch (pull-to-refresh / feed-mode switch mid-load).
  const fetchSeq = useRef(0);
  postsRef.current = posts;

  // While a background upload's optimistic card is showing, hide the real DB row
  // with the same id so the two never appear together — the card hands off to the
  // row the moment the upload finishes and the card is removed.
  const pendingPostIds = useMemo(
    () => new Set(pending.map((p) => p.postId).filter(Boolean) as string[]),
    [pending],
  );
  // Freshly-finished posts are pinned to the very top (as real, fully-interactive
  // PostCards) until a manual refresh. Prefer the copy already in `posts` (freshest),
  // fall back to the separately-fetched one (covers feed modes that exclude own posts).
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);
  const feedData = useMemo(() => {
    const pins = pinnedIds
      .map((id) => posts.find((p) => p.id === id) || pinnedPosts.find((p) => p.id === id))
      .filter(Boolean) as Post[];
    const rest = posts.filter((p) => !pinnedSet.has(p.id) && !pendingPostIds.has(p.id));
    return [...pins, ...rest];
  }, [posts, pinnedPosts, pinnedIds, pinnedSet, pendingPostIds]);
  // Live copy for the (stable) viewability callback below — it scans around the
  // viewport for upcoming videos to pre-warm without re-subscribing.
  const feedDataRef = useRef<Post[]>([]);
  feedDataRef.current = feedData;

  // Feed gate (see FeedGateCard): the list is capped at GATE_POSTS + the gate
  // sentinel until the pass has run. Pull-to-refresh re-gates (onRefresh).
  const [feedGateUnlocked, setFeedGateUnlocked] = useState(false);
  const feedGateUnlockedRef = useRef(false); feedGateUnlockedRef.current = feedGateUnlocked;
  const gateArmedRef = useRef(false);
  const gateUnlockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gatedFeedData = useMemo(() => {
    if (feedGateUnlocked || feedData.length <= GATE_POSTS) return feedData;
    return [...feedData.slice(0, GATE_POSTS), { id: '__feed_gate__', __gate: true } as unknown as Post];
  }, [feedData, feedGateUnlocked]);
  // The optimization pass: warm everything the next user actions will touch.
  const runFeedGatePrefetch = useCallback((deep: boolean) => {
    try {
      const upcoming = feedDataRef.current.slice(GATE_POSTS, GATE_POSTS + (deep ? 24 : 12)) as any[];
      const stills: string[] = [];
      let songWarms = 0;
      for (const p of upcoming) {
        const still = p.thumbnail_url || p.cover_url || (p.type === 'image' ? p.media_url : null);
        if (still) stills.push(still);
        const avatar = p.profiles?.avatar_url || p.avatar_url;
        if (avatar) stills.push(avatar);
        // Song URL resolution is the slow half of a song post's first play —
        // resolve the upcoming ones now (prefetchSong dedupes inflight).
        if (p.song_id && songWarms < (deep ? 8 : 4)) { songWarms++; try { musicCtl.current.prefetchSong(p.song_id); } catch {} }
      }
      // Warm the disk/memory image cache for every upcoming still + avatar so
      // post-gate scrolling decodes from cache instead of the network.
      if (stills.length) { try { ExpoImage.prefetch(stills); } catch {} }
    } catch {}
  }, []);
  // Phase A — the gate card mounted (drawn ahead as the user nears the bottom
  // of post 3): background work starts immediately, no dwell yet.
  const onGateArm = useCallback(() => {
    if (gateArmedRef.current) return;
    gateArmedRef.current = true;
    runFeedGatePrefetch(false);
  }, [runFeedGatePrefetch]);
  // Phase B — the user actually HIT the bound (gate card crossed the 60%
  // impression threshold): deeper pass + pre-create the ambient song player
  // (so a song tap never constructs a native player over a playing video),
  // then the deliberate 4–6s dwell before unlock.
  const onGateBoundHit = useCallback(() => {
    if (feedGateUnlockedRef.current || gateUnlockTimer.current) return;
    runFeedGatePrefetch(true);
    try { musicCtl.current.warmSongPlayer(); } catch {}
    // Pre-buffer the first upcoming VIDEO's stream into the pool while the
    // gate dwells — this is the one moment bandwidth is guaranteed idle, so
    // scrolling past the gate lands on an already-loaded player (its FeedVideo
    // re-acquires the same entry by id and reveals instantly).
    try {
      const nextVid = (feedDataRef.current.slice(GATE_POSTS, GATE_POSTS + 8) as any[])
        .find((p) => !p.__ad && p.type === 'video' && p.media_url);
      if (nextVid) acquireFeedPlayer(nextVid.id, nextVid.media_url, { loop: true, muted: true, timeUpdateSec: 0.25 }, () => {});
    } catch {}
    gateUnlockTimer.current = setTimeout(() => {
      gateUnlockTimer.current = null;
      setFeedGateUnlocked(true);
    }, FEED_GATE_BOUND_MS);
  }, [runFeedGatePrefetch]);

  // Fetch the pinned posts' full rows (so a pin still shows even when the active feed
  // mode wouldn't include your own post).
  useEffect(() => {
    if (!pinnedIds.length) { setPinnedPosts([]); return; }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('posts')
        .select(`*, profiles!posts_user_id_fkey (username, display_name, avatar_url, badge_tier, badge_show, profile_theme)`)
        .in('id', pinnedIds);
      if (!cancelled && data) setPinnedPosts(attachEngagementCountsAll(data as any[]) as Post[]);
    })();
    return () => { cancelled = true; };
  }, [pinnedIds]);

  // A background upload just landed (or finished encoding) — pull the fresh row in.
  useEffect(() => {
    if (completedTick > 0) fetchPosts(currentUserId || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completedTick]);

  // The just-posted confirmation was tapped — bring the pinned new post into view.
  const feedListRef = useRef<FlashListRef<Post>>(null);
  useEffect(() => {
    if (homeScrollTick > 0) feedListRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, [homeScrollTick]);
  const followingRef = useRef<Set<string>>(new Set());
  // Current user's own profile (age/gender/location) for ad targeting. Kept in a
  // ref so fetchPosts can read it without re-running on every profile change.
  const { profile: myProfile } = useProfile();
  const viewerProfileRef = useRef(myProfile);
  viewerProfileRef.current = myProfile;
  const { play, playQueue, currentTrack, isPlaying, expand, videoMuted, toggleVideoMuted } = useAudio();
  const [savedPosts, setSavedPosts] = useState<Set<string>>(new Set());
  const [unreadCount, setUnreadCount] = useState(0);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [playlistModalPostId, setPlaylistModalPostId] = useState<string | null>(null);
  // `item` rides along so a submitted comment on an ad can be counted as a tap.
  const [commentsFor, setCommentsFor] = useState<{ id: string; ownerId: string; item?: Post } | null>(null);
  const [playlistCount, setPlaylistCount] = useState(0);
  // visibleVideoId / warm set / play gate live in lib/feedVideo.ts (a per-card
  // subscription store), NOT React state here — as state they were renderPost
  // deps, so every viewability crossing and gate flip re-rendered every mounted
  // cell at exactly the frames where the finger lands. Cards subscribe to their
  // own booleans via useCardPlayback(id).
  // Ambient song (most-visible music post) is IMPERATIVE, not React state: as
  // state, every song-post crossing the 60% line re-rendered the HomeScreen
  // shell mid-scroll. These refs + syncAmbientSong() drive PostMusicContext
  // straight from the viewability handler — with this, a plain scroll causes
  // ZERO React state changes anywhere in the feed.
  const visibleMusicRef = useRef<{ id: string; songId: string } | null>(null);
  // Slideshow posts whose current video slide has its audio on — their attached
  // song pauses so it doesn't overlap the video. (Separate from the global mute.)
  const slideAudioIdsRef = useRef<Set<string>>(new Set());
  const ambientPlayingRef = useRef<string | null>(null);
  const syncAmbientSongRef = useRef<() => void>(() => {});
  const { refresh: refreshStories } = useStories();
  // Narrow hooks: actions never change identity; muted flips only on user taps.
  // (usePostMusic would re-render this whole screen on every activeId change —
  // i.e. per song-post crossing — including while covered by the reels modal.)
  const { playSong, stop: stopSong, toggleMuted: toggleSongMuted, prefetchSong, warmSongPlayer } = usePostMusicActions();
  const songMuted = usePostMusicMuted();
  const router = useRouter();

  // Only autoplay feed videos when this tab is focused — not while a swipe is
  // dragging the feed off-screen (saves rendering, matches "land first").
  // Focus is PUBLISHED to the playback store; the swipe flag feeds it directly
  // from PagerContext's module store (no HomeScreen re-render on swipes).
  const isFocused = useIsFocused();
  const isFocusedRef = useRef(isFocused);
  isFocusedRef.current = isFocused;
  useEffect(() => { setFeedFocused(isFocused); syncAmbientSongRef.current(); }, [isFocused]);
  // Account-switch remounts start the store from a clean slate, exactly like
  // the old fresh useState.
  useEffect(() => () => resetFeedVideo(), []);

  // ── Scroll gate ─────────────────────────────────────────────────────────────
  // Videos autoplay the moment they're on screen — EXCEPT while the feed is
  // actively moving at more than a gentle browse. During a fast OR MODERATE
  // scroll, mounting/tearing-down a native player per video and flipping which
  // one plays (worst when several videos sit close together) is what makes the
  // mid-speed range feel choppy — so the gate DEFERS the viewability snapshot
  // (no warm-set / visibleVideo churn, no play) until the scroll eases below
  // GATE_OUT, at which point the latest snapshot applies and the centered,
  // already-warmed video plays instantly. Only slow reading scrolls (under
  // GATE_OUT) keep playing live. Velocity is sampled per scroll event.
  const fastScrollRef = useRef(false);
  // True from finger-down until the scroll fully rests (drag end + momentum/idle).
  // Ambient-song application is parked while this is set: starting/stopping a
  // native audio player (audio-session work) mid-scroll stalls the UI thread —
  // the "1-in-3 swipes hitch, always on posts with Laybell music" symptom.
  const scrollingRef = useRef(false);
  const scrollSample = useRef({ y: 0, t: 0 });
  // Tap-misread guard: a main-thread hiccup can delay gesture recognition so a
  // swipe's touch-down registers as a TAP on whatever sits under the finger
  // (the phantom "profile click" during a downward swipe). Navigation taps
  // within 130ms of live scroll MOVEMENT are swallowed — a resting feed never
  // blocks taps.
  const lastScrollMoveAt = useRef(0);
  const lastTapGuardY = useRef(0);
  const scrollStopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (scrollStopTimer.current) clearTimeout(scrollStopTimer.current); }, []);

  // Latest values for the stable card callbacks below. Updating a ref (instead of
  // putting these in useCallback deps) lets the callbacks keep a constant identity
  // — so memoized PostCards don't re-render — while still acting on current state.
  const live = useRef({ currentUserId, likedPosts, savedPosts, playlistCount, router, play, playQueue, expand, toggleVideoMuted, toggleSongMuted, openShare, t, linkGuard });
  live.current = { currentUserId, likedPosts, savedPosts, playlistCount, router, play, playQueue, expand, toggleVideoMuted, toggleSongMuted, openShare, t, linkGuard };

  // Track which video is on-screen so it auto-plays while others pause.
  // FlatList requires these references to be stable across renders.
  // TWO viewability pairs: video activation is EAGER (40% visible, no dwell
  // time) so playback feels automatic the moment a video slides in, while
  // spotlight/ad impressions + ambient music keep the original deliberate
  // 60% + 90ms rule (impression semantics unchanged).
  const pendingVideoViewables = useRef<any[] | null>(null);
  const applyVideoViewables = useRef((viewableItems: any[]) => {
    // A video post, or a slideshow that contains at least one video slide, becomes
    // the "playing" item so its current video slide can autoplay.
    const firstVideo = viewableItems.find(v =>
      v.item?.type === 'video' ||
      (isSlideshow(v.item?.type) && Array.isArray(v.item?.slides) && v.item.slides.some((s: any) => s?.type === 'video'))
    );
    setVisibleVideoId(firstVideo ? firstVideo.item.id : null);
    // STAGED loading (Instagram-style progressive unlock): only the VISIBLE
    // video and the ONE below it hold live players/streams — everything
    // deeper stays a poster until you approach it. Warming every on-screen
    // video meant several concurrent streams: they starved the playing
    // video's bandwidth (froze ~1s in) and piled up on cold open.
    const ids: string[] = [];
    if (firstVideo && !firstVideo.item.__ad && firstVideo.item.type === 'video' && firstVideo.item.media_url) {
      ids.push(firstVideo.item.id);
    }
    if (firstVideo) {
      const after = viewableItems
        .slice(viewableItems.indexOf(firstVideo) + 1)
        .find((v) => { const p = v.item; return p && !p.__ad && p.type === 'video' && p.media_url; });
      if (after) ids.push(after.item.id);
    }
    setWarmVideoIds(ids);
  }).current;
  const onVideoViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: any[] }) => {
    // Gentle scrolls apply LIVE (Instagram-style — the video starts the moment
    // you bring it into view): with the pooled players, assignment is a cheap
    // async source swap, never a creation, so mid-gesture application is safe
    // again. Only fast flings defer (no point churning sources mid-blur).
    if (fastScrollRef.current) { pendingVideoViewables.current = viewableItems; return; }
    pendingVideoViewables.current = null;
    applyVideoViewables(viewableItems);
  }).current;
  // Scroll reached rest: apply the parked video snapshot — the ONLY moment
  // video players are created/released. Runs before the music flush (+150ms).
  function flushVideoAtRest() {
    if (pendingVideoViewables.current) {
      const pending = pendingVideoViewables.current;
      pendingVideoViewables.current = null;
      applyVideoViewables(pending);
    }
  }
  // The most-visible post that carries an attached song — its track plays ambiently.
  const applyMusicViewables = useRef((viewableItems: any[]) => {
    const firstMusic = viewableItems.find(v => v.item?.song_id);
    visibleMusicRef.current = firstMusic ? { id: firstMusic.item.id, songId: firstMusic.item.song_id } : null;
    syncAmbientSongRef.current();
  }).current;
  const pendingMusicViewables = useRef<any[] | null>(null);
  const onImpressionViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: any[] }) => {
    // Ambient-song application is parked during ANY scrolling (not just fast) —
    // it tears down + creates a NATIVE audio player, and that audio-session
    // work stalls the UI thread mid-gesture. The latest snapshot applies when
    // the scroll RESTS (flushMusicAtRest). The song URL is prefetched right
    // away though, so the player starts instantly at rest.
    // The impression loop below stays live: it's cheap (in-memory dedupe +
    // fire-and-forget RPC) and impression semantics must not change.
    const firstMusic = viewableItems.find(v => v.item?.song_id);
    if (firstMusic) musicCtl.current.prefetchSong(firstMusic.item.song_id);
    // ALWAYS park + (at rest) arm the deferred flush — a direct apply here
    // could fire a second player create moments after the rest-flush one
    // (this pair has minimumViewTime 90ms, so it can land just after rest).
    pendingMusicViewables.current = viewableItems;
    if (!scrollingRef.current && !fastScrollRef.current) armMusicFlush();
    // A spotlight card crossing the 60% visibility line counts as one
    // impression (deduped per campaign per session in lib/spotlight, owner
    // views never count).
    for (const v of viewableItems) {
      if (v.item?.__spotlight) recordSpotlightImpression(v.item, live.current.currentUserId);
      // A sponsored ad card crossing 60% visibility counts one impression
      // (deduped per campaign/placement/session + per-hour server-side).
      if (v.item?.__ad) recordAdImpression(v.item, 'feed', live.current.currentUserId);
      // The gate card crossing 60% = the user hit the bottom bound → start the
      // gate's visible dwell (phase B). Idempotent while the timer runs.
      if (v.item?.__gate) onGateBoundHit();
    }
  }).current;
  const viewabilityConfigCallbackPairs = useRef([
    { viewabilityConfig: { itemVisiblePercentThreshold: 40, minimumViewTime: 0 }, onViewableItemsChanged: onVideoViewableItemsChanged },
    { viewabilityConfig: { itemVisiblePercentThreshold: 60, minimumViewTime: 90 }, onViewableItemsChanged: onImpressionViewableItemsChanged },
  ]).current;

  // Enter/exit fast-scroll mode; exiting flushes the viewability snapshot that
  // was deferred mid-fling so the landed video starts right away.
  const setFastScroll = (on: boolean) => {
    if (fastScrollRef.current === on) return;
    fastScrollRef.current = on;
    setFeedFastScrolling(on); // store publish — flips playback for ONLY the visible card, no list re-render
    // BOTH video and music snapshots stay parked until the scroll truly RESTS
    // (flushVideoAtRest / armMusicFlush) — the gate transition at GATE_OUT can
    // still be mid-motion, and player creation mid-motion is a frame freeze.
  };
  // Ambient-song application runs ~150ms AFTER the scroll rests: the rest frame
  // already carries the landed video's play() and the list settle — spacing the
  // native audio create/session work out of that burst keeps taps at rest
  // responsive. Coalesced (re-armed by later at-rest snapshots), cancelled the
  // moment scrolling resumes.
  const musicFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function cancelMusicFlush() {
    if (musicFlushTimer.current) { clearTimeout(musicFlushTimer.current); musicFlushTimer.current = null; }
  }
  function armMusicFlush() {
    cancelMusicFlush();
    musicFlushTimer.current = setTimeout(() => {
      musicFlushTimer.current = null;
      if (pendingMusicViewables.current) {
        const pendingMusic = pendingMusicViewables.current;
        pendingMusicViewables.current = null;
        applyMusicViewables(pendingMusic);
      }
    }, 150);
  }
  useEffect(() => () => cancelMusicFlush(), []);
  // dp per ms. GATE_IN ≈ 1.25 screens/s catches moderate scrolls (not just fast
  // flings) — that mid band was the choppy one; GATE_OUT ≈ 0.5 screens/s keeps
  // the gate engaged until the scroll has nearly stopped, so play resumes only
  // as you settle. The gap between them is hysteresis: a gentle reading scroll
  // (under GATE_OUT) never trips the gate and keeps videos playing live.
  // GATE_OUT is deliberately 0.4 (owner-tuned) — NOT higher. A 0.55 experiment
  // made playback unlock while the feed was still visibly moving: a medium
  // scroll oscillating across the narrowed 0.55↔1.0 band pause/play-churned
  // the visible video ("the video freezes sometimes"), and playing that early
  // also left too little buffered stream (stall a second in). Play near rest.
  const GATE_IN = 1.0, GATE_OUT = 0.4;
  const trackScrollVelocity = (y: number) => {
    const t = Date.now();
    const { y: py, t: pt } = scrollSample.current;
    const dt = t - pt;
    // ≥12ms measurement windows: at scrollEventThrottle=1, coalesced 120Hz
    // events can measure dt as 1-4ms while carrying a full frame's dy —
    // apparent velocity inflated up to ~8x, which tripped GATE_IN mid
    // reading-scroll and pause/play-flickered the playing video. Small-dt
    // samples are NOT anchored (dy and dt accumulate into the next check).
    if (dt >= 0 && dt < 12) {
      if (!scrollStopTimer.current) scrollStopTimer.current = setTimeout(checkScrollStop, 100);
      return;
    }
    scrollSample.current = { y, t };
    if (dt > 0 && dt < 200) { // >200ms gap = a new gesture, not a velocity sample
      const v = Math.abs(y - py) / dt;
      if (v >= GATE_IN) setFastScroll(true);
      else {
        // Deceleration below GATE_IN: assign the landed video NOW. With the
        // pooled players this is replaceAsync on a persistent player — loaded
        // off the UI thread, zero creation, zero freeze — so its HLS stream
        // buffers through the last stretch of momentum and play() at GATE_OUT
        // lands on a ready stream. (The old CREATE-while-decelerating version
        // froze frames; the pool is what makes this safe.)
        if (fastScrollRef.current && pendingVideoViewables.current) {
          const pendingV = pendingVideoViewables.current;
          pendingVideoViewables.current = null;
          applyVideoViewables(pendingV);
        }
        if (v <= GATE_OUT) setFastScroll(false);
      }
    }
    // A fling's final events can still be fast — clear soon after events stop.
    // LAZY: one pending timeout re-arms itself with the remainder instead of
    // being cleared + recreated on every scroll frame (same pattern as
    // lib/feedChrome — per-frame timer churn was part of the staticy feel).
    if (!scrollStopTimer.current) scrollStopTimer.current = setTimeout(checkScrollStop, 100);
  };
  function isScrollTap() {
    // scrollingRef covers the FREEZE case: during a main-thread stall no scroll
    // events flow, so the 130ms movement window alone can expire mid-freeze and
    // let the misread tap through. A scroll gesture that hasn't reached rest is
    // never a real navigation tap (iOS wouldn't deliver one to children anyway).
    return scrollingRef.current || Date.now() - lastScrollMoveAt.current < 130;
  }
  function checkScrollStop() {
    scrollStopTimer.current = null;
    const idle = Date.now() - scrollSample.current.t;
    if (idle >= 100) { setFastScroll(false); scrollingRef.current = false; flushVideoAtRest(); armMusicFlush(); return; }
    scrollStopTimer.current = setTimeout(checkScrollStop, 100 - idle);
  }
  const [feedMode, setFeedMode] = useState<'all' | 'following' | 'friends'>('all');
  const [menuOpen, setMenuOpen] = useState(false);
  // Measured height of the floating header — pads the feed underneath it and
  // sets how far it slides away when the reactive chrome hides.
  // Seeded with the header's real ~height (not 0): FlashList v2 keeps
  // maintainVisibleContentPosition ON by default, and a 0→140 paddingTop flip
  // after the first onLayout could be "compensated" away, leaving the first
  // posts under the floating header. onLayout still corrects the exact value.
  const [headerH, setHeaderH] = useState(140);
  // Memoized so re-renders don't tear down + rebuild the native interpolation
  // node graph (inline it rebuilt on every commit — native-animated churn that
  // landed exactly at drag start). Created twice ever: mount + first onLayout.
  const headerSlideStyle = useMemo(() => ({
    transform: [{ translateY: feedChromeTop.interpolate({ inputRange: [0, 1], outputRange: [0, -(headerH || 140)] }) }],
  }), [headerH]);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  // Stable list-container style so FlatList's PureComponent can bail on shell
  // re-renders (an inline array is a fresh identity every render).
  const feedGatedNow = !feedGateUnlocked && feedData.length > GATE_POSTS;
  const feedContentStyle = useMemo(
    () => [styles.feedContent, {
      paddingTop: headerH,
      // While the gate is the last item the feed ends RIGHT under the spinner
      // (just tab-bar clearance) — the full breathing-room padding only
      // belongs under a real end-of-feed.
      paddingBottom: feedGatedNow ? 68 + insets.bottom : 68 + insets.bottom + SPACING.xxl + 60,
    }],
    [styles, headerH, insets.bottom, feedGatedNow],
  );

  // Tapping the Home tab while ALREADY on Home scrolls the feed back to the
  // top (Instagram behavior) and brings the reactive chrome back.
  useEffect(() => {
    const unsub = (navigation as { addListener: (ev: string, cb: () => void) => () => void })
      .addListener('tabPress', () => {
        if ((navigation as { isFocused: () => boolean }).isFocused()) {
          feedListRef.current?.scrollToOffset({ offset: 0, animated: true });
          setFeedChromeHidden(false);
        }
      });
    return unsub;
  }, [navigation]);
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
      // Recompute (rather than +1) so the badge counts CONVERSATIONS, not
      // messages — a new message in an already-unread convo doesn't bump it.
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `receiver_id=eq.${currentUserId}` },
        () => { fetchUnreadMessages(currentUserId); }
      )
      // Group messages have a null receiver, so the filter above misses them.
      // No filter here (RLS only delivers messages I can see); recompute for
      // group messages from others (DMs have a null conversation_id).
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => {
          const m = payload.new as { conversation_id?: string | null; sender_id?: string };
          if (m.conversation_id && m.sender_id !== currentUserId) fetchUnreadMessages(currentUserId);
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserId]);

  // Refresh the unread-message badge and playlist count whenever the feed
  // regains focus (these change on other screens).
  const fetchUnreadMessages = useCallback(async (userId: string) => {
    // Count CONVERSATIONS with unread content, not individual messages: distinct
    // DM senders with unread messages + group convos with unread content. So a
    // convo with 100 new messages counts as 1, and opening it (which marks it
    // read) clears its 1.
    const [{ data: dmRows }, groupUnread] = await Promise.all([
      supabase
        .from('messages')
        .select('sender_id')
        .eq('receiver_id', userId).eq('read', false),
      countGroupUnread(userId),
    ]);
    const dmConvos = new Set((dmRows ?? []).map((r: any) => r.sender_id)).size;
    setUnreadMessages(dmConvos + groupUnread);
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
  // Imperative (see visibleMusicRef above): called from the viewability handler,
  // the focus effect, and onSlideAudioActive — never re-renders anything.
  const musicCtl = useRef({ playSong, stopSong, prefetchSong, warmSongPlayer });
  musicCtl.current = { playSong, stopSong, prefetchSong, warmSongPlayer };
  function syncAmbientSong() {
    const target = isFocusedRef.current ? visibleMusicRef.current : null;
    const want = target && !slideAudioIdsRef.current.has(target.id) ? target : null;
    if (want) {
      // PLAY-FIRST handoff: do NOT stop the old host before playSong —
      // playSong replaces the player internally, and when consecutive posts
      // share a song its fast-path transfers ownership with ZERO native churn.
      // (Calling stop first nulled the song ref and destroyed the player, so
      // that fast-path could never fire — every transition paid a full native
      // teardown + create.)
      if (ambientPlayingRef.current !== want.id) {
        musicCtl.current.playSong(want.id, want.songId);
        ambientPlayingRef.current = want.id;
      }
    } else if (ambientPlayingRef.current) {
      musicCtl.current.stopSong(ambientPlayingRef.current);
      ambientPlayingRef.current = null;
    }
  }
  syncAmbientSongRef.current = syncAmbientSong;
  // Feed unmount (account switch): stop whatever ambient song is playing.
  useEffect(() => () => { if (ambientPlayingRef.current) musicCtl.current.stopSong(ambientPlayingRef.current); }, []);

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
    // Own this fetch — the deferred promoted-layer paint below only writes while
    // it's still the latest fetch (a newer pull-to-refresh / mode switch bumps it).
    const seq = ++fetchSeq.current;
    let query = supabase
      .from('posts')
      .select(`
        *,
        profiles!posts_user_id_fkey (username, display_name, avatar_url, badge_tier, badge_show, profile_theme)
      `)
      .order('created_at', { ascending: false })
      // Wide candidate POOL (not the shown count) — arrangeFeed weighted-samples a
      // different arrangement from it each refresh, so pulling to refresh yields a
      // genuinely different feed the way current Instagram does. The ceiling is how
      // many posts actually exist; with a small pool "different" is naturally limited.
      .limit(POOL_SIZE);

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

    // Viewer context for ad targeting (own profile demographics + taste affinity).
    const adViewer: AdViewer = {
      id: userId ?? null,
      profile: viewerProfileRef.current ? {
        age: (viewerProfileRef.current as any).age,
        gender: (viewerProfileRef.current as any).gender,
        latitude: (viewerProfileRef.current as any).latitude,
        longitude: (viewerProfileRef.current as any).longitude,
      } : null,
      affinity: affinityProfile.current,
    };

    // Everything below awaits the network / AsyncStorage. Wrap it so (a) the
    // skeleton always clears for the LATEST fetch even if a query throws, and
    // (b) a failed promoted-layer fetch degrades to the organic feed (already
    // painted) instead of blanking it.
    try {
      // CORE fetch — the minimum to rank + paint ORGANIC content. The promoted
      // layer (spotlights + ads) is deferred to PAINT 2 below: rankSpotlight does
      // per-campaign AsyncStorage reads and ad targeting runs its own pass, so
      // keeping them off the critical path lets the first screen of real posts
      // replace the skeleton as soon as the posts query returns.
      const [{ data }, { data: likesData }, { data: savesData }, blockedIds, girlSpaceIds] = await Promise.all([
        query,
        userId ? supabase.from('likes').select('post_id').eq('user_id', userId) : Promise.resolve({ data: null }),
        userId ? supabase.from('saves').select('post_id').eq('user_id', userId) : Promise.resolve({ data: null }),
        userId ? fetchBlockedIds() : Promise.resolve(new Set<string>()),
        fetchGirlSpaceCommunityIds(),
      ]);

      if (likesData) setLikedPosts(new Set(likesData.map((l: any) => l.post_id)));
      if (savesData) setSavedPosts(new Set(savesData.map((s: any) => s.post_id)));
      if (!data) return; // finally clears loading/refreshing

      // Girl space: feminine-tagged community posts are softly down-ranked for men
      // who don't already engage with the creator (see lib/feedScorer scorePost).
      const scoreOpts: ScoreOpts = { viewerGender: (viewerProfileRef.current as any)?.gender ?? null, girlSpaceIds };
      const followingSet = new Set<string>(followingData?.map((f: any) => f.following_id) ?? []);
      followingRef.current = followingSet;

      // Hide archived posts (owner-only, archived_at set) and blocked users' posts
      // before ranking. archived_at is absent pre-migration — a harmless no-op.
      const visible = attachEngagementCountsAll(data as any[]).filter(
        (p) => !p.archived_at && !blockedIds.has(p.user_id)
      );

      // Deterministic recency × engagement × personalization score (see scorePost).
      // This exact score anchors spotlight placement below, so it stays stable.
      const now = Date.now();
      const profile = affinityProfile.current;
      const scoredPairs = visible.map((p) => ({
        item: p,
        score: scorePost(p, profile, followingSet, seen, now, scoreOpts),
      }));
      // Instagram-style arrangement (see lib/feedScorer.arrangeFeed): a fresh
      // weighted-random draw from the whole pool, tilted toward higher scores and
      // spread by author, so every refresh is a genuinely different arrangement.
      // Computed ONCE and reused by BOTH paints so the order never reshuffles
      // between them; anchors below stay on the deterministic scoredPairs.
      const orderedPairs = arrangeFeed(scoredPairs);

      // A newer fetch (pull-to-refresh / mode switch) superseded us — let it own
      // the screen. Bailing here seq-guards PAINT 1 AND the seen-record below.
      if (fetchSeq.current !== seq) return;

      // PAINT 1 — organic, ranked + jittered. Real content replaces the skeleton
      // now; the promoted layer weaves in on the next paint.
      setPosts([...orderedPairs].sort((a, b) => b.score - a.score).map((p) => p.item));
      setLoading(false);
      setRefreshing(false);

      // Following / Friends keep their strict "people you chose" guarantee — no
      // spotlights or ads. Record seen and stop.
      if (feedMode !== 'all') {
        recordSeenPostIds(visible.map((p: any) => p.id));
        return;
      }

      // PAINT 2 — weave the promoted layer (spotlights + ads) without blocking the
      // first paint. Fetched here, off the critical path; a failure throws to the
      // finally and leaves PAINT 1's organic feed in place.
      const [spotItems, adItems] = await Promise.all([fetchFeedSpotlights(), fetchFeedAds(adViewer)]);

      // The spotlight anchor is the feed's best organic score WITHOUT the seen-
      // penalty (matches the spotlights' own penalty-free scoring) AND without the
      // variety jitter, so spotlight SCORING stays stable; final placement can
      // still drift a slot or two per refresh as it competes with jittered posts.
      const neverSeen = new Set<string>();
      const topScore = visible.reduce(
        (m: number, p: any) => Math.max(m, scorePost(p, profile, followingSet, neverSeen, now)),
        0,
      );
      // Spotlights rank INTO the feed: a regular-post score × a decaying multiplier
      // (see lib/spotlight). Default 3rd slot; mergeSpotlights guarantees ≥6 posts
      // between any two, and skips the seen-penalty + seen-set write (bought reach
      // must not decay like scored reach).
      const spots = spotItems.filter((s) => !blockedIds.has(s.user_id));
      const spotPostIds = new Set(spots.map((s) => s.id));
      // Anchors live in the deduped space mergeSpotlights ranks in (spotlights'
      // own organic copies are removed there), from the DETERMINISTIC scores.
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
      // How strongly THIS viewer's tastes match a spotlighted post (0..1).
      const affinityFor = (p: any) => Math.max(
        profile.creatorScores[p.user_id] ?? 0,
        (profile.genreScores[p.genre ?? ''] ?? 0) * 0.8,
        (profile.typeScores[p.type] ?? 0) * 0.6,
        followingSet.has(p.user_id) ? 0.6 : 0,
      );
      // A spotlight buys a fresh shot at reach — score its base as if created when
      // the campaign started so recency-decay doesn't bury an older promoted post.
      const freshForSpotlight = (p: any) => ({ ...p, created_at: p.__spotlight?.startsAt ?? p.created_at });
      const spotPairs = await Promise.all(spots.map(async (s) => ({
        item: s,
        score: await rankSpotlight({
          campaignId: s.__spotlight?.campaignId ?? s.id,
          organicPf: scorePost(freshForSpotlight(s), profile, followingSet, neverSeen, now),
          topPf: topScore,
          anchors,
          startsAt: s.__spotlight?.startsAt ?? null,
          weight: s.__spotlight?.weight ?? 1,
          now,
          affinity: affinityFor(s),
          viewerId: userId ?? null,
        }),
      })));
      // Merge spotlights into the SAME jittered organic order, then inject ads via
      // the pure spacing pass. injectFeedAds no-ops when there are no ads.
      const merged = mergeSpotlights(orderedPairs, spotPairs);
      const adsForFeed = (adItems as any[]).filter((a) => a.user_id !== userId && !blockedIds.has(a.user_id));
      // Re-check: the promoted-layer await may have been overtaken by a newer fetch.
      if (fetchSeq.current !== seq) return;
      setPosts(injectFeedAds(merged, adsForFeed));
      // Persist shown IDs (spotlights excluded) so they deprioritise next session.
      recordSeenPostIds(visible.filter((p: any) => !spotPostIds.has(p.id)).map((p: any) => p.id));
    } finally {
      // Backstop: whatever happened above (including a thrown query), never leave
      // the LATEST fetch's skeleton spinning.
      if (fetchSeq.current === seq) { setLoading(false); setRefreshing(false); }
    }
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
  const onProfile = useCallback((item: Post) => { if (isSwipeTap() || isScrollTap()) return; live.current.router.push(`/profile/${item.user_id}`); }, []);
  const onOpenPost = useCallback((item: Post, src?: SourceRect, index?: number) => { if (isSwipeTap() || isScrollTap()) return; live.current.router.push({ pathname: '/post/[id]', params: { id: item.id, post: JSON.stringify(item), ...(src ? { src: JSON.stringify(src) } : {}), ...(index != null ? { index: String(index) } : {}) } }); }, []);
  const onOpenReel = useCallback((item: Post, src?: SourceRect) => { if (isSwipeTap() || isScrollTap()) return; live.current.router.push({ pathname: '/reel/[id]', params: { id: item.id, post: JSON.stringify(item), ...(src ? { src: JSON.stringify(src) } : {}) } }); }, []);
  // The spotlight tap is NOT recorded here — opening the sheet to read isn't
  // an engagement. It's counted in the sheet's onPosted, on actual submission.
  const onComments = useCallback((item: Post) => {
    if (isScrollTap()) return;
    setCommentsFor({ id: item.id, ownerId: item.user_id, item });
  }, []);
  // Track which slideshows have their video audio on (ref + imperative sync —
  // never renders; idempotent so a repeated report is a no-op).
  const onSlideAudioActive = useCallback((item: Post, on: boolean) => {
    const set = slideAudioIdsRef.current;
    if (on === set.has(item.id)) return;
    if (on) set.add(item.id); else set.delete(item.id);
    syncAmbientSongRef.current();
  }, []);

  // Playing a song from the feed queues ALL the feed's songs in relevance order
  // (they're already scored), so "next" moves to the next most relevant song even
  // for ones not yet scrolled into view. A loader pulls MORE ranked songs when the
  // queue runs low, so next / auto-advance never dead-end.
  const songLoader = useCallback(async (excludeIds: Set<string>): Promise<Track[]> => {
    const { data } = await supabase
      .from('posts')
      .select(`*, profiles!posts_user_id_fkey (username, display_name, avatar_url, badge_tier, badge_show, profile_theme)`)
      .eq('type', 'audio').eq('is_public', true)
      .order('created_at', { ascending: false })
      .limit(120);
    const now = Date.now();
    return attachEngagementCountsAll(data)
      .filter((p: any) => p.media_url && !p.archived_at && !excludeIds.has(p.id))
      .map((p: any) => ({ p, s: scorePost(p, affinityProfile.current, followingRef.current, new Set(), now) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => toTrack(x.p));
  }, []);
  const playFeedSong = useCallback((item: Post, expand = false) => {
    if (isSwipeTap()) return; // never start audio from a swipe glide
    const songs = postsRef.current.filter((p: any) => p.type === 'audio' && p.media_url && !p.__ad);
    let queue = songs;
    let startIndex = songs.findIndex((p) => p.id === item.id);
    if (startIndex < 0) { queue = [item, ...songs]; startIndex = 0; }
    live.current.playQueue(queue.map(toTrack), startIndex, songLoader);
    if (expand) live.current.expand();
  }, [songLoader]);
  const onPlayTrack = useCallback((item: Post) => playFeedSong(item), [playFeedSong]);
  const onExpandTrack = useCallback((item: Post) => playFeedSong(item, true), [playFeedSong]);
  const onToggleMuted = useCallback(() => live.current.toggleVideoMuted(), []);
  const onToggleSongMute = useCallback(() => live.current.toggleSongMuted(), []);

  // Ad CTA — open through the link-safety guard (destination shown, risky links
  // flagged, dangerous ones blocked); the click is recorded only if the user
  // actually proceeds.
  const onAdCta = useCallback((item: any) => {
    if (isSwipeTap()) return;
    const url = item.__ad?.ctaUrl;
    if (!url) return;
    live.current.linkGuard.open(url, {
      context: 'ad',
      sourceName: item.__ad?.advertiserName,
      onProceed: () => recordAdClick(item, 'feed', live.current.currentUserId),
    });
  }, []);
  // Ad 3-dot: opens the themed ad-options sheet (report / why this ad / settings).
  const onAdOptions = useCallback((item: any) => {
    const ad = item.__ad;
    if (!ad) return;
    openAdOptions({ campaignId: ad.campaignId, creativeId: ad.creativeId, advertiserName: ad.advertiserName });
  }, []);

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
    (item as any).__gate ? <FeedGateCard onArm={onGateArm} /> :
    <ElasticSwipeView resetKey={(item as any).__spotlight ? `spot:${(item as any).__spotlight.campaignId}` : item.id}>
      {(item as any).__ad ? (
        <SponsoredCard
          item={item}
          onCta={onAdCta}
          onOptions={onAdOptions}
        />
      ) : (
        <PostCard
          item={item}
          isOwn={item.user_id === currentUserId}
          isLiked={likedPosts.has(item.id)}
          isSaved={savedPosts.has(item.id)}
          audioActive={isPlaying && currentTrack?.id === item.id}
          videoMuted={videoMuted}
          songMuted={songMuted}
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
      )}
    </ElasticSwipeView>
  // Scroll-varying playback state deliberately ABSENT from these deps (it lives
  // in lib/feedVideo — cards subscribe directly): renderPost identity now only
  // changes on user-initiated events (like/save, track change, mute), never
  // during a plain scroll — so FlatList's mounted cells bail via PureComponent.
  ), [currentUserId, likedPosts, savedPosts, isPlaying, currentTrack, videoMuted, songMuted,
      onProfile, onOptions, onOpenPost, onOpenReel, onComments, onPlayTrack, onExpandTrack, onToggleMuted, onToggleSongMute, onLike, onSave, onShare, onSlideAudioActive, onAdCta, onAdOptions, onGateArm]);

  if (loading) {
    return (
      <View style={styles.container}>
        <FeedSkeleton posts={2} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header — floats over the feed and tucks away as you scroll down,
          returning the moment you scroll up (Instagram-style reactive chrome).
          The feed pads itself by the measured header height below. */}
      <Animated.View
        style={[
          styles.header,
          styles.headerFloat,
          Platform.OS === 'ios' && styles.headerGlass,
          headerSlideStyle,
        ]}
        onLayout={(e) => { const h = e.nativeEvent.layout.height; setHeaderH(h); }}
      >
        {/* iOS: real frosted material behind the floating header (matches the tab
            bar), so the feed blurs through it instead of hiding under a flat slab. */}
        {Platform.OS === 'ios' && (
          <BlurView
            tint={mode === 'light' ? 'systemChromeMaterialLight' : 'systemChromeMaterialDark'}
            intensity={40}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
        )}
        <View style={styles.headerLeft}>
          <TouchableOpacity
            style={styles.logoBtn}
            onPress={() => { revealChevron(); setMenuOpen(true); }}
            activeOpacity={0.7}
          >
            <View style={styles.logoWrap}>
              <Text style={styles.headerLogo}>Laybell</Text>
              <Text style={styles.tm}>™</Text>
            </View>
            <Animated.View style={[styles.logoChevron, { opacity: chevronOpacity }]} pointerEvents="none">
              <Ionicons name="chevron-down" size={20} color={colors.primaryLight} />
            </Animated.View>
          </TouchableOpacity>
          {/* Live: a tv with a red LIVE disc on its screen — opens the live feed. */}
          <TouchableOpacity style={styles.liveBtn} onPress={() => router.push('/live')} activeOpacity={0.7}>
            <Ionicons name="tv-outline" size={30} color={colors.text} />
            <View style={styles.liveDisc}>
              <Text style={styles.liveDiscText}>LIVE</Text>
            </View>
          </TouchableOpacity>
        </View>
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
      </Animated.View>

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
                  <Text style={[styles.menuItemText, active && styles.menuItemTextActive]}>{t(`feed.filter.${opt.key}`)}</Text>
                  {active && (
                    <Ionicons name="checkmark" size={18} color={colors.primaryLight} style={styles.menuCheck} />
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        </TouchableOpacity>
      </Modal>

      <FlashList
        ref={feedListRef}
        data={gatedFeedData}
        // Spotlight instances key off their campaign so a promoted post can
        // never key-collide with itself (organic copies are filtered at merge).
        // In v2 this is also the recycler's stable id — load-bearing.
        keyExtractor={(item) => (item.__spotlight ? `spot:${item.__spotlight.campaignId}` : item.id)}
        // Recycle pools are per-type: an ad cell must never be recycled into a
        // post cell (renderPost's root ternary would swap component trees —
        // a full remount AND a polluted pool).
        getItemType={(item) => ((item as any).__gate ? 'gate' : (item as any).__ad ? 'ad' : 'post')}
        renderItem={renderPost}
        ListHeaderComponent={FeedHeader}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={feedContentStyle}
        // Drives the reactive chrome (discrete state picks + native glides) and
        // the velocity gate. The gate deliberately does NOT engage at drag
        // start anymore: that was a 2026-06 patch that paused the playing
        // video's native player at EVERY touch-down to mask a re-render burst
        // whose root cause (renderPost identity churn) has since been fixed —
        // Instagram-style, videos now keep playing through slow/medium scrolls
        // and the gate engages only on real velocity (≥GATE_IN).
        onScroll={(e) => {
          const y = e.nativeEvent.contentOffset.y;
          if (Math.abs(y - lastTapGuardY.current) > 2) { lastTapGuardY.current = y; lastScrollMoveAt.current = Date.now(); }
          trackFeedScroll(y, e.nativeEvent.contentSize.height - e.nativeEvent.layoutMeasurement.height);
          trackScrollVelocity(y);
        }}
        onScrollBeginDrag={() => { scrollingRef.current = true; cancelMusicFlush(); feedDragStart(); }}
        onScrollEndDrag={feedDragEnd}
        onMomentumScrollEnd={() => { setFastScroll(false); settleFeedChrome(); scrollingRef.current = false; flushVideoAtRest(); armMusicFlush(); }}
        // 16 is deliberate: the chrome is discrete now (no per-frame JS follow),
        // so 60Hz sampling halves per-frame JS scroll work vs throttle 1 —
        // headroom for cell mounts. Don't "fix" this back to 1.
        scrollEventThrottle={16}
        // (FlatList-era knobs — windowSize/maxToRenderPerBatch/
        // initialNumToRender/removeClippedSubviews — don't exist in v2:
        // recycling replaces batched mounting; drawDistance stays at its 250dp
        // default, raise only if posters visibly pop in late.)
        viewabilityConfigCallbackPairs={viewabilityConfigCallbackPairs}
        refreshControl={
          <RefreshControl
            progressViewOffset={headerH}
            refreshing={refreshing}
            // Reload the seen-set from storage first so posts shown in prior
            // loads get the seen-penalty and genuinely new/unseen recent posts
            // rise to the top on every pull-to-refresh.
            onRefresh={async () => {
              impactLight(); // tactile confirm the pull-to-refresh caught
              setRefreshing(true);
              // RE-GATE (owner design): a refresh brings fresh content, so the
              // optimization pass must repeat — the gate returns at the bottom
              // of the new post 3 and re-arms/prefetches for the new list.
              if (gateUnlockTimer.current) { clearTimeout(gateUnlockTimer.current); gateUnlockTimer.current = null; }
              gateArmedRef.current = false;
              setFeedGateUnlocked(false);
              refreshStories();
              // Release any pinned just-posted posts so they fall into natural rank.
              clearPinned();
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
                ? t('feed.emptyFollowingTitle')
                : feedMode === 'friends'
                ? t('feed.emptyFriendsTitle')
                : t('feed.emptyTitle')}
            </Text>
            <Text style={styles.emptySubtitle}>
              {feedMode === 'following'
                ? t('feed.emptyFollowingSub')
                : feedMode === 'friends'
                ? t('feed.emptyFriendsSub')
                : t('feed.emptySub')}
            </Text>
            {feedMode !== 'all' && (
              <TouchableOpacity style={styles.exploreBtn} onPress={() => router.push('/(tabs)/explore')}>
                <Text style={styles.exploreBtnText}>{t('feed.discoverArtists')}</Text>
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
  // Absolute-fill (same trick as the story camera): escapes the pager's
  // bar-height scene padding so the feed truly extends under the tab bar —
  // when the reactive chrome hides the bar, CONTENT shows there, not a
  // background strip. The list pads its own bottom to clear the bar instead.
  container: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.background },
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
  // Reactive chrome: the header floats over the feed (which pads itself by the
  // measured height) so it can slide away without reflowing the list.
  headerFloat: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    zIndex: 20,
    backgroundColor: colors.background,
  },
  // iOS: drop the solid fill so the BlurView behind provides a real frosted surface.
  headerGlass: { backgroundColor: 'transparent' },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  logoBtn: { flexDirection: 'row', alignItems: 'center' },
  liveBtn: { position: 'relative', padding: 2, marginTop: 2 },
  // Red disc centered on the tv's screen area (the glyph's top ~2/3).
  liveDisc: {
    position: 'absolute',
    top: 7,
    left: 8.5,
    width: 17,
    height: 17,
    borderRadius: 8.5,
    backgroundColor: '#F43F5E',
    alignItems: 'center',
    justifyContent: 'center',
  },
  liveDiscText: { color: '#fff', fontSize: 5.5, fontWeight: '800', letterSpacing: 0.2 },
  headerLogo: {
    color: colors.primaryLight,
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  logoChevron: { marginLeft: 2, marginTop: 4 },
  // Wordmark + ™ tucked into the bottom-right corner of "Laybell".
  logoWrap: { flexDirection: 'row', alignItems: 'flex-end' },
  tm: { fontSize: 11, fontWeight: '700', color: colors.primaryLight, marginLeft: 1, marginBottom: 3 },
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
  // minWidth:0 lets this flex child shrink below its content width, so a long
  // name truncates instead of shoving the spotlight pill onto the Follow button.
  postHeaderInfo: { flex: 1, minWidth: 0 },
  postNameRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  // Spotlight indicator: plain yellow sparkle + text, no orange pill/circle.
  // flexShrink:0 keeps it intact; the name (flexShrink:1) yields space instead.
  spotPill: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    marginLeft: 4, flexShrink: 0,
  },
  spotPillText: { color: colors.primaryLight, fontSize: 11, fontWeight: '800', letterSpacing: 0.3 },
  // flexShrink:1 so a long name ellipsizes rather than pushing siblings out.
  postDisplayName: { color: colors.text, fontSize: 14, fontWeight: '700', letterSpacing: 0.1, flexShrink: 1 },
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

  captionRow: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center',
    paddingHorizontal: SPACING.md, paddingTop: SPACING.sm,
  },
  caption: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 21,
    flexShrink: 1,
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
