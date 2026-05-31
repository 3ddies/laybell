import { Video, ResizeMode } from 'expo-av';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Image,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  FlatList,
} from 'react-native';
import { useEffect, useState, useRef } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { COLORS, SPACING, RADIUS } from '../../constants/theme';
import { useAudio } from '../../contexts/AudioContext';
import { timeAgo } from '../../lib/timeAgo';

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
};

type Comment = {
  id: string;
  body: string;
  created_at: string;
  user_id: string;
  profiles: {
    username: string;
    display_name: string;
  };
};

export default function PostDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { currentTrack, isPlaying, play, stop } = useAudio();

  const [post, setPost] = useState<Post | null>(null);
  const [likeCount, setLikeCount] = useState(0);
  const [commentCount, setCommentCount] = useState(0);
  const [isLiked, setIsLiked] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentUserProfile, setCurrentUserProfile] = useState<any>(null);

  const audioPlaying = currentTrack?.id === id && isPlaying;
  const flatListRef = useRef<any>(null);

  useEffect(() => {
    setup();
  }, [id]);

  useEffect(() => {
    const channel = supabase
      .channel(`post-comments-${id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'comments', filter: `post_id=eq.${id}` },
        async (payload) => {
          const incoming = payload.new as any;
          if (incoming.user_id === currentUserId) return;
          const { data: profile } = await supabase
            .from('profiles')
            .select('username, display_name')
            .eq('id', incoming.user_id)
            .single();
          setComments(prev => [...prev, { ...incoming, profiles: profile }]);
          setCommentCount(prev => prev + 1);
          setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [id, currentUserId]);

  async function setup() {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      setCurrentUserId(user.id);
      const { data: profile } = await supabase
        .from('profiles')
        .select('username, display_name')
        .eq('id', user.id)
        .single();
      if (profile) setCurrentUserProfile(profile);
    }

    const [postRes, likesRes, commentsRes] = await Promise.all([
      supabase.from('posts')
        .select('*, profiles!posts_user_id_fkey (username, display_name, avatar_url)')
        .eq('id', id)
        .single(),
      supabase.from('likes').select('user_id').eq('post_id', id),
      supabase.from('comments')
        .select('*, profiles!comments_user_id_fkey (username, display_name)')
        .eq('post_id', id)
        .order('created_at', { ascending: true }),
    ]);

    if (postRes.data) setPost(postRes.data as any);

    if (likesRes.data) {
      setLikeCount(likesRes.data.length);
      if (user) setIsLiked(likesRes.data.some(l => l.user_id === user.id));
    }

    if (commentsRes.data) {
      setComments(commentsRes.data as any);
      setCommentCount(commentsRes.data.length);
    }

    if (user) {
      const { data: saveData } = await supabase
        .from('saves')
        .select('id')
        .eq('user_id', user.id)
        .eq('post_id', id)
        .single();
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
        await supabase.from('notifications').insert({
          user_id: post.user_id,
          actor_id: currentUserId,
          type: 'like',
          post_id: id,
        }).then(({ error }) => { if (error) console.error('notification insert:', error.message); });
      }
    }
  }

  async function handleSave() {
    if (!currentUserId) return;
    setIsSaved(prev => !prev);
    if (isSaved) {
      await supabase.from('saves').delete().eq('user_id', currentUserId).eq('post_id', id);
    } else {
      await supabase.from('saves').insert({ user_id: currentUserId, post_id: id });
    }
  }

  async function handleAudio() {
    if (!post) return;
    if (audioPlaying) {
      await stop();
    } else {
      await play({
        id: post.id,
        uri: post.media_url,
        caption: post.caption,
        artist: post.profiles?.display_name,
      });
    }
  }

  async function handleComment() {
    if (!newComment.trim() || !currentUserId || sending || !post) return;
    setSending(true);
    const body = newComment.trim();
    setNewComment('');

    const { data, error } = await supabase
      .from('comments')
      .insert({ user_id: currentUserId, post_id: id, body })
      .select()
      .single();

    if (!error && data) {
      setComments(prev => [...prev, { ...data, profiles: currentUserProfile }]);
      setCommentCount(prev => prev + 1);
      if (post.user_id !== currentUserId) {
        await supabase.from('notifications').insert({
          user_id: post.user_id,
          actor_id: currentUserId,
          type: 'comment',
          post_id: id,
        }).then(({ error }) => { if (error) console.error('notification insert:', error.message); });
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
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color={COLORS.primary} size="large" />
      </View>
    );
  }

  if (!post) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={{ color: COLORS.textSecondary }}>Post not found</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.backBtn}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Post</Text>
        <View style={{ width: 28 }} />
      </View>

      <FlatList
        ref={flatListRef}
        data={comments}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <>
            {/* Post author */}
            <TouchableOpacity
              style={styles.postHeader}
              onPress={() => router.push(`/profile/${post.user_id}`)}
            >
              {post.profiles?.avatar_url ? (
                <Image source={{ uri: post.profiles.avatar_url }} style={styles.avatar} />
              ) : (
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>
                    {post.profiles?.display_name?.charAt(0).toUpperCase()}
                  </Text>
                </View>
              )}
              <View style={styles.postHeaderInfo}>
                <Text style={styles.displayName}>{post.profiles?.display_name}</Text>
                <Text style={styles.username}>
                  {'@'}{post.profiles?.username} · {timeAgo(post.created_at)}
                </Text>
              </View>
            </TouchableOpacity>

            {/* Media */}
            {post.type === 'image' && post.media_url && (
              <Image source={{ uri: post.media_url }} style={styles.media} resizeMode="cover" />
            )}

            {post.type === 'video' && post.media_url && (
              <Video
                source={{ uri: post.media_url }}
                style={styles.media}
                useNativeControls
                resizeMode={ResizeMode.CONTAIN}
                isLooping
                shouldPlay={false}
              />
            )}

            {post.type === 'audio' && (
              <TouchableOpacity style={styles.audioCard} onPress={handleAudio}>
                <Text style={styles.audioIcon}>🎵</Text>
                <Text style={styles.audioLabel}>Audio Track</Text>
                <View style={[styles.playBtn, audioPlaying && { backgroundColor: COLORS.error }]}>
                  <Text style={styles.playBtnText}>{audioPlaying ? '■ Stop' : '▶ Play'}</Text>
                </View>
              </TouchableOpacity>
            )}

            {/* Caption */}
            {!!post.caption && <Text style={styles.caption}>{post.caption}</Text>}

            {/* Actions */}
            <View style={styles.actions}>
              <TouchableOpacity style={styles.actionBtn} onPress={handleLike}>
                <Text style={styles.actionIcon}>{isLiked ? '❤️' : '🤍'}</Text>
                <Text style={[styles.actionCount, isLiked && { color: COLORS.error }]}>
                  {likeCount}
                </Text>
              </TouchableOpacity>
              <View style={styles.actionBtn}>
                <Text style={styles.actionIcon}>💬</Text>
                <Text style={styles.actionCount}>{commentCount}</Text>
              </View>
              {post.type === 'audio' && (
                <TouchableOpacity style={styles.actionBtn} onPress={handleSave}>
                  <Text style={styles.actionIcon}>{isSaved ? '🔖' : '🎵'}</Text>
                  <Text style={styles.actionCount}>Save</Text>
                </TouchableOpacity>
              )}
            </View>

            <View style={styles.divider} />
            <Text style={styles.commentsLabel}>Comments</Text>
          </>
        }
        ListEmptyComponent={
          <Text style={styles.emptyComments}>No comments yet — be the first!</Text>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.commentRow}
            onLongPress={() => handleDeleteComment(item.id, item.user_id)}
          >
            <View style={styles.commentAvatar}>
              <Text style={styles.commentAvatarText}>
                {item.profiles?.display_name?.charAt(0).toUpperCase()}
              </Text>
            </View>
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

      {/* Comment input */}
      <View style={styles.inputBar}>
        <View style={styles.inputAvatar}>
          <Text style={styles.inputAvatarText}>
            {currentUserProfile?.display_name?.charAt(0).toUpperCase()}
          </Text>
        </View>
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
          {sending ? (
            <ActivityIndicator color={COLORS.text} size="small" />
          ) : (
            <Text style={styles.sendBtnText}>↑</Text>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  loadingContainer: { flex: 1, backgroundColor: COLORS.background, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.xxl + SPACING.sm,
    paddingBottom: SPACING.md,
    borderBottomWidth: 0.5,
    borderBottomColor: COLORS.border,
  },
  backBtn: { color: COLORS.primary, fontSize: 28, fontWeight: '600' },
  headerTitle: { color: COLORS.text, fontSize: 17, fontWeight: '700' },
  listContent: { paddingBottom: SPACING.xxl },
  postHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: SPACING.md,
    gap: SPACING.sm,
  },
  avatar: {
    width: 40, height: 40, borderRadius: RADIUS.full,
    backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: COLORS.text, fontSize: 16, fontWeight: 'bold' },
  postHeaderInfo: { flex: 1 },
  displayName: { color: COLORS.text, fontSize: 14, fontWeight: '700' },
  username: { color: COLORS.textTertiary, fontSize: 12, marginTop: 1 },
  media: { width: '100%', height: 340, backgroundColor: COLORS.surface },
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
  audioIcon: { fontSize: 40 },
  audioLabel: { color: COLORS.textSecondary, fontSize: 14 },
  playBtn: {
    backgroundColor: COLORS.primary,
    borderRadius: RADIUS.full,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
  },
  playBtnText: { color: COLORS.text, fontSize: 14, fontWeight: '600' },
  caption: {
    color: COLORS.text, fontSize: 15, lineHeight: 22,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
  },
  actions: {
    flexDirection: 'row',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    gap: SPACING.lg,
  },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  actionIcon: { fontSize: 20 },
  actionCount: { color: COLORS.textSecondary, fontSize: 14 },
  divider: { height: 0.5, backgroundColor: COLORS.border, marginHorizontal: SPACING.md, marginTop: SPACING.sm },
  commentsLabel: {
    color: COLORS.textSecondary, fontSize: 13, fontWeight: '600',
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  emptyComments: {
    color: COLORS.textTertiary, fontSize: 14,
    textAlign: 'center', paddingVertical: SPACING.xl,
  },
  commentRow: {
    flexDirection: 'row',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  commentAvatar: {
    width: 32, height: 32, borderRadius: RADIUS.full,
    backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  commentAvatarText: { color: COLORS.text, fontSize: 12, fontWeight: 'bold' },
  commentContent: {
    flex: 1, backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md, padding: SPACING.sm,
    borderWidth: 1, borderColor: COLORS.border,
  },
  commentHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 },
  commentName: { color: COLORS.text, fontSize: 13, fontWeight: '700' },
  commentTime: { color: COLORS.textTertiary, fontSize: 11 },
  commentBody: { color: COLORS.textSecondary, fontSize: 14, lineHeight: 20 },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: SPACING.md,
    borderTopWidth: 0.5,
    borderTopColor: COLORS.border,
    gap: SPACING.sm,
  },
  inputAvatar: {
    width: 30, height: 30, borderRadius: RADIUS.full,
    backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center',
  },
  inputAvatarText: { color: COLORS.text, fontSize: 12, fontWeight: 'bold' },
  input: {
    flex: 1, backgroundColor: COLORS.surface,
    borderWidth: 1, borderColor: COLORS.border,
    borderRadius: RADIUS.lg,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
    color: COLORS.text, fontSize: 15, maxHeight: 100,
  },
  sendBtn: {
    width: 36, height: 36, borderRadius: RADIUS.full,
    backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center',
  },
  sendBtnDisabled: { opacity: 0.4 },
  sendBtnText: { color: COLORS.text, fontSize: 18, fontWeight: 'bold' },
});
