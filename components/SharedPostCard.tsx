import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { supabase } from '../lib/supabase';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../constants/theme';
import { isAudioPost } from '../lib/genres';
import VideoThumb from './VideoThumb';

type SharedPost = {
  id: string;
  type: string;
  media_url: string;
  caption: string | null;
  cover_url: string | null;
  thumbnail_url: string | null;
  profiles?: { username: string; display_name: string; avatar_url: string | null } | null;
};

// Module-level cache keyed by post id. The chat re-renders constantly while
// audio plays; caching means the card never refetches or flickers.
const cache = new Map<string, SharedPost | null>();

// Instagram-style "shell" of a shared post, rendered inside a chat bubble.
// Tapping it opens the full post.
export default function SharedPostCard({ postId }: { postId: string }) {
  const router = useRouter();
  const [post, setPost] = useState<SharedPost | null | undefined>(
    cache.has(postId) ? cache.get(postId) : undefined,
  );

  useEffect(() => {
    let cancelled = false;
    if (cache.has(postId)) { setPost(cache.get(postId)); return; }
    (async () => {
      const { data } = await supabase
        .from('posts')
        .select('id, type, media_url, caption, cover_url, thumbnail_url, profiles!posts_user_id_fkey(username, display_name, avatar_url)')
        .eq('id', postId)
        .single();
      const value = (data as any) ?? null;
      cache.set(postId, value);
      if (!cancelled) setPost(value);
    })();
    return () => { cancelled = true; };
  }, [postId]);

  if (post === undefined) {
    return <View style={[styles.card, styles.stateCard]}><ActivityIndicator color={COLORS.primary} /></View>;
  }
  if (post === null) {
    return (
      <View style={[styles.card, styles.stateCard]}>
        <Ionicons name="alert-circle-outline" size={22} color={COLORS.textTertiary} />
        <Text style={styles.unavailable}>Post unavailable</Text>
      </View>
    );
  }

  const cover = post.cover_url ?? post.thumbnail_url ?? (post.type === 'image' ? post.media_url : null);
  const playable = post.type === 'video' || isAudioPost(post.type);

  return (
    <TouchableOpacity style={styles.card} activeOpacity={0.85} onPress={() => router.push(`/post/${post.id}` as any)}>
      <View style={styles.media}>
        {post.type === 'video' ? (
          <VideoThumb thumbnailUrl={cover} mediaUrl={post.media_url} style={styles.mediaInner} />
        ) : cover ? (
          <Image source={{ uri: cover }} style={styles.mediaInner} contentFit="cover" transition={0} cachePolicy="memory-disk" />
        ) : (
          <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.mediaInner} />
        )}
        {playable && (
          <View style={styles.playBadge}>
            <Ionicons name={isAudioPost(post.type) ? 'musical-notes' : 'play'} size={16} color="#fff" />
          </View>
        )}
      </View>

      <View style={styles.body}>
        <View style={styles.authorRow}>
          {post.profiles?.avatar_url ? (
            <Image source={{ uri: post.profiles.avatar_url }} style={styles.authorAvatar} contentFit="cover" transition={0} cachePolicy="memory-disk" />
          ) : (
            <LinearGradient colors={GRADIENTS.primary} style={styles.authorAvatar} />
          )}
          <Text style={styles.authorName} numberOfLines={1}>@{post.profiles?.username ?? 'laybell'}</Text>
        </View>
        {!!post.caption && <Text style={styles.caption} numberOfLines={2}>{post.caption}</Text>}
        <Text style={styles.cta}>View post</Text>
      </View>
    </TouchableOpacity>
  );
}

const CARD_W = 232;

const styles = StyleSheet.create({
  card: {
    width: CARD_W,
    borderRadius: RADIUS.md,
    overflow: 'hidden',
    backgroundColor: COLORS.surfaceElevated,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  stateCard: { height: 96, alignItems: 'center', justifyContent: 'center', gap: SPACING.xs },
  unavailable: { color: COLORS.textTertiary, fontSize: 13 },

  media: { width: '100%', height: 150, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.surfaceLight },
  mediaInner: { ...StyleSheet.absoluteFillObject, width: undefined, height: undefined },
  playBadge: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center',
  },

  body: { padding: SPACING.sm, gap: 4 },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  authorAvatar: { width: 20, height: 20, borderRadius: 10, backgroundColor: COLORS.surfaceLight },
  authorName: { flex: 1, color: COLORS.text, fontSize: 12, fontWeight: '700' },
  caption: { color: COLORS.textSecondary, fontSize: 13, lineHeight: 18 },
  cta: { color: COLORS.primary, fontSize: 12, fontWeight: '700', marginTop: 2 },
});
