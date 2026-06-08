import { Video, ResizeMode } from 'expo-av';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Dimensions, Image, ActivityIndicator,
} from 'react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { COLORS, SPACING, RADIUS } from '../../constants/theme';
import { createNotification } from '../../lib/createNotification';
import { usePostOptions } from '../../contexts/PostOptionsContext';
import { useShare } from '../../contexts/ShareContext';
import { formatCount } from '../../lib/format';
import { aspectToNumber } from '../../lib/aspectRatio';
import CommentsSheet from '../../components/CommentsSheet';
import ElasticSwipeView from '../../components/ElasticSwipeView';
import FollowButton from '../../components/FollowButton';
import { trackVideoProgress } from '../../lib/viewTracker';
import { timeAgo } from '../../lib/timeAgo';
import { useAudio } from '../../contexts/AudioContext';
import {
  buildAffinityProfile, loadSeenPostIds, recordSeenPostIds, scorePost, EMPTY_PROFILE,
} from '../../lib/feedScorer';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

export default function ReelScreen() {
  const { show: showOptions } = usePostOptions();
  const { share: openShare } = useShare();
  const { id, post: postParam } = useLocalSearchParams<{ id: string; post?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { stop } = useAudio();

  // Seed from the tapped video so it plays instantly (no loading spinner).
  const seed = useMemo(() => {
    try { return postParam ? JSON.parse(postParam) : null; } catch { return null; }
  }, [postParam]);

  const [posts, setPosts] = useState<any[]>(seed ? [seed] : []);
  const [loading, setLoading] = useState(!seed);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [liked, setLiked] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [visibleId, setVisibleId] = useState<string | null>(seed?.id ?? null);
  const [paused, setPaused] = useState(false);
  const [commentsFor, setCommentsFor] = useState<{ id: string; ownerId: string } | null>(null);
  const videoRefs = useRef<Record<string, any>>({});

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 80 }).current;
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: any[] }) => {
    if (viewableItems[0]?.item) { setVisibleId(viewableItems[0].item.id); setPaused(false); }
  }).current;

  useEffect(() => { stop(); setup(); }, [id]);

  async function setup() {
    const { data: { user } } = await supabase.auth.getUser();
    const uid = user?.id ?? null;
    setCurrentUserId(uid);

    const [seen, profile, followingRes] = await Promise.all([
      loadSeenPostIds(),
      uid ? buildAffinityProfile(uid) : Promise.resolve(EMPTY_PROFILE),
      uid ? supabase.from('follows').select('following_id').eq('follower_id', uid) : Promise.resolve({ data: [] as any }),
    ]);
    const followingSet = new Set<string>((followingRes.data ?? []).map((f: any) => f.following_id));

    const SELECT = '*, profiles!posts_user_id_fkey (username, display_name, avatar_url), likes(count), comments(count)';
    const { data } = await supabase
      .from('posts').select(SELECT)
      .eq('is_public', true).eq('type', 'video')
      .order('created_at', { ascending: false }).limit(40);

    const now = Date.now();
    let list = [...(data ?? [])]
      .map((p) => ({ p, s: scorePost(p, profile, followingSet, seen, now) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.p);

    // Put the tapped video first; fetch it if it wasn't in the recommended set.
    const idx = list.findIndex((p) => p.id === id);
    let start: any = null;
    if (idx >= 0) { start = list[idx]; list.splice(idx, 1); }
    else {
      const { data: one } = await supabase.from('posts').select(SELECT).eq('id', id).single();
      start = one;
    }
    const ordered = start ? [start, ...list] : list;
    setPosts(ordered);
    setVisibleId(ordered[0]?.id ?? null);

    if (uid) {
      const [{ data: l }, { data: s }] = await Promise.all([
        supabase.from('likes').select('post_id').eq('user_id', uid),
        supabase.from('saves').select('post_id').eq('user_id', uid),
      ]);
      setLiked(new Set((l ?? []).map((r: any) => r.post_id)));
      setSaved(new Set((s ?? []).map((r: any) => r.post_id)));
    }
    recordSeenPostIds(ordered.map((p) => p.id));
    setLoading(false);
  }

  async function toggleLike(item: any) {
    if (!currentUserId) return;
    const isLiked = liked.has(item.id);
    setLiked((prev) => { const n = new Set(prev); isLiked ? n.delete(item.id) : n.add(item.id); return n; });
    setPosts((prev) => prev.map((p) => p.id !== item.id ? p
      : { ...p, likes: [{ count: (p.likes?.[0]?.count || 0) + (isLiked ? -1 : 1) }] }));
    if (isLiked) {
      await supabase.from('likes').delete().eq('user_id', currentUserId).eq('post_id', item.id);
    } else {
      await supabase.from('likes').insert({ user_id: currentUserId, post_id: item.id });
      if (item.user_id !== currentUserId) createNotification({ userId: item.user_id, actorId: currentUserId, type: 'like', postId: item.id });
    }
  }

  async function toggleSave(item: any) {
    if (!currentUserId) return;
    const isSaved = saved.has(item.id);
    setSaved((prev) => { const n = new Set(prev); isSaved ? n.delete(item.id) : n.add(item.id); return n; });
    if (isSaved) await supabase.from('saves').delete().eq('user_id', currentUserId).eq('post_id', item.id);
    else await supabase.from('saves').insert({ user_id: currentUserId, post_id: item.id });
  }

  function share(item: any) {
    openShare({
      postId: item.id,
      caption: item.caption,
      username: item.profiles?.username,
      type: item.type ?? 'video',
      mediaUrl: item.media_url,
      cover: item.thumbnail_url ?? item.cover_url ?? null,
    });
  }

  function renderItem({ item }: { item: any }) {
    const isLiked = liked.has(item.id);
    const isSaved = saved.has(item.id);
    const likeCount = item.likes?.[0]?.count || 0;
    const commentCount = item.comments?.[0]?.count || 0;
    const saveCount = item.save_count || 0;
    const shareCount = item.share_count || 0;
    // Landscape/square videos show in full (letterboxed) so nothing is cut;
    // portrait videos fill the screen edge-to-edge.
    const landscape = aspectToNumber(item.aspect_ratio, 16 / 9) >= 1;

    return (
      <ElasticSwipeView style={{ width: SCREEN_W, height: SCREEN_H }}>
        <TouchableOpacity activeOpacity={1} style={StyleSheet.absoluteFill} onPress={() => setPaused((p) => !p)}>
          <Video
            ref={(r) => { videoRefs.current[item.id] = r; }}
            source={{ uri: item.media_url }}
            style={StyleSheet.absoluteFill}
            resizeMode={landscape ? ResizeMode.CONTAIN : ResizeMode.COVER}
            isLooping={item.trim_end == null}
            shouldPlay={visibleId === item.id && !paused}
            useNativeControls={false}
            onLoad={() => { if (item.trim_start != null) videoRefs.current[item.id]?.setPositionAsync(item.trim_start * 1000); }}
            onPlaybackStatusUpdate={(st: any) => {
              if (!st.isLoaded) return;
              trackVideoProgress(item.id, st.positionMillis ?? 0, st.durationMillis ?? 0);
              if (item.trim_end != null && st.positionMillis >= item.trim_end * 1000) {
                videoRefs.current[item.id]?.setPositionAsync((item.trim_start ?? 0) * 1000);
              }
            }}
          />
        </TouchableOpacity>

        {/* paused indicator */}
        {visibleId === item.id && paused && (
          <View style={styles.pausedWrap} pointerEvents="none">
            <Ionicons name="play" size={64} color="rgba(255,255,255,0.85)" />
          </View>
        )}

        {/* bottom gradient for legibility */}
        <LinearGradient colors={['transparent', 'rgba(0,0,0,0.7)']} style={styles.bottomFade} pointerEvents="none" />

        {/* Right action rail */}
        <View style={[styles.rail, { bottom: insets.bottom + 90 }]}>
          <TouchableOpacity style={styles.railBtn} onPress={() => toggleLike(item)}>
            <Ionicons name={isLiked ? 'heart' : 'heart-outline'} size={32} color={isLiked ? COLORS.like : '#fff'} />
            {likeCount > 0 && <Text style={styles.railText}>{formatCount(likeCount)}</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={styles.railBtn} onPress={() => setCommentsFor({ id: item.id, ownerId: item.user_id })}>
            <Ionicons name="chatbubble-outline" size={30} color="#fff" />
            {commentCount > 0 && <Text style={styles.railText}>{formatCount(commentCount)}</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={styles.railBtn} onPress={() => toggleSave(item)}>
            <Ionicons name={isSaved ? 'bookmark' : 'bookmark-outline'} size={28} color={isSaved ? COLORS.primary : '#fff'} />
            {saveCount > 0 && <Text style={styles.railText}>{formatCount(saveCount)}</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={styles.railBtn} onPress={() => share(item)}>
            <Ionicons name="share-social-outline" size={28} color="#fff" />
            {shareCount > 0 && <Text style={styles.railText}>{formatCount(shareCount)}</Text>}
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.railBtn}
            onPress={() => showOptions({
              postId: item.id,
              isOwn: item.user_id === currentUserId,
              onEdit: () => router.push(`/edit-post/${item.id}`),
              onDeleted: () => setPosts((prev) => prev.filter((p) => p.id !== item.id)),
            })}
          >
            <Ionicons name="ellipsis-horizontal" size={28} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* Author + caption */}
        <View style={[styles.meta, { bottom: insets.bottom + 24 }]}>
          <View style={styles.authorRow}>
            <TouchableOpacity style={styles.author} onPress={() => router.push(`/profile/${item.user_id}`)}>
              {item.profiles?.avatar_url ? (
                <Image source={{ uri: item.profiles.avatar_url }} style={styles.avatar} />
              ) : (
                <LinearGradient colors={['#E8401C', '#F26522']} style={styles.avatar}>
                  <Text style={styles.avatarText}>{item.profiles?.display_name?.charAt(0).toUpperCase()}</Text>
                </LinearGradient>
              )}
              <Text style={styles.authorName} numberOfLines={1}>@{item.profiles?.username}</Text>
              <Text style={styles.dot}>·</Text>
              <Text style={styles.time}>{timeAgo(item.created_at)}</Text>
            </TouchableOpacity>
            <FollowButton userId={item.user_id} />
          </View>
          {!!item.caption && <Text style={styles.caption} numberOfLines={2}>{item.caption}</Text>}
        </View>
      </ElasticSwipeView>
    );
  }

  return (
    <View style={styles.container}>
      {posts.length > 0 ? (
        <FlatList
          data={posts}
          keyExtractor={(p) => p.id}
          pagingEnabled
          showsVerticalScrollIndicator={false}
          snapToInterval={SCREEN_H}
          snapToAlignment="start"
          decelerationRate="fast"
          getItemLayout={(_, i) => ({ length: SCREEN_H, offset: SCREEN_H * i, index: i })}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          renderItem={renderItem}
          windowSize={3}
          maxToRenderPerBatch={2}
          initialNumToRender={1}
        />
      ) : loading ? (
        <View style={styles.center} />
      ) : (
        <View style={styles.center}><Text style={styles.empty}>No videos to show</Text></View>
      )}

      {/* Back button */}
      <TouchableOpacity style={[styles.back, { top: insets.top + 8 }]} onPress={() => router.back()}>
        <Ionicons name="chevron-back" size={28} color="#fff" />
      </TouchableOpacity>

      <CommentsSheet
        visible={!!commentsFor}
        postId={commentsFor?.id ?? ''}
        ownerId={commentsFor?.ownerId}
        onClose={() => setCommentsFor(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { color: COLORS.textSecondary, fontSize: 15 },

  back: { position: 'absolute', left: SPACING.sm, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },

  pausedWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  bottomFade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 220 },

  rail: { position: 'absolute', right: SPACING.sm, alignItems: 'center', gap: SPACING.lg },
  railBtn: { alignItems: 'center', gap: 3 },
  railText: { color: '#fff', fontSize: 12, fontWeight: '700' },

  meta: { position: 'absolute', left: SPACING.md, right: 80, gap: SPACING.xs },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  author: { flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  avatar: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  authorName: { flexShrink: 1, color: '#fff', fontSize: 15, fontWeight: '700' },
  dot: { color: 'rgba(255,255,255,0.7)', fontSize: 14 },
  time: { color: 'rgba(255,255,255,0.7)', fontSize: 12 },
  caption: { color: '#fff', fontSize: 14, lineHeight: 19 },
});
