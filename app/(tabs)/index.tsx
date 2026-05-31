import { Video, ResizeMode } from 'expo-av';
import { useRouter } from 'expo-router';
import { Audio } from 'expo-av';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Image,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { COLORS, SPACING, RADIUS } from '../../constants/theme';

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
  const [sound, setSound] = useState<any>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [savedPosts, setSavedPosts] = useState<Set<string>>(new Set());
  const router = useRouter();
  const [feedMode, setFeedMode] = useState<'all' | 'following'>('all');
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
  if (initialized) fetchPosts(currentUserId || undefined);
}, [feedMode]);

  useEffect(() => {
    setup();
  }, []);

  async function setup() {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) setCurrentUserId(user.id);
    await fetchPosts(user?.id);

  setInitialized(true);

  }

  async function fetchPosts(userId?: string) {
  let query = supabase
    .from('posts')
    .select(`
      *,
      profiles!posts_user_id_fkey (username, display_name, avatar_url)
    `)
    .eq('is_public', true)
    .order('created_at', { ascending: false })
    .limit(50);

  if (feedMode === 'following' && userId) {
    const { data: followingData } = await supabase
      .from('follows')
      .select('following_id')
      .eq('follower_id', userId);

    const followingIds = followingData?.map(f => f.following_id) || [];

    if (followingIds.length === 0) {
      setPosts([]);
      setLoading(false);
      setRefreshing(false);
      return;
    }

    query = query.in('user_id', followingIds);
  }

  const { data, error } = await query;

  if (data) setPosts(data.map(post => ({
    ...post,
    likes: [{ count: 0 }],
    comments: [{ count: 0 }],
  })) as any);

  if (userId) {
    const { data: likesData } = await supabase
      .from('likes')
      .select('post_id')
      .eq('user_id', userId);

    if (likesData) {
      setLikedPosts(new Set(likesData.map(l => l.post_id)));
    }
  }

  setLoading(false);
  setRefreshing(false);
}

  async function handleLike(postId: string) {
    if (!currentUserId) return;

    const isLiked = likedPosts.has(postId);

    // Optimistic update
    setLikedPosts(prev => {
      const next = new Set(prev);
      isLiked ? next.delete(postId) : next.add(postId);
      return next;
    });

    setPosts(prev => prev.map(post => {
      if (post.id !== postId) return post;
      const currentCount = post.likes[0]?.count || 0;
      return {
        ...post,
        likes: [{ count: isLiked ? currentCount - 1 : currentCount + 1 }],
      };
    }));

    if (isLiked) {
      await supabase.from('likes')
        .delete()
        .eq('user_id', currentUserId)
        .eq('post_id', postId);
    } else {
      await supabase.from('likes')
        .insert({ user_id: currentUserId, post_id: postId });
    }
  }
  async function handleSaveTrack(postId: string) {
  if (!currentUserId) return;

  const isSaved = savedPosts.has(postId);

  // Optimistic update
  setSavedPosts(prev => {
    const next = new Set(prev);
    isSaved ? next.delete(postId) : next.add(postId);
    return next;
  });

  if (isSaved) {
    await supabase
      .from('saves')
      .delete()
      .eq('user_id', currentUserId)
      .eq('post_id', postId);
  } else {
    await supabase
      .from('saves')
      .insert({
        user_id: currentUserId,
        post_id: postId,
      });
  }
}

  function timeAgo(dateString: string) {
    const now = new Date();
    const date = new Date(dateString);
    const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
  }

  async function handlePlayAudio(postId: string, audioUrl: string) {
  try {
    // If something is already playing, stop it first
    if (sound) {
      await sound.stopAsync();
      await sound.unloadAsync();
      setSound(null);
      if (playingId === postId) {
        setPlayingId(null);
        return;
      }
    }

    setPlayingId(postId);

    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      shouldDuckAndroid: true,
    });

    const { sound: newSound } = await Audio.Sound.createAsync(
      { uri: audioUrl },
      { shouldPlay: true }
    );

    setSound(newSound);

    newSound.setOnPlaybackStatusUpdate((status: any) => {
      if (status.didJustFinish) {
        setPlayingId(null);
        setSound(null);
      }
    });

  } catch (err) {
    console.log('audio error:', err);
    setPlayingId(null);
  }
}

  function renderPost({ item }: { item: Post }) {
    const isLiked = likedPosts.has(item.id);
    const likeCount = item.likes[0]?.count || 0;
    const commentCount = item.comments[0]?.count || 0;

    return (
      <View style={styles.postCard}>

        {/* Post Header */}
<TouchableOpacity
  style={styles.postHeader}
  onPress={() => router.push(`/profile/${item.user_id}`)}
>
  {item.profiles?.avatar_url ? (
  <Image
    source={{ uri: item.profiles.avatar_url }}
    style={styles.avatarSmall}
  />
) : (
  <View style={styles.avatarSmall}>
    <Text style={styles.avatarSmallText}>
      {item.profiles?.display_name?.charAt(0).toUpperCase()}
    </Text>
  </View>
)}
  <View style={styles.postHeaderInfo}>
    <Text style={styles.postDisplayName}>
      {item.profiles?.display_name}
    </Text>
    <Text style={styles.postUsername}>
      {'@'}{item.profiles?.username} · {timeAgo(item.created_at)}
    </Text>
  </View>
  <View style={styles.postTypeBadge}>
    <Text style={styles.postTypeText}>
      {item.type === 'audio' ? '🎵' : item.type === 'video' ? '🎬' : '🖼️'}
    </Text>
  </View>
</TouchableOpacity>

        {/* Media */}
        {item.type === 'image' && item.media_url && (
  <Image
    source={{ uri: item.media_url }}
    style={styles.postImage}
    resizeMode="cover"
  />
)}

        {item.type === 'audio' && (
  <TouchableOpacity
    style={styles.audioCard}
    onPress={() => handlePlayAudio(item.id, item.media_url)}
  >
    <Text style={styles.audioIcon}>🎵</Text>
    <Text style={styles.audioText}>Audio Track</Text>
    <View style={[
      styles.playButton,
      playingId === item.id && { backgroundColor: COLORS.error }
    ]}>
      <Text style={styles.playButtonText}>
        {playingId === item.id ? '■ Stop' : '▶ Play'}
      </Text>
    </View>
  </TouchableOpacity>
)}

        {item.type === 'video' && item.media_url && (
  <Video
    source={{ uri: item.media_url }}
    style={styles.videoPlayer}
    useNativeControls
    resizeMode={ResizeMode.CONTAIN}
    isLooping={true}
    shouldPlay={false}
  />
)}

        {/* Caption */}
        {item.caption ? (
          <Text style={styles.caption}>{item.caption}</Text>
        ) : null}

        {/* Actions */}
<View style={styles.actions}>
  <TouchableOpacity
    style={styles.actionButton}
    onPress={() => handleLike(item.id)}
  >
    <Text style={styles.actionIcon}>{isLiked ? '❤️' : '🤍'}</Text>
    <Text style={[
      styles.actionCount,
      isLiked && { color: COLORS.error }
    ]}>
      {likeCount}
    </Text>
  </TouchableOpacity>

  <TouchableOpacity
  style={styles.actionButton}
  onPress={() => router.push(`/comments/${item.id}`)}
>
  <Text style={styles.actionIcon}>💬</Text>
  <Text style={styles.actionCount}>{commentCount}</Text>
</TouchableOpacity>
  {item.type === 'audio' && (
    <TouchableOpacity
      style={styles.actionButton}
      onPress={() => handleSaveTrack(item.id)}
    >
      <Text style={styles.actionIcon}>
        {savedPosts.has(item.id) ? '🔖' : '🎵'}
      </Text>
      <Text style={styles.actionCount}>Save</Text>
    </TouchableOpacity>
  )}

  <TouchableOpacity style={styles.actionButton}>
    <Text style={styles.actionIcon}>↗️</Text>
    <Text style={styles.actionCount}>Share</Text>
  </TouchableOpacity>
</View>

      </View>
    );
  }

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
      <Text style={[styles.feedToggleText, feedMode === 'all' && styles.feedToggleTextActive]}>
        All
      </Text>
    </TouchableOpacity>
    <TouchableOpacity
      style={[styles.feedToggle, feedMode === 'following' && styles.feedToggleActive]}
      onPress={() => setFeedMode('following')}
    >
      <Text style={[styles.feedToggleText, feedMode === 'following' && styles.feedToggleTextActive]}>
        Following
      </Text>
    </TouchableOpacity>
    <TouchableOpacity onPress={() => router.push('/messages')}>
  <Text style={styles.headerIcon}>✉️</Text>
</TouchableOpacity>
  </View>
</View>

      <FlatList
        data={posts}
        keyExtractor={(item) => item.id}
        renderItem={renderPost}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.feedContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              fetchPosts(currentUserId || undefined);
            }}
            tintColor={COLORS.primary}
          />
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyIcon}>🎵</Text>
            <Text style={styles.emptyTitle}>No posts yet</Text>
            <Text style={styles.emptySubtitle}>
              Be the first to post on Laybell!
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: COLORS.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.xxl + SPACING.sm,
    paddingBottom: SPACING.md,
    borderBottomWidth: 0.5,
    borderBottomColor: COLORS.border,
  },
  headerLogo: {
    color: COLORS.primary,
    fontSize: 22,
    fontWeight: 'bold',
    letterSpacing: 1,
  },
  headerIcon: {
    fontSize: 22,
  },
  feedContent: {
    paddingBottom: SPACING.xxl,
  },
  postCard: {
    backgroundColor: COLORS.background,
    borderBottomWidth: 0.5,
    borderBottomColor: COLORS.border,
    paddingBottom: SPACING.sm,
    marginBottom: SPACING.xs,
  },
  postHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: SPACING.md,
    gap: SPACING.sm,
  },
  avatarSmall: {
    width: 40,
    height: 40,
    borderRadius: RADIUS.full,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarSmallText: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: 'bold',
  },
  postHeaderInfo: {
    flex: 1,
  },
  postDisplayName: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '700',
  },
  postUsername: {
    color: COLORS.textTertiary,
    fontSize: 12,
    marginTop: 1,
  },
  postTypeBadge: {
    padding: SPACING.xs,
  },
  postTypeText: {
    fontSize: 18,
  },
  postImage: {
    width: '100%',
    height: 300,
    backgroundColor: COLORS.surface,
  },
  audioCard: {
    margin: SPACING.md,
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md,
    padding: SPACING.lg,
    alignItems: 'center',
    gap: SPACING.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  audioIcon: {
    fontSize: 40,
  },
  audioText: {
    color: COLORS.textSecondary,
    fontSize: 14,
  },
  playButton: {
    backgroundColor: COLORS.primary,
    borderRadius: RADIUS.full,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    marginTop: SPACING.xs,
  },
  playButtonText: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '600',
  },
  caption: {
    color: COLORS.text,
    fontSize: 14,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    lineHeight: 20,
  },
  actions: {
    flexDirection: 'row',
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.sm,
    gap: SPACING.lg,
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  actionIcon: {
    fontSize: 20,
  },
  actionCount: {
    color: COLORS.textSecondary,
    fontSize: 13,
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 120,
    gap: SPACING.md,
  },
  emptyIcon: {
    fontSize: 48,
  },
  emptyTitle: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: 'bold',
  },
  emptySubtitle: {
    color: COLORS.textSecondary,
    fontSize: 14,
  },
  headerRight: {
  flexDirection: 'row',
  alignItems: 'center',
  gap: SPACING.sm,
},
feedToggle: {
  paddingVertical: 4,
  paddingHorizontal: SPACING.sm,
  borderRadius: RADIUS.full,
  borderWidth: 1,
  borderColor: COLORS.border,
},
feedToggleActive: {
  backgroundColor: COLORS.primary,
  borderColor: COLORS.primary,
},
feedToggleText: {
  color: COLORS.textSecondary,
  fontSize: 12,
  fontWeight: '500',
},
feedToggleTextActive: {
  color: COLORS.text,
  fontWeight: '700',
},
videoPlayer: {
  width: '100%',
  height: 300,
  backgroundColor: COLORS.surface,
},
});