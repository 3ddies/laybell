import { View, Text, StyleSheet, TouchableOpacity, TextInput, FlatList, ActivityIndicator, RefreshControl, Alert } from 'react-native';
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
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { timeAgo } from '../lib/timeAgo';
import { formatCount } from '../lib/format';
import { createNotification } from '../lib/createNotification';
import { processMentions, getActiveMentionQuery, applyMention } from '../lib/mentions';
import MentionSuggestions from './MentionSuggestions';
import MentionText from './MentionText';

type Row = {
  id: string; body: string; created_at: string; user_id: string;
  parent_id: string | null; profiles: any;
};

export default function Comments({
  postId, ownerId, ListHeaderComponent, style, contentPadding, minHeaderHeight, onRefresh, onNavigate, onComposingChange, onEngage, onScrollTop,
}: {
  postId: string;
  ownerId?: string | null;
  ListHeaderComponent?: ReactElement;
  style?: any;
  // Stretches the host's header to (at least) this height, so the "Comments"
  // label lands at the bottom of the first screenful and the comments
  // themselves always start BELOW the fold (Now Playing passes this).
  minHeaderHeight?: number;
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
  // Fires when the user starts/stops composing (input focused, a draft typed, or a
  // reply queued). Lets a host (Now Playing) stay open so a song ending doesn't cut
  // off an in-progress comment.
  onComposingChange?: (composing: boolean) => void;
  // Fires on any comment-section interaction (scroll, like, type, reply). A host
  // (Now Playing) uses it to detect engagement near the end of a track.
  onEngage?: () => void;
  // Fires when the list is scrolled back to the very top — lets a host (Now Playing)
  // drop near-end engagement, since the user has left the comments.
  onScrollTop?: () => void;
}) {
  const listRef = useRef<FlatList>(null);
  const atTopRef = useRef(true); // list starts at the top; tracks top-edge crossings
  const router = useRouter();
  const { profile: myProfile } = useProfile();

  // Open a commenter's profile. Closes the host sheet/overlay first (if any).
  function goToProfile(uid?: string) {
    if (!uid) return;
    onNavigate?.();
    router.push(`/profile/${uid}` as any);
  }
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [userId, setUserId] = useState<string | null>(null);
  const [userProfile, setUserProfile] = useState<any>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [likes, setLikes] = useState<Record<string, number>>({});
  const [likedByMe, setLikedByMe] = useState<Set<string>>(new Set());
  const [replyTo, setReplyTo] = useState<{ id: string; name: string } | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    setUserId(user?.id ?? null);
    if (user) supabase.from('profiles').select('username, display_name, avatar_url, badge_tier, badge_show, profile_theme').eq('id', user.id).single()
      .then(({ data }) => setUserProfile(data));

    const { data: comments } = await supabase
      .from('comments')
      .select('id, body, created_at, user_id, parent_id, profiles!comments_user_id_fkey(username, display_name, avatar_url, badge_tier, badge_show, profile_theme)')
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

  // Report whether a comment is being composed — input focused, a draft typed, or a
  // reply queued — so a host (Now Playing) can avoid closing mid-comment. Release on
  // unmount so a deferred close isn't left hanging.
  const composing = inputFocused || text.trim().length > 0 || replyTo != null;
  useEffect(() => {
    onComposingChange?.(composing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composing]);
  useEffect(() => {
    return () => { onComposingChange?.(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([load(), onRefresh?.()]);
    setRefreshing(false);
  }, [load, onRefresh]);

  const topLevel = rows.filter(r => !r.parent_id);
  const repliesOf = (id: string) => rows.filter(r => r.parent_id === id);

  async function toggleLike(commentId: string) {
    if (!userId) return;
    onEngage?.();
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
    // Hidden accounts browse/listen only — no commenting while invisible.
    if ((myProfile as any)?.hidden) {
      Alert.alert('Profile hidden', 'Unhide your profile in Settings to comment.');
      return;
    }
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
        size={isReply ? 30 : 34}
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
          <TouchableOpacity
            style={styles.metaBtn}
            onPress={() => toggleLike(item.id)}
            hitSlop={{ top: 6, bottom: 8, left: 8, right: 4 }}
          >
            <Ionicons
              name={likedByMe.has(item.id) ? 'heart' : 'heart-outline'}
              size={16} color={likedByMe.has(item.id) ? colors.like : colors.textTertiary}
            />
            {(likes[item.id] || 0) > 0 && <Text style={styles.metaText}>{likes[item.id]}</Text>}
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.metaBtn}
            onPress={() => {
              onEngage?.();
              setReplyTo({ id: item.parent_id ?? item.id, name: item.profiles?.username || '' });
              // Replying to a REPLY: prefill "@username " so the thread shows
              // who is being addressed. Replying to the original comment needs
              // no tag (the thread position already makes that clear). Never
              // clobber a draft the user has already started.
              if (item.parent_id != null && item.profiles?.username) {
                setText(prev => (prev.trim().length ? prev : `@${item.profiles.username} `));
              }
            }}
            hitSlop={{ top: 6, bottom: 8, left: 4, right: 8 }}
          >
            <Ionicons name="arrow-undo-outline" size={15} color={colors.textTertiary} />
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
        // With only a few comments (≤3), a scroll likely just runs to the bottom by
        // accident — don't treat that as engagement that holds the song open. Liking,
        // typing and replying still count regardless (they're deliberate).
        onScrollBeginDrag={() => { if (rows.length > 3) onEngage?.(); }}
        // Scrolling back to the very top means the user left the comments — drop the
        // near-end engagement so the song is no longer held open.
        onScroll={(e) => {
          const atTop = e.nativeEvent.contentOffset.y <= 0;
          if (atTop && !atTopRef.current) onScrollTop?.();
          atTopRef.current = atTop;
        }}
        scrollEventThrottle={16}
        contentContainerStyle={[styles.list, contentPadding != null && { paddingHorizontal: contentPadding }]}
        refreshControl={
          onRefresh
            ? <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.primary} />
            : undefined
        }
        ListHeaderComponent={
          <>
            {minHeaderHeight != null
              ? <View style={{ minHeight: minHeaderHeight }}>{ListHeaderComponent}</View>
              : ListHeaderComponent}
            <View style={styles.divider} />
            <View style={[styles.labelRow, minHeaderHeight != null && styles.labelRowFold]}>
              <Text style={styles.label}>Comments</Text>
              {rows.length > 0 && (
                <View style={styles.countChip}>
                  <Text style={styles.countChipText}>{formatCount(rows.length)}</Text>
                </View>
              )}
            </View>
          </>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="chatbubble-ellipses-outline" size={26} color={colors.textTertiary} />
            <Text style={styles.emptyTitle}>No comments yet</Text>
            <Text style={styles.emptySub}>Be the first to say something</Text>
          </View>
        }
        renderItem={({ item }) => {
          const replies = repliesOf(item.id);
          return (
            <View>
              {renderRow(item)}
              {replies.length > 0 && (
                <View style={styles.replyWire}>
                  {/* One rounded rule spanning the reply group (quote-bar style)
                      — tracks the thread without per-row connector alignment. */}
                  <View style={styles.replyRule} />
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
            <Ionicons name="arrow-undo" size={13} color={colors.primary} />
            <Text style={styles.replyingText} numberOfLines={1}>
              Replying to <Text style={styles.replyingName}>@{replyTo.name}</Text>
            </Text>
            <TouchableOpacity
              onPress={() => {
                // Dropping the reply also drops the auto-inserted "@username "
                // tag — but keeps anything else the user typed after it.
                setText(prev => {
                  const tag = `@${replyTo.name}`;
                  if (!replyTo.name || !prev.startsWith(tag)) return prev;
                  return prev.slice(tag.length).replace(/^\s+/, '');
                });
                setReplyTo(null);
              }}
              hitSlop={8}
            >
              <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
            </TouchableOpacity>
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
            placeholderTextColor={colors.textTertiary}
            value={text} onChangeText={(t) => { setText(t); onEngage?.(); }}
            onFocus={() => { setInputFocused(true); onEngage?.(); }}
            onBlur={() => setInputFocused(false)}
            multiline maxLength={300}
          />
          <TouchableOpacity style={[styles.sendBtn, !text.trim() && styles.sendDisabled]} onPress={submit} disabled={!text.trim() || sending}>
            {sending ? <ActivityIndicator color={colors.text} size="small" /> : <Ionicons name="arrow-up" size={20} color={colors.text} />}
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  flex: { flex: 1 },
  list: { paddingBottom: SPACING.lg },
  divider: { height: 0.5, backgroundColor: colors.border, marginTop: SPACING.lg },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginTop: SPACING.md, marginBottom: SPACING.md },
  // Player fold mode: a touch more room under the label so it sits with the
  // reference spacing above the input bar while the first comment stays just
  // below the fold. Kept modest so the scrolled-up list doesn't gape.
  labelRowFold: { marginBottom: SPACING.xl + SPACING.sm },
  label: { color: colors.text, fontSize: 16, fontWeight: '800', letterSpacing: -0.2 },
  countChip: {
    paddingHorizontal: 9, paddingVertical: 2, borderRadius: RADIUS.full,
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
  },
  countChipText: { color: colors.textSecondary, fontSize: 12, fontWeight: '700' },
  empty: { alignItems: 'center', gap: 5, paddingVertical: SPACING.xl },
  emptyTitle: { color: colors.textSecondary, fontSize: 14, fontWeight: '700', marginTop: 3 },
  emptySub: { color: colors.textTertiary, fontSize: 13 },

  row: { flexDirection: 'row', gap: SPACING.sm, paddingVertical: SPACING.sm },
  // Reply thread: the group is inset under the parent's avatar, with a single
  // rounded rule (quote-bar style) tracking the whole group — aligned to the
  // parent avatar's center (34px avatar → center 17, rule width 2 → left 16).
  replyWire: { marginLeft: 16, paddingLeft: 14 },
  replyRow: { paddingVertical: 6 },
  replyRule: {
    position: 'absolute', left: 0, top: 4, bottom: 8,
    width: 2, borderRadius: 1, backgroundColor: colors.border,
  },
  avatar: { width: 34, height: 34, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  avatarSm: { width: 26, height: 26 },
  avatarText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  body: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  name: { color: colors.text, fontSize: 13, fontWeight: '700' },
  time: { color: colors.textTertiary, fontSize: 11 },
  text: { color: colors.textSecondary, fontSize: 14, marginTop: 2, lineHeight: 20 },
  // Buttons carry their own padding (plus hitSlop in the JSX) so the touch
  // targets are comfortably large without visually moving the row.
  metaRow: { flexDirection: 'row', gap: SPACING.lg, marginTop: 2 },
  metaBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 6 },
  metaText: { color: colors.textTertiary, fontSize: 12, fontWeight: '600' },

  inputWrap: { borderTopWidth: 0.5, borderTopColor: colors.border },
  replyingBar: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.full, paddingHorizontal: SPACING.md, paddingVertical: 6,
    marginTop: SPACING.sm,
  },
  replyingText: { flex: 1, color: colors.textSecondary, fontSize: 12.5 },
  replyingName: { color: colors.primary, fontWeight: '700' },
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', gap: SPACING.sm, paddingTop: SPACING.sm + 2, paddingBottom: SPACING.md },
  input: {
    flex: 1, backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: 22, paddingHorizontal: SPACING.md + 2, paddingVertical: 11, minHeight: 44,
    color: colors.text, fontSize: 15, lineHeight: 20, maxHeight: 110,
  },
  sendBtn: { width: 44, height: 44, borderRadius: RADIUS.full, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  sendDisabled: { opacity: 0.4 },
});
