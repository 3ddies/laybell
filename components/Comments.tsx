import { View, Text, StyleSheet, TouchableOpacity, TextInput, FlatList, ActivityIndicator, RefreshControl } from 'react-native';
import { Fragment, useCallback, useEffect, useRef, useState, ReactElement } from 'react';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { supabase } from '../lib/supabase';
import { bumpBadge } from '../lib/badges';
import { useProfile } from '../contexts/ProfileContext';
import StoryAvatar from './StoryAvatar';
import BadgeEmblem from './BadgeEmblem';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../constants/theme';
import { timeAgo } from '../lib/timeAgo';
import { createNotification } from '../lib/createNotification';
import { processMentions, getActiveMentionQuery, applyMention } from '../lib/mentions';
import MentionSuggestions from './MentionSuggestions';
import MentionText from './MentionText';

type Row = {
  id: string; body: string; created_at: string; user_id: string;
  parent_id: string | null; profiles: any;
};

export default function Comments({
  postId, ownerId, ListHeaderComponent, style, contentPadding, onRefresh, onNavigate,
}: {
  postId: string;
  ownerId?: string | null;
  ListHeaderComponent?: ReactElement;
  style?: any;
  // Horizontal padding for the list content + input, applied without insetting the
  // list frame — so the scroll indicator stays at the screen's right edge even when
  // the caller would otherwise wrap this in a padded container.
  contentPadding?: number;
  // When provided, enables pull-to-refresh: pulling reloads comments AND calls
  // this handler (so the host screen can refresh its own header data too).
  onRefresh?: () => void | Promise<void>;
  // Called right before navigating away (tapping a commenter's avatar/name), so a
  // host overlay/sheet can close itself first to reveal the pushed profile screen.
  onNavigate?: () => void;
}) {
  const listRef = useRef<FlatList>(null);
  const router = useRouter();
  const { profile: myProfile } = useProfile();

  // Open a commenter's profile. Closes the host sheet/overlay first (if any).
  function goToProfile(uid?: string) {
    if (!uid) return;
    onNavigate?.();
    router.push(`/profile/${uid}` as any);
  }
  const [userId, setUserId] = useState<string | null>(null);
  const [userProfile, setUserProfile] = useState<any>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [likes, setLikes] = useState<Record<string, number>>({});
  const [likedByMe, setLikedByMe] = useState<Set<string>>(new Set());
  const [replyTo, setReplyTo] = useState<{ id: string; name: string } | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    setUserId(user?.id ?? null);
    if (user) supabase.from('profiles').select('username, display_name, avatar_url, badge_tier, badge_show').eq('id', user.id).single()
      .then(({ data }) => setUserProfile(data));

    const { data: comments } = await supabase
      .from('comments')
      .select('id, body, created_at, user_id, parent_id, profiles!comments_user_id_fkey(username, display_name, avatar_url, badge_tier, badge_show)')
      .eq('post_id', postId)
      .order('created_at', { ascending: true });
    if (!comments) return;
    setRows(comments as any);

    const ids = comments.map((c: any) => c.id);
    if (ids.length) {
      const { data: cl } = await supabase.from('comment_likes').select('comment_id, user_id').in('comment_id', ids);
      const counts: Record<string, number> = {};
      const mine = new Set<string>();
      (cl ?? []).forEach((l: any) => {
        counts[l.comment_id] = (counts[l.comment_id] || 0) + 1;
        if (user && l.user_id === user.id) mine.add(l.comment_id);
      });
      setLikes(counts);
      setLikedByMe(mine);
    } else {
      setLikes({});
      setLikedByMe(new Set());
    }
  }, [postId]);

  useEffect(() => { load(); }, [load]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([load(), onRefresh?.()]);
    setRefreshing(false);
  }, [load, onRefresh]);

  const topLevel = rows.filter(r => !r.parent_id);
  const repliesOf = (id: string) => rows.filter(r => r.parent_id === id);

  async function toggleLike(commentId: string) {
    if (!userId) return;
    const liked = likedByMe.has(commentId);
    // Optimistic toggle.
    setLikedByMe(prev => { const n = new Set(prev); liked ? n.delete(commentId) : n.add(commentId); return n; });
    setLikes(prev => ({ ...prev, [commentId]: Math.max(0, (prev[commentId] || 0) + (liked ? -1 : 1)) }));
    const { error } = liked
      ? await supabase.from('comment_likes').delete().eq('comment_id', commentId).eq('user_id', userId)
      : await supabase.from('comment_likes').insert({ comment_id: commentId, user_id: userId });
    if (error) {
      // Revert on failure (e.g. the comment_likes migration hasn't been applied).
      setLikedByMe(prev => { const n = new Set(prev); liked ? n.add(commentId) : n.delete(commentId); return n; });
      setLikes(prev => ({ ...prev, [commentId]: Math.max(0, (prev[commentId] || 0) + (liked ? 1 : -1)) }));
    }
  }

  async function submit() {
    if (!text.trim() || !userId || sending) return;
    setSending(true);
    const body = text.trim();
    const parent_id = replyTo?.id ?? null;
    setText('');
    setReplyTo(null);
    const { data, error } = await supabase
      .from('comments').insert({ user_id: userId, post_id: postId, body, parent_id }).select().single();
    if (!error && data) {
      bumpBadge('comments');
      setRows(prev => [...prev, { ...(data as any), profiles: myProfile ?? userProfile }]);
      if (!parent_id) setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
      if (ownerId && ownerId !== userId) createNotification({ userId: ownerId, actorId: userId, type: 'comment', postId });
      processMentions({ text: body, actorId: userId, postId, commentId: (data as any).id });
    }
    setSending(false);
  }

  async function remove(id: string, authorId: string) {
    if (authorId !== userId) return;
    await supabase.from('comments').delete().eq('id', id);
    setRows(prev => prev.filter(r => r.id !== id && r.parent_id !== id));
  }

  // Plain render function (NOT a component) so that on the frequent re-renders
  // caused by audio playback, the avatar <Image> reconciles by position instead
  // of remounting — which is what made avatars flash/pulsate. expo-image also
  // caches the bitmap (memory+disk) and uses no fade, so it never flickers.
  function renderRow(item: Row, isReply?: boolean) {
    return (
    <View style={[styles.row, isReply && styles.replyRow]}>
      <StoryAvatar
        userId={item.user_id}
        avatarUrl={item.profiles?.avatar_url}
        name={item.profiles?.display_name}
        size={isReply ? 26 : 34}
        onPressProfile={() => goToProfile(item.user_id)}
        onBeforeOpenStory={onNavigate}
      />
      <View style={styles.body}>
        <TouchableOpacity activeOpacity={1} onLongPress={() => remove(item.id, item.user_id)}>
          <View style={styles.head}>
            <TouchableOpacity onPress={() => goToProfile(item.user_id)}>
              <Text style={styles.name}>{item.profiles?.display_name}</Text>
            </TouchableOpacity>
            <BadgeEmblem profile={item.profiles} ownerId={item.user_id} size={12} />
            <Text style={styles.time}>{timeAgo(item.created_at)}</Text>
          </View>
          <MentionText style={styles.text} text={item.body} />
        </TouchableOpacity>
        <View style={styles.metaRow}>
          <TouchableOpacity style={styles.metaBtn} onPress={() => toggleLike(item.id)}>
            <Ionicons
              name={likedByMe.has(item.id) ? 'heart' : 'heart-outline'}
              size={14} color={likedByMe.has(item.id) ? COLORS.like : COLORS.textTertiary}
            />
            {(likes[item.id] || 0) > 0 && <Text style={styles.metaText}>{likes[item.id]}</Text>}
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.metaBtn}
            onPress={() => setReplyTo({ id: item.parent_id ?? item.id, name: item.profiles?.username || '' })}
          >
            <Ionicons name="arrow-undo-outline" size={14} color={COLORS.textTertiary} />
            <Text style={styles.metaText}>Reply</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
    );
  }

  return (
    <View style={[styles.flex, style]}>
      <FlatList
        ref={listRef}
        data={topLevel}
        keyExtractor={c => c.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.list, contentPadding != null && { paddingHorizontal: contentPadding }]}
        refreshControl={
          onRefresh
            ? <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={COLORS.primary} />
            : undefined
        }
        ListHeaderComponent={
          <>
            {ListHeaderComponent}
            <View style={styles.divider} />
            <Text style={styles.label}>Comments · {rows.length}</Text>
          </>
        }
        ListEmptyComponent={<Text style={styles.empty}>No comments yet — be the first!</Text>}
        renderItem={({ item }) => {
          const replies = repliesOf(item.id);
          return (
            <View>
              {renderRow(item)}
              {replies.length > 0 && (
                <View style={styles.replyWire}>
                  {replies.map(r => <Fragment key={r.id}>{renderRow(r, true)}</Fragment>)}
                </View>
              )}
            </View>
          );
        }}
      />

      <View style={[styles.inputWrap, contentPadding != null && { marginHorizontal: contentPadding }]}>
        {replyTo && (
          <View style={styles.replyingBar}>
            <Text style={styles.replyingText}>Replying to @{replyTo.name}</Text>
            <TouchableOpacity onPress={() => setReplyTo(null)}><Ionicons name="close" size={16} color={COLORS.textSecondary} /></TouchableOpacity>
          </View>
        )}
        <MentionSuggestions
          query={getActiveMentionQuery(text, text.length)}
          onPick={(u) => setText(applyMention(text, text.length, u).text)}
          style={{ marginBottom: SPACING.xs }}
          maxHeight={180}
        />
        <View style={styles.inputBar}>
          <TextInput
            style={styles.input}
            placeholder={replyTo ? 'Add a reply...' : 'Add a comment...'}
            placeholderTextColor={COLORS.textTertiary}
            value={text} onChangeText={setText}
            multiline maxLength={300}
          />
          <TouchableOpacity style={[styles.sendBtn, !text.trim() && styles.sendDisabled]} onPress={submit} disabled={!text.trim() || sending}>
            {sending ? <ActivityIndicator color={COLORS.text} size="small" /> : <Ionicons name="arrow-up" size={18} color={COLORS.text} />}
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { paddingBottom: SPACING.lg },
  divider: { height: 0.5, backgroundColor: COLORS.border, marginTop: SPACING.lg },
  label: { color: COLORS.text, fontSize: 14, fontWeight: '700', marginTop: SPACING.md, marginBottom: SPACING.xs },
  empty: { color: COLORS.textTertiary, fontSize: 13, paddingVertical: SPACING.md },

  row: { flexDirection: 'row', gap: SPACING.sm, paddingVertical: SPACING.sm },
  // Wire connecting a comment to its replies, so threads are easy to trace.
  replyWire: { marginLeft: 17, borderLeftWidth: 2, borderLeftColor: COLORS.primary + '55', paddingLeft: SPACING.md },
  replyRow: { paddingVertical: SPACING.xs },
  avatar: { width: 34, height: 34, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  avatarSm: { width: 26, height: 26 },
  avatarText: { color: COLORS.text, fontSize: 13, fontWeight: '700' },
  body: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  name: { color: COLORS.text, fontSize: 13, fontWeight: '700' },
  time: { color: COLORS.textTertiary, fontSize: 11 },
  text: { color: COLORS.textSecondary, fontSize: 14, marginTop: 2, lineHeight: 19 },
  metaRow: { flexDirection: 'row', gap: SPACING.lg, marginTop: 4 },
  metaBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText: { color: COLORS.textTertiary, fontSize: 12, fontWeight: '600' },

  inputWrap: { borderTopWidth: 0.5, borderTopColor: COLORS.border },
  replyingBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xs,
  },
  replyingText: { color: COLORS.textSecondary, fontSize: 12 },
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', gap: SPACING.sm, paddingVertical: SPACING.sm, paddingBottom: SPACING.md },
  input: {
    flex: 1, backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: COLORS.border,
    borderRadius: RADIUS.lg, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, color: COLORS.text, fontSize: 14, maxHeight: 90,
  },
  sendBtn: { width: 38, height: 38, borderRadius: RADIUS.full, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' },
  sendDisabled: { opacity: 0.4 },
});
