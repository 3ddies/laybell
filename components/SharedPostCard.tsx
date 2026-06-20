import { useEffect, useState, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Animated } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { supabase } from '../lib/supabase';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { isAudioPost } from '../lib/genres';
import { bumpBadge } from '../lib/badges';
import { createNotification } from '../lib/createNotification';
import VideoThumb from './VideoThumb';
import BadgeEmblem from './BadgeEmblem';

type SharedPost = {
  id: string;
  type: string;
  media_url: string;
  caption: string | null;
  cover_url: string | null;
  thumbnail_url: string | null;
  user_id: string;
  profiles?: { username: string; display_name: string; avatar_url: string | null; badge_tier?: string | null; badge_show?: boolean | null } | null;
};

// Module-level cache keyed by post id. The chat re-renders constantly while
// audio plays; caching means the card never refetches or flickers.
const cache = new Map<string, SharedPost | null>();

// Instagram-style "shell" of a shared post, rendered inside a chat bubble.
// Tapping it opens the full post.
export default function SharedPostCard({ postId }: { postId: string }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const [post, setPost] = useState<SharedPost | null | undefined>(
    cache.has(postId) ? cache.get(postId) : undefined,
  );
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [liked, setLiked] = useState(false);
  const heartScale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    let cancelled = false;
    if (cache.has(postId)) { setPost(cache.get(postId)); return; }
    (async () => {
      const { data } = await supabase
        .from('posts')
        .select('id, type, media_url, caption, cover_url, thumbnail_url, user_id, profiles!posts_user_id_fkey(username, display_name, avatar_url, badge_tier, badge_show, profile_theme)')
        .eq('id', postId)
        .single();
      const value = (data as any) ?? null;
      cache.set(postId, value);
      if (!cancelled) setPost(value);
    })();
    return () => { cancelled = true; };
  }, [postId]);

  // Resolve the viewer + whether they've already liked this post (so the heart
  // reflects state on open and toggles correctly).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || cancelled) return;
      setCurrentUserId(user.id);
      const { data } = await supabase.from('likes')
        .select('post_id').eq('post_id', postId).eq('user_id', user.id).maybeSingle();
      if (!cancelled) setLiked(!!data);
    })();
    return () => { cancelled = true; };
  }, [postId]);

  // Like / unlike the post straight from the chat thread (optimistic).
  async function toggleLike() {
    if (!currentUserId || !post) return;
    const next = !liked;
    setLiked(next);
    // Pop the heart — a quick punch-up that springs back to rest.
    heartScale.setValue(next ? 0.7 : 0.85);
    Animated.spring(heartScale, { toValue: 1, friction: 3, tension: 160, useNativeDriver: true }).start();
    if (next) {
      await supabase.from('likes').insert({ user_id: currentUserId, post_id: post.id });
      bumpBadge('likes');
      if (post.user_id !== currentUserId) {
        createNotification({ userId: post.user_id, actorId: currentUserId, type: 'like', postId: post.id });
      }
    } else {
      await supabase.from('likes').delete().eq('user_id', currentUserId).eq('post_id', post.id);
    }
  }

  if (post === undefined) {
    return <View style={[styles.card, styles.stateCard]}><ActivityIndicator color={colors.primary} /></View>;
  }
  if (post === null) {
    return (
      <View style={[styles.card, styles.stateCard]}>
        <Ionicons name="alert-circle-outline" size={22} color={colors.textTertiary} />
        <Text style={styles.unavailable}>Post unavailable</Text>
      </View>
    );
  }

  const cover = post.cover_url ?? post.thumbnail_url ?? (post.type === 'image' ? post.media_url : null);
  const playable = post.type === 'video' || isAudioPost(post.type);

  return (
    <TouchableOpacity style={styles.cardShadow} activeOpacity={0.9} onPress={() => router.push(`/post/${post.id}` as any)}>
      <View style={styles.card}>
        <View style={styles.media}>
          {post.type === 'video' ? (
            <VideoThumb thumbnailUrl={cover} mediaUrl={post.media_url} style={styles.mediaInner} />
          ) : cover ? (
            <Image source={{ uri: cover }} style={styles.mediaInner} contentFit="cover" transition={0} cachePolicy="memory-disk" />
          ) : (
            <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.mediaInner} />
          )}
          {(playable || post.type === 'slideshow') && (
            <View style={styles.playBadge}>
              <Ionicons name={post.type === 'slideshow' ? 'copy' : isAudioPost(post.type) ? 'musical-notes' : 'play'} size={18} color="#fff" />
            </View>
          )}
        </View>

        <View style={styles.body}>
          <View style={styles.bodyText}>
            <View style={styles.authorRow}>
              {post.profiles?.avatar_url ? (
                <Image source={{ uri: post.profiles.avatar_url }} style={styles.authorAvatar} contentFit="cover" transition={0} cachePolicy="memory-disk" />
              ) : (
                <LinearGradient colors={GRADIENTS.primary} style={styles.authorAvatar} />
              )}
              <Text style={styles.authorName} numberOfLines={1}>@{post.profiles?.username ?? 'laybell'}</Text>
              <BadgeEmblem profile={post.profiles} ownerId={post.user_id} size={12} />
            </View>
            {!!post.caption && <Text style={styles.caption} numberOfLines={2}>{post.caption}</Text>}
          </View>

          {/* Like the post directly from the thread — centered on the caption bar. */}
          <TouchableOpacity style={styles.likeBtn} activeOpacity={0.8} hitSlop={8} onPress={toggleLike}>
            <Animated.View style={{ transform: [{ scale: heartScale }] }}>
              <Ionicons name={liked ? 'heart' : 'heart-outline'} size={20} color={liked ? colors.like : colors.textSecondary} />
            </Animated.View>
          </TouchableOpacity>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const CARD_W = 232;

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  // Outer wrapper carries the drop shadow (can't combine with overflow:hidden).
  cardShadow: {
    width: CARD_W,
    borderRadius: RADIUS.lg,
    shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  card: {
    width: CARD_W,
    borderRadius: RADIUS.lg,
    overflow: 'hidden',
    backgroundColor: colors.surfaceElevated,
    borderWidth: 1,
    borderColor: colors.border,
  },
  stateCard: { height: 96, alignItems: 'center', justifyContent: 'center', gap: SPACING.xs },
  unavailable: { color: colors.textTertiary, fontSize: 13 },

  media: { width: '100%', height: 154, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceLight },
  mediaInner: { ...StyleSheet.absoluteFillObject, width: undefined, height: undefined },
  playBadge: {
    width: 46, height: 46, borderRadius: 23,
    backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.85)',
  },

  body: { flexDirection: 'row', alignItems: 'center', padding: SPACING.sm + 2, gap: SPACING.sm },
  bodyText: { flex: 1, gap: 4 },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  authorAvatar: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.surfaceLight },
  authorName: { flexShrink: 1, color: colors.text, fontSize: 12.5, fontWeight: '700' },
  caption: { color: colors.textSecondary, fontSize: 13, lineHeight: 18 },

  likeBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: colors.surfaceLight,
    borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
});
