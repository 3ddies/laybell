import { Video, ResizeMode } from 'expo-av';
import {
  View, Text, StyleSheet, TouchableOpacity,
  Image, TextInput, KeyboardAvoidingView,
  Platform, ActivityIndicator, FlatList,
} from 'react-native';
import { useEffect, useState, useRef } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { COLORS, SPACING, RADIUS, GRADIENTS, SHADOWS } from '../../constants/theme';
import { useAudio } from '../../contexts/AudioContext';
import { timeAgo } from '../../lib/timeAgo';
import { createNotification } from '../../lib/createNotification';
import { aspectToNumber } from '../../lib/aspectRatio';
import { Share } from 'react-native';

type Post = {
  id: string; type: string; media_url: string; caption: string;
  created_at: string; user_id: string;
  aspect_ratio?: string | null;
  stream_count?: number;
  cover_url?: string | null;
  profiles: { username: string; display_name: string; avatar_url: string | null };
};
type Comment = {
  id: string; body: string; created_at: string; user_id: string;
  profiles: { username: string; display_name: string };
};

export default function PostDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { currentTrack, isPlaying, play, stop } = useAudio();
  const flatListRef = useRef<any>(null);

  const [post, setPost] = useState<Post | null>(null);
  const [likeCount, setLikeCount] = useState(0);
  const [commentCount, setCommentCount] = useState(0);
  const [isLiked, setIsLiked] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [saveCount, setSaveCount] = useState(0);
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentUserProfile, setCurrentUserProfile] = useState<any>(null);

  const audioPlaying = currentTrack?.id === id && isPlaying;

  useEffect(() => { setup(); }, [id]);

  useEffect(() => {
    const channel = supabase
      .channel(`post-comments-${id}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'comments', filter: `post_id=eq.${id}` },
        async (payload) => {
          const incoming = payload.new as any;
          if (incoming.user_id === currentUserId) return;
          const { data: profile } = await supabase.from('profiles').select('username, display_name').eq('id', incoming.user_id).single();
          setComments(prev => [...prev, { ...incoming, profiles: profile }]);
          setCommentCount(prev => prev + 1);
          setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
        }
      ).subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [id, currentUserId]);

  async function setup() {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      setCurrentUserId(user.id);
      const { data: profile } = await supabase.from('profiles').select('username, display_name').eq('id', user.id).single();
      if (profile) setCurrentUserProfile(profile);
    }

    const [postRes, likesRes, commentsRes] = await Promise.all([
      supabase.from('posts').select('*, profiles!posts_user_id_fkey(username, display_name, avatar_url)').eq('id', id).single(),
      supabase.from('likes').select('user_id').eq('post_id', id),
      supabase.from('comments').select('*, profiles!comments_user_id_fkey(username, display_name)').eq('post_id', id).order('created_at', { ascending: true }),
    ]);

    if (postRes.data) { setPost(postRes.data as any); setSaveCount((postRes.data as any).save_count || 0); }
    if (likesRes.data) {
      setLikeCount(likesRes.data.length);
      if (user) setIsLiked(likesRes.data.some(l => l.user_id === user.id));
    }
    if (commentsRes.data) { setComments(commentsRes.data as any); setCommentCount(commentsRes.data.length); }

    if (user) {
      const { data: saveData } = await supabase.from('saves').select('id').eq('user_id', user.id).eq('post_id', id).single();
      setIsSaved(!!saveData);
    }
    setLoading(false);
  }

  async function handleLike() {
    if (!currentUserId || !post) return;
    setIsLiked(prev => !prev);
    setLikeCount(prev => isLiked ? prev - 1 : prev + 1);
    if (isLiked) {
      await supabase.from('likes').delete().eq('user_id', currentUserId).eq('post_id', id);
    } else {
      await supabase.from('likes').insert({ user_id: currentUserId, post_id: id });
      if (post.user_id !== currentUserId) {
        createNotification({ userId: post.user_id, actorId: currentUserId, type: 'like', postId: id });
      }
    }
  }

  async function handleSave() {
    if (!currentUserId) return;
    setIsSaved(prev => !prev);
    setSaveCount(prev => isSaved ? Math.max(prev - 1, 0) : prev + 1);
    if (isSaved) {
      await supabase.from('saves').delete().eq('user_id', currentUserId).eq('post_id', id);
    } else {
      await supabase.from('saves').insert({ user_id: currentUserId, post_id: id });
    }
  }

  async function handleComment() {
    if (!newComment.trim() || !currentUserId || sending || !post) return;
    setSending(true);
    const body = newComment.trim();
    setNewComment('');
    const { data, error } = await supabase.from('comments').insert({ user_id: currentUserId, post_id: id, body }).select().single();
    if (!error && data) {
      setComments(prev => [...prev, { ...data, profiles: currentUserProfile }]);
      setCommentCount(prev => prev + 1);
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
      if (post.user_id !== currentUserId) {
        createNotification({ userId: post.user_id, actorId: currentUserId, type: 'comment', postId: id });
      }
    }
    setSending(false);
  }

  async function handleDeleteComment(commentId: string, commentUserId: string) {
    if (commentUserId !== currentUserId) return;
    await supabase.from('comments').delete().eq('id', commentId);
    setComments(prev => prev.filter(c => c.id !== commentId));
    setCommentCount(prev => prev - 1);
  }

  if (loading) {
    return <View style={styles.loadingContainer}><ActivityIndicator color={COLORS.primary} size="large" /></View>;
  }
  if (!post) {
    return <View style={styles.loadingContainer}><Text style={{ color: COLORS.textSecondary }}>Post not found</Text></View>;
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={COLORS.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Post</Text>
        <View style={{ width: 40 }} />
      </View>

      <FlatList
        ref={flatListRef}
        data={comments}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <>
            {/* Author */}
            <TouchableOpacity style={styles.postHeader} onPress={() => router.push(`/profile/${post.user_id}`)}>
              {post.profiles?.avatar_url ? (
                <Image source={{ uri: post.profiles.avatar_url }} style={styles.avatar} />
              ) : (
                <LinearGradient colors={GRADIENTS.primary} style={styles.avatar}>
                  <Text style={styles.avatarText}>{post.profiles?.display_name?.charAt(0).toUpperCase()}</Text>
                </LinearGradient>
              )}
              <View style={styles.postHeaderInfo}>
                <Text style={styles.displayName}>{post.profiles?.display_name}</Text>
                <Text style={styles.username}>@{post.profiles?.username} · {timeAgo(post.created_at)}</Text>
              </View>
              <View style={styles.typeTag}>
                <Ionicons
                  name={post.type === 'audio' ? 'musical-notes' : post.type === 'video' ? 'videocam' : 'image-outline'}
                  size={14} color={COLORS.primary}
                />
              </View>
            </TouchableOpacity>

            {/* Media */}
            {post.type === 'image' && post.media_url && (
              <Image source={{ uri: post.media_url }} style={[styles.media, { aspectRatio: aspectToNumber(post.aspect_ratio, 1), height: undefined }]} resizeMode="cover" />
            )}
            {post.type === 'video' && post.media_url && (
              <Video source={{ uri: post.media_url }} style={[styles.media, { aspectRatio: aspectToNumber(post.aspect_ratio, 16 / 9), height: undefined }]} useNativeControls resizeMode={ResizeMode.CONTAIN} isLooping shouldPlay />
            )}
            {post.type === 'audio' && (
              <TouchableOpacity
                style={styles.audioWrap}
                onPress={() => audioPlaying ? stop() : play({ id: post.id, uri: post.media_url, caption: post.caption, artist: post.profiles?.display_name, cover: post.cover_url })}
              >
                <LinearGradient colors={audioPlaying ? ['#E8401C', '#C03010'] : ['#1C0E06', '#120A04']} style={styles.audioCard}>
                  {post.cover_url ? (
                    <View style={styles.audioCover}>
                      <Image source={{ uri: post.cover_url }} style={styles.audioCoverImg} />
                      <View style={[styles.audioCoverOverlay, audioPlaying && styles.audioRingActive]}>
                        <Ionicons name={audioPlaying ? 'stop' : 'play'} size={22} color={COLORS.text} />
                      </View>
                    </View>
                  ) : (
                    <View style={[styles.audioRing, audioPlaying && styles.audioRingActive]}>
                      <Ionicons name={audioPlaying ? 'stop' : 'play'} size={24} color={COLORS.text} />
                    </View>
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={styles.audioTitle} numberOfLines={1}>{post.caption || 'Audio Track'}</Text>
                    <Text style={styles.audioArtist}>
                      @{post.profiles?.username} · {(post.stream_count || 0).toLocaleString()} {(post.stream_count === 1) ? 'play' : 'plays'}
                    </Text>
                  </View>
                  <Ionicons name="musical-notes" size={28} color={COLORS.primary + '44'} />
                </LinearGradient>
              </TouchableOpacity>
            )}

            {/* Caption */}
            {!!post.caption && post.type !== 'audio' && (
              <Text style={styles.caption}>{post.caption}</Text>
            )}

            {/* Actions */}
            <View style={styles.actions}>
              <TouchableOpacity style={styles.actionBtn} onPress={handleLike}>
                <Ionicons name={isLiked ? 'heart' : 'heart-outline'} size={24} color={isLiked ? COLORS.like : COLORS.textSecondary} />
                {likeCount > 0 && <Text style={[styles.actionCount, isLiked && { color: COLORS.primaryLight }]}>{likeCount}</Text>}
              </TouchableOpacity>
              <View style={styles.actionBtn}>
                <Ionicons name="chatbubble-outline" size={22} color={COLORS.textSecondary} />
                {commentCount > 0 && <Text style={styles.actionCount}>{commentCount}</Text>}
              </View>
              <TouchableOpacity style={styles.actionBtn} onPress={handleSave}>
                <Ionicons name={isSaved ? 'bookmark' : 'bookmark-outline'} size={22} color={isSaved ? COLORS.primary : COLORS.textSecondary} />
                {saveCount > 0 && <Text style={[styles.actionCount, isSaved && { color: COLORS.primary }]}>{saveCount}</Text>}
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actionBtn, { marginLeft: 'auto' }]}
                onPress={async () => {
                  const link = `laybell://post/${id}`;
                  const text = post.caption
                    ? `"${post.caption}" — @${post.profiles?.username} on Laybell`
                    : `Check out @${post.profiles?.username} on Laybell`;
                  try { await Share.share({ message: `${text}\n${link}`, url: link }); } catch {}
                }}
              >
                <Ionicons name="share-social-outline" size={22} color={COLORS.textSecondary} />
              </TouchableOpacity>
            </View>

            <View style={styles.divider} />
            <Text style={styles.commentsLabel}>Comments · {commentCount}</Text>
          </>
        }
        ListEmptyComponent={
          <Text style={styles.emptyComments}>No comments yet — be the first!</Text>
        }
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.commentRow} onLongPress={() => handleDeleteComment(item.id, item.user_id)}>
            <LinearGradient colors={GRADIENTS.primary} style={styles.commentAvatar}>
              <Text style={styles.commentAvatarText}>{item.profiles?.display_name?.charAt(0).toUpperCase()}</Text>
            </LinearGradient>
            <View style={styles.commentContent}>
              <View style={styles.commentHead}>
                <Text style={styles.commentName}>{item.profiles?.display_name}</Text>
                <Text style={styles.commentTime}>{timeAgo(item.created_at)}</Text>
              </View>
              <Text style={styles.commentBody}>{item.body}</Text>
            </View>
          </TouchableOpacity>
        )}
      />

      <View style={styles.inputBar}>
        <LinearGradient colors={GRADIENTS.primary} style={styles.inputAvatar}>
          <Text style={styles.inputAvatarText}>{currentUserProfile?.display_name?.charAt(0).toUpperCase()}</Text>
        </LinearGradient>
        <TextInput
          style={styles.input}
          placeholder="Add a comment..."
          placeholderTextColor={COLORS.textTertiary}
          value={newComment}
          onChangeText={setNewComment}
          multiline
          maxLength={300}
        />
        <TouchableOpacity
          style={[styles.sendBtn, !newComment.trim() && styles.sendBtnDisabled]}
          onPress={handleComment}
          disabled={!newComment.trim() || sending}
        >
          {sending ? <ActivityIndicator color={COLORS.text} size="small" /> : <Ionicons name="arrow-up" size={18} color={COLORS.text} />}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  loadingContainer: { flex: 1, backgroundColor: COLORS.background, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: COLORS.border,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: COLORS.text, fontSize: 17, fontWeight: '700' },
  listContent: { paddingBottom: SPACING.xxl },
  postHeader: { flexDirection: 'row', alignItems: 'center', padding: SPACING.md, gap: SPACING.sm },
  avatar: { width: 40, height: 40, borderRadius: RADIUS.full, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: COLORS.text, fontSize: 16, fontWeight: '700' },
  postHeaderInfo: { flex: 1 },
  displayName: { color: COLORS.text, fontSize: 14, fontWeight: '700' },
  username: { color: COLORS.textTertiary, fontSize: 12, marginTop: 1 },
  typeTag: { width: 28, height: 28, borderRadius: RADIUS.full, backgroundColor: COLORS.primary + '18', alignItems: 'center', justifyContent: 'center' },
  media: { width: '100%', height: 340, backgroundColor: COLORS.surfaceLight },
  audioWrap: { marginHorizontal: SPACING.md, marginVertical: SPACING.sm, borderRadius: RADIUS.md, overflow: 'hidden' },
  audioCard: { flexDirection: 'row', alignItems: 'center', padding: SPACING.md, gap: SPACING.md, borderRadius: RADIUS.md },
  audioRing: { width: 48, height: 48, borderRadius: RADIUS.full, backgroundColor: COLORS.primary + '44', alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: COLORS.primary + '88' },
  audioCover: { width: 52, height: 52, borderRadius: RADIUS.sm, overflow: 'hidden' },
  audioCoverImg: { width: 52, height: 52 },
  audioCoverOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.35)' },
  audioRingActive: { backgroundColor: COLORS.primaryDark, borderColor: COLORS.primaryLight, ...SHADOWS.glow },
  audioTitle: { color: COLORS.text, fontSize: 14, fontWeight: '600' },
  audioArtist: { color: COLORS.textSecondary, fontSize: 12, marginTop: 2 },
  caption: { color: COLORS.text, fontSize: 15, lineHeight: 22, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm },
  actions: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, gap: SPACING.lg },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  actionCount: { color: COLORS.textSecondary, fontSize: 14, fontWeight: '500' },
  divider: { height: 0.5, backgroundColor: COLORS.border, marginHorizontal: SPACING.md, marginTop: SPACING.sm },
  commentsLabel: { color: COLORS.textSecondary, fontSize: 12, fontWeight: '700', paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, textTransform: 'uppercase', letterSpacing: 0.5 },
  emptyComments: { color: COLORS.textTertiary, fontSize: 14, textAlign: 'center', paddingVertical: SPACING.xl },
  commentRow: { flexDirection: 'row', gap: SPACING.sm, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm },
  commentAvatar: { width: 32, height: 32, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  commentAvatarText: { color: COLORS.text, fontSize: 12, fontWeight: '700' },
  commentContent: { flex: 1, backgroundColor: COLORS.surfaceLight, borderRadius: RADIUS.md, padding: SPACING.sm, borderWidth: 1, borderColor: COLORS.border },
  commentHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 },
  commentName: { color: COLORS.text, fontSize: 13, fontWeight: '700' },
  commentTime: { color: COLORS.textTertiary, fontSize: 11 },
  commentBody: { color: COLORS.textSecondary, fontSize: 14, lineHeight: 20 },
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', padding: SPACING.md, borderTopWidth: 0.5, borderTopColor: COLORS.border, gap: SPACING.sm },
  inputAvatar: { width: 30, height: 30, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  inputAvatarText: { color: COLORS.text, fontSize: 12, fontWeight: '700' },
  input: { flex: 1, backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: COLORS.border, borderRadius: RADIUS.lg, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, color: COLORS.text, fontSize: 15, maxHeight: 100 },
  sendBtn: { width: 36, height: 36, borderRadius: RADIUS.full, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { opacity: 0.35 },
});
