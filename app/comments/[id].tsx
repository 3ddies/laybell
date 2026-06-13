import {
  View, Text, StyleSheet, FlatList, TextInput,
  TouchableOpacity, KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { useEffect, useState, useRef } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { bumpBadge } from '../../lib/badges';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { timeAgo } from '../../lib/timeAgo';
import { createNotification } from '../../lib/createNotification';

type Comment = {
  id: string; body: string; created_at: string; user_id: string;
  profiles: { username: string; display_name: string };
};

export default function CommentsScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const flatListRef = useRef<FlatList>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentUserProfile, setCurrentUserProfile] = useState<any>(null);
  const [postOwnerId, setPostOwnerId] = useState<string | null>(null);

  useEffect(() => { setup(); }, [id]);

  useEffect(() => {
    // Per-mount suffix: a repeated channel name returns the EXISTING (already
    // subscribed) instance and .on() then throws — fatal if this screen is
    // ever stacked twice for the same post.
    const channel = supabase
      .channel(`comments-${id}-${Date.now().toString(36)}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'comments', filter: `post_id=eq.${id}` },
        async (payload) => {
          const incoming = payload.new as any;
          if (incoming.user_id === currentUserId) return;
          const { data: profile } = await supabase.from('profiles').select('username, display_name').eq('id', incoming.user_id).single();
          setComments(prev => [...prev, { ...incoming, profiles: profile }]);
          setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
        }
      ).subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [id, currentUserId]);

  async function setup() {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      setCurrentUserId(user.id);
      const [profileRes, postRes] = await Promise.all([
        supabase.from('profiles').select('username, display_name').eq('id', user.id).single(),
        supabase.from('posts').select('user_id').eq('id', id).single(),
      ]);
      if (profileRes.data) setCurrentUserProfile(profileRes.data);
      if (postRes.data) setPostOwnerId(postRes.data.user_id);
    }
    await fetchComments();
    setLoading(false);
  }

  async function fetchComments() {
    const { data } = await supabase
      .from('comments')
      .select('*, profiles!comments_user_id_fkey(username, display_name)')
      .eq('post_id', id)
      .order('created_at', { ascending: true });
    if (data) setComments(data as any);
  }

  async function handleSendComment() {
    if (!newComment.trim() || !currentUserId || sending) return;
    setSending(true);
    const body = newComment.trim();
    setNewComment('');
    const { data, error } = await supabase.from('comments').insert({ user_id: currentUserId, post_id: id, body }).select().single();
    if (!error && data) {
      bumpBadge('comments');
      setComments(prev => [...prev, { ...data, profiles: currentUserProfile }]);
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
      if (postOwnerId && postOwnerId !== currentUserId) {
        createNotification({ userId: postOwnerId, actorId: currentUserId, type: 'comment', postId: id as string });
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
    return <View style={styles.loadingContainer}><ActivityIndicator color={colors.primary} size="large" /></View>;
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Comments</Text>
        <View style={styles.countBadge}>
          <Text style={styles.countText}>{comments.length}</Text>
        </View>
      </View>

      <FlatList
        ref={flatListRef}
        data={comments}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Ionicons name="chatbubbles-outline" size={44} color={colors.textTertiary} />
            <Text style={styles.emptyTitle}>No comments yet</Text>
            <Text style={styles.emptySubtitle}>Be the first to comment!</Text>
          </View>
        }
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.commentRow} onLongPress={() => handleDeleteComment(item.id, item.user_id)}>
            <LinearGradient colors={GRADIENTS.primary} style={styles.commentAvatar}>
              <Text style={styles.commentAvatarText}>{item.profiles?.display_name?.charAt(0).toUpperCase()}</Text>
            </LinearGradient>
            <View style={styles.commentContent}>
              <View style={styles.commentHeader}>
                <Text style={styles.commentUsername}>{item.profiles?.display_name}</Text>
                <Text style={styles.commentTime}>{timeAgo(item.created_at)}</Text>
              </View>
              <Text style={styles.commentBody}>{item.body}</Text>
            </View>
          </TouchableOpacity>
        )}
      />

      <View style={styles.inputContainer}>
        <LinearGradient colors={GRADIENTS.primary} style={styles.inputAvatar}>
          <Text style={styles.inputAvatarText}>{currentUserProfile?.display_name?.charAt(0).toUpperCase()}</Text>
        </LinearGradient>
        <TextInput
          style={styles.input}
          placeholder="Add a comment..."
          placeholderTextColor={colors.textTertiary}
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
          {sending ? <ActivityIndicator color={colors.text} size="small" /> : <Ionicons name="arrow-up" size={18} color={colors.text} />}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  loadingContainer: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { flex: 1, color: colors.text, fontSize: 17, fontWeight: '700', textAlign: 'center' },
  countBadge: { width: 32, height: 32, borderRadius: RADIUS.full, backgroundColor: colors.surfaceLight, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  countText: { color: colors.textSecondary, fontSize: 12, fontWeight: '700' },
  listContent: { padding: SPACING.md, gap: SPACING.md, flexGrow: 1 },
  commentRow: { flexDirection: 'row', gap: SPACING.sm },
  commentAvatar: { width: 36, height: 36, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  commentAvatarText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  commentContent: { flex: 1, backgroundColor: colors.surfaceLight, borderRadius: RADIUS.md, padding: SPACING.sm, borderWidth: 1, borderColor: colors.border },
  commentHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
  commentUsername: { color: colors.text, fontSize: 13, fontWeight: '700' },
  commentTime: { color: colors.textTertiary, fontSize: 11 },
  commentBody: { color: colors.textSecondary, fontSize: 14, lineHeight: 20 },
  emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: SPACING.xxl, gap: SPACING.md },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '700' },
  emptySubtitle: { color: colors.textSecondary, fontSize: 14 },
  inputContainer: { flexDirection: 'row', alignItems: 'flex-end', padding: SPACING.md, borderTopWidth: 0.5, borderTopColor: colors.border, gap: SPACING.sm },
  inputAvatar: { width: 32, height: 32, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  inputAvatarText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  input: { flex: 1, backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border, borderRadius: RADIUS.lg, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, color: colors.text, fontSize: 15, maxHeight: 100 },
  sendBtn: { width: 36, height: 36, borderRadius: RADIUS.full, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { opacity: 0.35 },
});
