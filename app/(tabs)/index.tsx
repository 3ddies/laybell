import { Video, ResizeMode } from 'expo-av';
import { useRouter, useFocusEffect } from 'expo-router';
import {
  View, Text, StyleSheet, FlatList,
  TouchableOpacity, Image, ActivityIndicator,
  RefreshControl, Share,
} from 'react-native';
import { useEffect, useState, useCallback } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { COLORS, SPACING, RADIUS, SHADOWS, GRADIENTS } from '../../constants/theme';
import { timeAgo } from '../../lib/timeAgo';
import { useAudio } from '../../contexts/AudioContext';
import { createNotification } from '../../lib/createNotification';

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
};

export default function HomeScreen() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [likedPosts, setLikedPosts] = useState<Set<string>>(new Set());
  const { play, currentTrack, isPlaying } = useAudio();
  const [savedPosts, setSavedPosts] = useState<Set<string>>(new Set());
  const [unreadCount, setUnreadCount] = useState(0);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const router = useRouter();
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

  // Refresh the unread-message badge whenever the feed regains focus
  // (messages get marked read on another screen).
  const fetchUnreadMessages = useCallback(async (userId: string) => {
    const { count } = await supabase
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('receiver_id', userId).eq('read', false);
    setUnreadMessages(count || 0);
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (currentUserId) fetchUnreadMessages(currentUserId);
    }, [currentUserId, fetchUnreadMessages])
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
      const scored = [...data] as any[];
      if (feedMode === 'all') {
        // Engagement-weighted sort: likes*3 + comments*5, decay over time
        scored.sort((a, b) => {
          const score = (p: any) => {
            const likes = p.likes?.[0]?.count || 0;
            const comments = p.comments?.[0]?.count || 0;
            const hoursOld = (Date.now() - new Date(p.created_at).getTime()) / 3_600_000;
            return (likes * 3 + comments * 5) / Math.pow(hoursOld + 2, 1.2);
          };
          return score(b) - score(a);
        });
      }
      setPosts(scored);
    }
    if (likesData) setLikedPosts(new Set(likesData.map((l: any) => l.post_id)));
    if (savesData) setSavedPosts(new Set(savesData.map((s: any) => s.post_id)));
    setLoading(false);
    setRefreshing(false);
  }

  async function handleLike(postId: string) {
    if (!currentUserId) return;
    const isLiked = likedPosts.has(postId);

    setLikedPosts(prev => {
      const next = new Set(prev);
      isLiked ? next.delete(postId) : next.add(postId);
      return next;
    });
    setPosts(prev => prev.map(post => {
      if (post.id !== postId) return post;
      const c = post.likes[0]?.count || 0;
      return { ...post, likes: [{ count: isLiked ? c - 1 : c + 1 }] };
    }));

    if (isLiked) {
      await supabase.from('likes').delete().eq('user_id', currentUserId).eq('post_id', postId);
    } else {
      await supabase.from('likes').insert({ user_id: currentUserId, post_id: postId });
      const post = posts.find(p => p.id === postId);
      if (post && post.user_id !== currentUserId) {
        createNotification({ userId: post.user_id, actorId: currentUserId, type: 'like', postId });
      }
    }
  }

  async function handleSaveTrack(postId: string) {
    if (!currentUserId) return;
    const isSaved = savedPosts.has(postId);
    setSavedPosts(prev => {
      const next = new Set(prev);
      isSaved ? next.delete(postId) : next.add(postId);
      return next;
    });
    if (isSaved) {
      await supabase.from('saves').delete().eq('user_id', currentUserId).eq('post_id', postId);
    } else {
      await supabase.from('saves').insert({ user_id: currentUserId, post_id: postId });
    }
  }

  async function handleShare(item: Post) {
    const link = `laybell://post/${item.id}`;
    const text = item.caption
      ? `"${item.caption}" — @${item.profiles?.username} on Laybell`
      : `Check out @${item.profiles?.username} on Laybell`;
    try {
      await Share.share({ message: `${text}\n${link}`, url: link });
    } catch {}
  }

  const renderPost = useCallback(({ item }: { item: Post }) => {
    const isLiked = likedPosts.has(item.id);
    const isSaved = savedPosts.has(item.id);
    const likeCount = item.likes[0]?.count || 0;
    const commentCount = item.comments[0]?.count || 0;
    const audioActive = isPlaying && currentTrack?.id === item.id;

    return (
      <View style={styles.postCard}>
        {/* Header */}
        <TouchableOpacity
          style={styles.postHeader}
          onPress={() => router.push(`/profile/${item.user_id}`)}
        >
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
          <View style={styles.typeIconWrap}>
            <Ionicons
              name={item.type === 'audio' ? 'musical-notes' : item.type === 'video' ? 'videocam' : 'image-outline'}
              size={16}
              color={COLORS.primary}
            />
          </View>
        </TouchableOpacity>

        {/* Media */}
        {item.type === 'image' && item.media_url && (
          <TouchableOpacity onPress={() => router.push(`/post/${item.id}`)}>
            <Image source={{ uri: item.media_url }} style={styles.postImage} resizeMode="cover" />
          </TouchableOpacity>
        )}

        {item.type === 'audio' && (
          <TouchableOpacity
            style={styles.audioCardWrap}
            onPress={() => play({ id: item.id, uri: item.media_url, caption: item.caption, artist: item.profiles?.display_name })}
          >
            <LinearGradient colors={audioActive ? ['#E8401C', '#C03010'] : ['#1C0E06', '#120A04']} style={styles.audioCard}>
              <View style={styles.audioLeft}>
                <View style={[styles.audioIconRing, audioActive && styles.audioIconRingActive]}>
                  <Ionicons name={audioActive ? 'stop' : 'play'} size={22} color={COLORS.text} />
                </View>
                <View>
                  <Text style={styles.audioTitle} numberOfLines={1}>
                    {item.caption || 'Audio Track'}
                  </Text>
                  <Text style={styles.audioArtist}>@{item.profiles?.username}</Text>
                </View>
              </View>
              <Ionicons name="musical-notes" size={32} color={COLORS.primary + '44'} />
            </LinearGradient>
          </TouchableOpacity>
        )}

        {item.type === 'video' && item.media_url && (
          <Video
            source={{ uri: item.media_url }}
            style={styles.postImage}
            useNativeControls
            resizeMode={ResizeMode.CONTAIN}
            isLooping
            shouldPlay={false}
          />
        )}

        {/* Caption */}
        {!!item.caption && item.type !== 'audio' && (
          <TouchableOpacity onPress={() => router.push(`/post/${item.id}`)}>
            <Text style={styles.caption} numberOfLines={3}>{item.caption}</Text>
          </TouchableOpacity>
        )}

        {/* Actions */}
        <View style={styles.actions}>
          <TouchableOpacity style={styles.actionBtn} onPress={() => handleLike(item.id)}>
            <Ionicons
              name={isLiked ? 'heart' : 'heart-outline'}
              size={22}
              color={isLiked ? COLORS.like : COLORS.textSecondary}
            />
            {likeCount > 0 && (
              <Text style={[styles.actionCount, isLiked && { color: COLORS.primaryLight }]}>{likeCount}</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity style={styles.actionBtn} onPress={() => router.push(`/post/${item.id}`)}>
            <Ionicons name="chatbubble-outline" size={20} color={COLORS.textSecondary} />
            {commentCount > 0 && <Text style={styles.actionCount}>{commentCount}</Text>}
          </TouchableOpacity>

          {item.type === 'audio' && (
            <TouchableOpacity style={styles.actionBtn} onPress={() => handleSaveTrack(item.id)}>
              <Ionicons
                name={isSaved ? 'bookmark' : 'bookmark-outline'}
                size={20}
                color={isSaved ? COLORS.primary : COLORS.textSecondary}
              />
            </TouchableOpacity>
          )}

          <TouchableOpacity style={[styles.actionBtn, styles.actionBtnRight]} onPress={() => handleShare(item)}>
            <Ionicons name="share-social-outline" size={20} color={COLORS.textSecondary} />
          </TouchableOpacity>
        </View>
      </View>
    );
  }, [likedPosts, savedPosts, currentTrack, isPlaying, posts, currentUserId, router]);

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
  audioIconRingActive: {
    backgroundColor: COLORS.primaryDark,
    borderColor: COLORS.primaryLight,
    ...SHADOWS.glow,
  },
  audioTitle: { color: COLORS.text, fontSize: 14, fontWeight: '600', maxWidth: 180 },
  audioArtist: { color: COLORS.textSecondary, fontSize: 12, marginTop: 2 },

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
