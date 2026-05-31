import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { useEffect, useState, useRef } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { timeAgo } from '../../lib/timeAgo';
import { COLORS, SPACING, RADIUS } from '../../constants/theme';

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

export default function CommentsScreen() {
  const { id } = useLocalSearchParams();
  const router = useRouter();
  const flatListRef = useRef<FlatList>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentUserProfile, setCurrentUserProfile] = useState<any>(null);
  const [postOwnerId, setPostOwnerId] = useState<string | null>(null);

  useEffect(() => {
    setup();
  }, [id]);

  useEffect(() => {
    const channel = supabase
      .channel(`comments-${id}`)
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

      const { data: postData } = await supabase
        .from('posts')
        .select('user_id')
        .eq('id', id)
        .single();
      if (postData) setPostOwnerId(postData.user_id);
    }
    await fetchComments();
    setLoading(false);
  }

  async function fetchComments() {
    const { data } = await supabase
      .from('comments')
      .select(`
        *,
        profiles!comments_user_id_fkey (username, display_name)
      `)
      .eq('post_id', id)
      .order('created_at', { ascending: true });

    if (data) setComments(data as any);
  }

  async function handleSendComment() {
    if (!newComment.trim() || !currentUserId || sending) return;
    setSending(true);

    const commentBody = newComment.trim();
    setNewComment('');

    const { data, error } = await supabase
      .from('comments')
      .insert({
        user_id: currentUserId,
        post_id: id,
        body: commentBody,
      })
      .select()
      .single();

    if (!error && data) {
      setComments(prev => [...prev, { ...data, profiles: currentUserProfile }]);
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
      if (postOwnerId && postOwnerId !== currentUserId) {
        await supabase.from('notifications').insert({
          user_id: postOwnerId,
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
  }

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color={COLORS.primary} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.backBtn}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Comments</Text>
        <Text style={styles.commentCount}>{comments.length}</Text>
      </View>

      {/* Comments List */}
      <FlatList
        ref={flatListRef}
        data={comments}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyIcon}>💬</Text>
            <Text style={styles.emptyTitle}>No comments yet</Text>
            <Text style={styles.emptySubtitle}>Be the first to comment!</Text>
          </View>
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
              <View style={styles.commentHeader}>
                <Text style={styles.commentUsername}>
                  {item.profiles?.display_name}
                </Text>
                <Text style={styles.commentTime}>
                  {timeAgo(item.created_at)}
                </Text>
              </View>
              <Text style={styles.commentBody}>{item.body}</Text>
            </View>
          </TouchableOpacity>
        )}
      />

      {/* Input */}
      <View style={styles.inputContainer}>
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
          onPress={handleSendComment}
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
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.xxl + SPACING.sm,
    paddingBottom: SPACING.md,
    borderBottomWidth: 0.5,
    borderBottomColor: COLORS.border,
  },
  backBtn: {
    color: COLORS.primary,
    fontSize: 28,
    fontWeight: '600',
  },
  headerTitle: {
    color: COLORS.text,
    fontSize: 17,
    fontWeight: '700',
  },
  commentCount: {
    color: COLORS.textSecondary,
    fontSize: 15,
    width: 30,
    textAlign: 'right',
  },
  listContent: {
    padding: SPACING.md,
    gap: SPACING.md,
    flexGrow: 1,
  },
  commentRow: {
    flexDirection: 'row',
    gap: SPACING.sm,
  },
  commentAvatar: {
    width: 36,
    height: 36,
    borderRadius: RADIUS.full,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  commentAvatarText: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: 'bold',
  },
  commentContent: {
    flex: 1,
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md,
    padding: SPACING.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  commentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  commentUsername: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '700',
  },
  commentTime: {
    color: COLORS.textTertiary,
    fontSize: 11,
  },
  commentBody: {
    color: COLORS.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: SPACING.xxl,
    gap: SPACING.sm,
  },
  emptyIcon: {
    fontSize: 40,
  },
  emptyTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: 'bold',
  },
  emptySubtitle: {
    color: COLORS.textSecondary,
    fontSize: 14,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: SPACING.md,
    borderTopWidth: 0.5,
    borderTopColor: COLORS.border,
    gap: SPACING.sm,
  },
  inputAvatar: {
    width: 32,
    height: 32,
    borderRadius: RADIUS.full,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inputAvatarText: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: 'bold',
  },
  input: {
    flex: 1,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.lg,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    color: COLORS.text,
    fontSize: 15,
    maxHeight: 100,
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: RADIUS.full,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: {
    opacity: 0.4,
  },
  sendBtnText: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: 'bold',
  },
});