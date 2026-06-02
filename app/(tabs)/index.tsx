import { Video, ResizeMode } from 'expo-av';
import { useRouter, useFocusEffect } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { usePagerSwiping } from '../../contexts/PagerContext';
import {
  View, Text, StyleSheet, FlatList,
  TouchableOpacity, Image, ActivityIndicator,
  RefreshControl, Share, Dimensions, Alert,
} from 'react-native';

const SCREEN_W = Dimensions.get('window').width;
const MAX_VIDEO_H = SCREEN_W * 1.25; // cap feed video at 4:5 so tall (9:16) clips aren't too long
import { useEffect, useState, useCallback, useRef, memo } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { COLORS, SPACING, RADIUS, SHADOWS, GRADIENTS } from '../../constants/theme';
import { timeAgo } from '../../lib/timeAgo';
import { useAudio } from '../../contexts/AudioContext';
import { createNotification } from '../../lib/createNotification';
import AddToPlaylistModal from '../../components/AddToPlaylistModal';
import { aspectToNumber } from '../../lib/aspectRatio';
import TrackRow from '../../components/TrackRow';

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
  duration_seconds?: number | null;
};

type PostCardProps = {
  item: Post;
  isOwn: boolean;
  isLiked: boolean;
  isSaved: boolean;
  audioActive: boolean;
  videoMuted: boolean;
  shouldPlayVideo: boolean;
  onProfile: (item: Post) => void;
  onOptions: (item: Post) => void;
  onOpenPost: (item: Post) => void;
  onPlayTrack: (item: Post) => void;
  onExpandTrack: (item: Post) => void;
  onToggleMuted: () => void;
  onLike: (item: Post) => void;
  onSave: (item: Post) => void;
  onShare: (item: Post) => void;
};

// Memoized so that toggling a like/save on one post (which changes the feed's
// liked/saved sets) only re-renders that card — not all ~50 rows. All callbacks
// from HomeScreen are referentially stable, and `item` keeps its reference for
// unchanged posts, so React.memo's shallow compare skips them.
const PostCard = memo(function PostCard({
  item, isOwn, isLiked, isSaved, audioActive, videoMuted, shouldPlayVideo,
  onProfile, onOptions, onOpenPost, onPlayTrack, onExpandTrack, onToggleMuted, onLike, onSave, onShare,
}: PostCardProps) {
  const likeCount = item.likes[0]?.count || 0;
  const commentCount = item.comments[0]?.count || 0;
  const saveCount = item.save_count || 0;
  const typeIcon = item.type === 'audio' ? 'musical-notes' : item.type === 'video' ? 'videocam' : 'image-outline';

  return (
    <View style={styles.postCard}>
      {/* Header */}
      <TouchableOpacity style={styles.postHeader} onPress={() => onProfile(item)}>
        {item.profiles?.avatar_url ? (
          <Image source={{ uri: item.profiles.avatar_url }} style={styles.avatar} />
        ) : (
          <LinearGradient colors={GRADIENTS.primary} style={styles.avatar}>
            <Text style={styles.avatarText}>
              {item.profiles?.display_name?.charAt(0).toUpperCase()}
            </Text>
          </LinearGradient>
        )}
        <View style={styles.postHeaderInfo}>
          <Text style={styles.postDisplayName}>{item.profiles?.display_name}</Text>
          <Text style={styles.postUsername}>
            @{item.profiles?.username} · {timeAgo(item.created_at)}
          </Text>
        </View>
        {isOwn ? (
          <TouchableOpacity style={styles.typeIconWrap} onPress={() => onOptions(item)}>
            <Ionicons name={typeIcon} size={16} color={COLORS.primary} />
          </TouchableOpacity>
        ) : (
          <View style={styles.typeIconWrap}>
            <Ionicons name={typeIcon} size={16} color={COLORS.primary} />
          </View>
        )}
      </TouchableOpacity>

      {/* Media */}
      {item.type === 'image' && item.media_url && (
        <TouchableOpacity onPress={() => onOpenPost(item)}>
          <Image
            source={{ uri: item.media_url }}
            style={[styles.postMedia, { aspectRatio: aspectToNumber(item.aspect_ratio, 1) }]}
            resizeMode="cover"
          />
        </TouchableOpacity>
      )}

      {item.type === 'audio' && (
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
          />
        </View>
      )}

      {item.type === 'video' && item.media_url && (
        <View>
          <TouchableOpacity activeOpacity={1} onPress={() => onOpenPost(item)}>
            <Video
              source={{ uri: item.media_url }}
              style={[styles.postVideo, { height: Math.min(SCREEN_W / aspectToNumber(item.aspect_ratio, 16 / 9), MAX_VIDEO_H) }]}
              resizeMode={ResizeMode.COVER}
              isLooping
              isMuted={videoMuted}
              shouldPlay={shouldPlayVideo}
            />
          </TouchableOpacity>
          <TouchableOpacity style={styles.videoAudioBtn} onPress={onToggleMuted}>
            <Ionicons name={videoMuted ? 'volume-mute' : 'volume-high'} size={18} color={COLORS.text} />
          </TouchableOpacity>
        </View>
      )}

      {/* Caption */}
      {!!item.caption && item.type !== 'audio' && (
        <TouchableOpacity onPress={() => onOpenPost(item)}>
          <Text style={styles.caption} numberOfLines={3}>{item.caption}</Text>
        </TouchableOpacity>
      )}

      {/* Actions */}
      <View style={styles.actions}>
        <TouchableOpacity style={styles.actionBtn} onPress={() => onLike(item)}>
          <Ionicons
            name={isLiked ? 'heart' : 'heart-outline'}
            size={22}
            color={isLiked ? COLORS.like : COLORS.textSecondary}
          />
          {likeCount > 0 && (
            <Text style={[styles.actionCount, isLiked && { color: COLORS.primaryLight }]}>{likeCount}</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={styles.actionBtn} onPress={() => onOpenPost(item)}>
          <Ionicons name="chatbubble-outline" size={20} color={COLORS.textSecondary} />
          {commentCount > 0 && <Text style={styles.actionCount}>{commentCount}</Text>}
        </TouchableOpacity>

        <TouchableOpacity style={styles.actionBtn} onPress={() => onSave(item)}>
          <Ionicons
            name={isSaved ? 'bookmark' : 'bookmark-outline'}
            size={20}
            color={isSaved ? COLORS.primary : COLORS.textSecondary}
          />
          {saveCount > 0 && (
            <Text style={[styles.actionCount, isSaved && { color: COLORS.primary }]}>{saveCount}</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={[styles.actionBtn, styles.actionBtnRight]} onPress={() => onShare(item)}>
          <Ionicons name="share-social-outline" size={20} color={COLORS.textSecondary} />
        </TouchableOpacity>
      </View>
    </View>
  );
});

export default function HomeScreen() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [likedPosts, setLikedPosts] = useState<Set<string>>(new Set());
  const { play, currentTrack, isPlaying, expand, videoMuted, toggleVideoMuted } = useAudio();
  const [savedPosts, setSavedPosts] = useState<Set<string>>(new Set());
  const [unreadCount, setUnreadCount] = useState(0);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [playlistModalPostId, setPlaylistModalPostId] = useState<string | null>(null);
  const [playlistCount, setPlaylistCount] = useState(0);
  const [visibleVideoId, setVisibleVideoId] = useState<string | null>(null);
  const router = useRouter();

  // Only autoplay feed videos when this tab is settled and focused — not while
  // a swipe is dragging the feed off-screen (saves rendering, matches "land first").
  const isFocused = useIsFocused();
  const swiping = usePagerSwiping();
  const canPlayVideo = isFocused && !swiping;

  // Latest values for the stable card callbacks below. Updating a ref (instead of
  // putting these in useCallback deps) lets the callbacks keep a constant identity
  // — so memoized PostCards don't re-render — while still acting on current state.
  const live = useRef({ currentUserId, likedPosts, savedPosts, playlistCount, router, play, expand, toggleVideoMuted });
  live.current = { currentUserId, likedPosts, savedPosts, playlistCount, router, play, expand, toggleVideoMuted };

  // Track which video is on-screen so it auto-plays while others pause.
  // FlatList requires these references to be stable across renders.
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: any[] }) => {
    const firstVideo = viewableItems.find(v => v.item?.type === 'video');
    setVisibleVideoId(firstVideo ? firstVideo.item.id : null);
  }).current;
  const [feedMode, setFeedMode] = useState<'all' | 'following'>('all');
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (initialized) fetchPosts(currentUserId || undefined);
  }, [feedMode]);

  useEffect(() => {
    if (!currentUserId) return;
    const channel = supabase
      .channel(`notif-badge-${currentUserId}`)
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

  async function setup() {
    const { data: { user } } = await supabase.auth.getUser();
    const userId = user?.id ?? null;
    if (userId) setCurrentUserId(userId);

    await Promise.all([
      fetchPosts(userId ?? undefined),
      userId
        ? supabase.from('notifications').select('*', { count: 'exact', head: true })
            .eq('user_id', userId).eq('read', false)
            .then(({ count }) => setUnreadCount(count || 0))
        : Promise.resolve(),
    ]);
    setInitialized(true);
  }

  async function fetchPosts(userId?: string) {
    let query = supabase
      .from('posts')
      .select(`
        *,
        profiles!posts_user_id_fkey (username, display_name, avatar_url),
        likes(count),
        comments(count)
      `)
      .order('created_at', { ascending: false })
      .limit(50);

    if (feedMode === 'following' && userId) {
      const { data: followingData } = await supabase
        .from('follows').select('following_id').eq('follower_id', userId);
      const followingIds = followingData?.map(f => f.following_id) ?? [];
      if (followingIds.length === 0) {
        setPosts([]); setLoading(false); setRefreshing(false); return;
      }
      // Following feed: show both public and followers-only posts from people you follow
      query = query.in('user_id', followingIds);
    } else {
      // Discovery feed: public posts only
      query = query.eq('is_public', true);
    }

    const [{ data }, { data: likesData }, { data: savesData }] = await Promise.all([
      query,
      userId ? supabase.from('likes').select('post_id').eq('user_id', userId) : Promise.resolve({ data: null }),
      userId ? supabase.from('saves').select('post_id').eq('user_id', userId) : Promise.resolve({ data: null }),
    ]);

    if (data) {
      let scored: any[];
      if (feedMode === 'all') {
        // Engagement-weighted sort: likes*3 + comments*5, decayed over time.
        // Score each post once (decorate–sort–undecorate) instead of recomputing
        // inside the comparator, which re-parsed every date O(n log n) times.
        const now = Date.now();
        scored = (data as any[])
          .map((p) => {
            const likes = p.likes?.[0]?.count || 0;
            const comments = p.comments?.[0]?.count || 0;
            const hoursOld = (now - new Date(p.created_at).getTime()) / 3_600_000;
            return { p, score: (likes * 3 + comments * 5) / Math.pow(hoursOld + 2, 1.2) };
          })
          .sort((a, b) => b.score - a.score)
          .map((x) => x.p);
      } else {
        scored = [...(data as any[])];
      }
      setPosts(scored);
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
      // Audio: if the user has playlists, offer to add the just-saved track to one.
      if (item.type === 'audio' && plCount > 0) setPlaylistModalPostId(item.id);
    }
  }, []);

  const onShare = useCallback(async (item: Post) => {
    const link = `laybell://post/${item.id}`;
    const text = item.caption
      ? `"${item.caption}" — @${item.profiles?.username} on Laybell`
      : `Check out @${item.profiles?.username} on Laybell`;
    try {
      await Share.share({ message: `${text}\n${link}`, url: link });
    } catch {}
  }, []);

  const onProfile = useCallback((item: Post) => live.current.router.push(`/profile/${item.user_id}`), []);
  const onOpenPost = useCallback((item: Post) => live.current.router.push(`/post/${item.id}`), []);

  const onPlayTrack = useCallback((item: Post) => {
    live.current.play({ id: item.id, uri: item.media_url, caption: item.caption, artist: item.profiles?.display_name, cover: item.cover_url });
  }, []);
  const onExpandTrack = useCallback((item: Post) => {
    live.current.play({ id: item.id, uri: item.media_url, caption: item.caption, artist: item.profiles?.display_name, cover: item.cover_url });
    live.current.expand();
  }, []);
  const onToggleMuted = useCallback(() => live.current.toggleVideoMuted(), []);

  const onOptions = useCallback((item: Post) => {
    Alert.alert('Post options', undefined, [
      {
        text: 'Delete post',
        style: 'destructive',
        onPress: () => Alert.alert('Delete post?', 'This permanently deletes the post and can’t be undone.', [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete', style: 'destructive', onPress: async () => {
              await supabase.from('posts').delete().eq('id', item.id);
              setPosts(prev => prev.filter(p => p.id !== item.id));
            },
          },
        ]),
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, []);

  const renderPost = useCallback(({ item }: { item: Post }) => (
    <PostCard
      item={item}
      isOwn={item.user_id === currentUserId}
      isLiked={likedPosts.has(item.id)}
      isSaved={savedPosts.has(item.id)}
      audioActive={isPlaying && currentTrack?.id === item.id}
      videoMuted={videoMuted}
      shouldPlayVideo={canPlayVideo && visibleVideoId === item.id}
      onProfile={onProfile}
      onOptions={onOptions}
      onOpenPost={onOpenPost}
      onPlayTrack={onPlayTrack}
      onExpandTrack={onExpandTrack}
      onToggleMuted={onToggleMuted}
      onLike={onLike}
      onSave={onSave}
      onShare={onShare}
    />
  ), [currentUserId, likedPosts, savedPosts, isPlaying, currentTrack, videoMuted, canPlayVideo, visibleVideoId,
      onProfile, onOptions, onOpenPost, onPlayTrack, onExpandTrack, onToggleMuted, onLike, onSave, onShare]);

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color={COLORS.primary} size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerLogo}>Laybell</Text>
        <View style={styles.headerRight}>
          <TouchableOpacity
            style={[styles.feedToggle, feedMode === 'all' && styles.feedToggleActive]}
            onPress={() => setFeedMode('all')}
          >
            <Text style={[styles.feedToggleText, feedMode === 'all' && styles.feedToggleTextActive]}>All</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.feedToggle, feedMode === 'following' && styles.feedToggleActive]}
            onPress={() => setFeedMode('following')}
          >
            <Text style={[styles.feedToggleText, feedMode === 'following' && styles.feedToggleTextActive]}>Following</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.headerIconBtn}
            onPress={() => { setUnreadCount(0); router.push('/notifications'); }}
          >
            <Ionicons name="notifications-outline" size={24} color={COLORS.text} />
            {unreadCount > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{unreadCount > 9 ? '9+' : unreadCount}</Text>
              </View>
            )}
          </TouchableOpacity>

          <TouchableOpacity style={styles.headerIconBtn} onPress={() => router.push('/messages')}>
            <Ionicons name="chatbubbles-outline" size={24} color={COLORS.text} />
            {unreadMessages > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{unreadMessages > 9 ? '9+' : unreadMessages}</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>
      </View>

      <FlatList
        data={posts}
        keyExtractor={(item) => item.id}
        renderItem={renderPost}
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
            onRefresh={() => { setRefreshing(true); fetchPosts(currentUserId || undefined); }}
            tintColor={COLORS.primary}
          />
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Ionicons name="musical-notes" size={48} color={COLORS.textTertiary} />
            <Text style={styles.emptyTitle}>
              {feedMode === 'following' ? 'No posts from people you follow' : 'No posts yet'}
            </Text>
            <Text style={styles.emptySubtitle}>
              {feedMode === 'following'
                ? 'Follow some artists to see their posts here'
                : 'Be the first to post on Laybell'}
            </Text>
            {feedMode === 'following' && (
              <TouchableOpacity style={styles.exploreBtn} onPress={() => router.push('/(tabs)/explore')}>
                <Text style={styles.exploreBtnText}>Discover Artists</Text>
                <Ionicons name="arrow-forward" size={16} color={COLORS.text} />
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  loadingContainer: { flex: 1, backgroundColor: COLORS.background, alignItems: 'center', justifyContent: 'center' },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.xxl + SPACING.sm,
    paddingBottom: SPACING.sm,
    borderBottomWidth: 0.5,
    borderBottomColor: COLORS.border,
  },
  headerLogo: {
    color: COLORS.primaryLight,
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  headerIconBtn: { position: 'relative', padding: 2 },

  feedToggle: {
    paddingVertical: 5,
    paddingHorizontal: SPACING.sm,
    borderRadius: RADIUS.full,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  feedToggleActive: { backgroundColor: COLORS.primaryDark, borderColor: COLORS.primary },
  feedToggleText: { color: COLORS.textSecondary, fontSize: 12, fontWeight: '500' },
  feedToggleTextActive: { color: COLORS.text, fontWeight: '700' },

  badge: {
    position: 'absolute', top: -2, right: -2,
    minWidth: 16, height: 16, borderRadius: 8,
    backgroundColor: COLORS.error,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3,
  },
  badgeText: { color: COLORS.text, fontSize: 9, fontWeight: 'bold' },

  feedContent: { paddingBottom: SPACING.xxl + 60 },

  postCard: {
    backgroundColor: COLORS.background,
    borderBottomWidth: 0.5,
    borderBottomColor: COLORS.borderSubtle,
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
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: COLORS.text, fontSize: 15, fontWeight: '700' },
  postHeaderInfo: { flex: 1 },
  postDisplayName: { color: COLORS.text, fontSize: 14, fontWeight: '700', letterSpacing: 0.1 },
  postUsername: { color: COLORS.textTertiary, fontSize: 12, marginTop: 1 },
  typeIconWrap: {
    width: 28, height: 28, borderRadius: RADIUS.full,
    backgroundColor: COLORS.primary + '18',
    alignItems: 'center', justifyContent: 'center',
  },

  postMedia: {
    width: '100%',
    backgroundColor: COLORS.surfaceLight,
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
  postImage: {
    width: '100%',
    height: 320,
    backgroundColor: COLORS.surfaceLight,
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
    backgroundColor: COLORS.primary + '44',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: COLORS.primary + '88',
  },
  audioCover: { width: 48, height: 48, borderRadius: RADIUS.sm, overflow: 'hidden' },
  audioCoverImg: { width: 48, height: 48 },
  audioCoverOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.35)',
  },
  audioIconRingActive: {
    backgroundColor: COLORS.primaryDark,
    borderColor: COLORS.primaryLight,
    ...SHADOWS.glow,
  },
  audioTitle: { color: COLORS.text, fontSize: 14, fontWeight: '600', maxWidth: 180 },
  audioMeta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  audioArtist: { color: COLORS.textSecondary, fontSize: 12 },
  audioStreams: { color: COLORS.textTertiary, fontSize: 12 },

  caption: {
    color: COLORS.text,
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
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  actionBtnRight: { marginLeft: 'auto' },
  actionCount: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '500' },

  emptyContainer: { alignItems: 'center', paddingTop: 100, gap: SPACING.md },
  emptyTitle: { color: COLORS.text, fontSize: 20, fontWeight: '700' },
  emptySubtitle: { color: COLORS.textSecondary, fontSize: 14, textAlign: 'center', paddingHorizontal: SPACING.lg },
  exploreBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: COLORS.primary, borderRadius: RADIUS.full,
    paddingVertical: SPACING.sm + 2, paddingHorizontal: SPACING.lg,
    marginTop: SPACING.sm,
  },
  exploreBtnText: { color: COLORS.text, fontSize: 14, fontWeight: '700' },
});
