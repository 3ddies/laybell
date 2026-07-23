import { View, Text, StyleSheet, TouchableOpacity, TextInput, FlatList, ActivityIndicator, RefreshControl, Alert, Animated, Keyboard, Pressable } from 'react-native';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, ReactElement } from 'react';
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
import { useTranslation } from '../contexts/LanguageContext';
import { timeAgo } from '../lib/timeAgo';
import { formatCount } from '../lib/format';
import { createNotification } from '../lib/createNotification';
import { processMentions, getActiveMentionQuery, applyMention } from '../lib/mentions';
import { maskHiddenProfile } from '../lib/hiddenProfile';
import MentionSuggestions from './MentionSuggestions';
import MentionText from './MentionText';
import TranslatableText from './TranslatableText';
import AttachmentView from './AttachmentView';
import { parseAttachment, attachmentBody, type Attachment } from '../lib/attachments';
import { openGifAttachment } from '../lib/gifAttachmentActions';
import { openCommentActions } from '../lib/commentActions';
import { openGifPicker } from '../lib/gifPicker';
import { openImageViewer } from '../lib/imageViewer';
import { openPhotoPicker } from '../lib/photoPicker';
import { reportUser } from '../lib/postActions';

type Row = {
  id: string; body: string; created_at: string; user_id: string;
  parent_id: string | null; profiles: any;
};

// Rank TOP-LEVEL comments most-relevant-first. Blends likes, reply count, like
// velocity (likes earned per hour since posting — "recency to the amount of likes
// received"), and a gentle recency baseline so unengaged comments fall
// newest-first and ties break by recency. Computed once per load (snapshot), so an
// optimistic like never reshuffles the list under the reader. Returns ordered ids.
function rankTopLevelIds(comments: any[], likeCounts: Record<string, number>): string[] {
  const now = Date.now();
  const replyCount: Record<string, number> = {};
  for (const c of comments) if (c.parent_id) replyCount[c.parent_id] = (replyCount[c.parent_id] || 0) + 1;
  const score = (c: any) => {
    const likes = likeCounts[c.id] || 0;
    const replies = replyCount[c.id] || 0;
    const ageH = Math.max(0, (now - (Date.parse(c.created_at) || now)) / 3_600_000);
    const recency = 1 / Math.pow(ageH + 2, 0.6); // ~0.66 when fresh, decays with age
    const velocity = likes / (ageH + 1);         // fast-liked comments rank higher
    return likes * 2.5 + replies * 2 + velocity * 3 + recency * 1.5;
  };
  return comments
    .filter((c) => !c.parent_id)
    .sort((a, b) => score(b) - score(a) || (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0))
    .map((c) => c.id);
}

export default function Comments({
  postId, ownerId, ListHeaderComponent, style, contentPadding, minHeaderHeight, onRefresh, onNavigate, onComposingChange, onEngage, onScrollTop, onPosted,
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
  // Fires after a comment is actually SUBMITTED (not on open/typing) — the feed
  // uses it to count a genuine ad engagement.
  onPosted?: () => void;
}) {
  const listRef = useRef<FlatList>(null);
  const inputRef = useRef<TextInput>(null); // so tapping "Reply" can pop the keyboard
  const atTopRef = useRef(true); // list starts at the top; tracks top-edge crossings
  // Simple like pop: only the last-tapped comment's heart scales (piggybacks on the
  // re-render toggleLike already triggers, so it adds no extra renders).
  const likeScale = useRef(new Animated.Value(1)).current;
  const [poppedId, setPoppedId] = useState<string | null>(null);
  const popLike = useCallback((id: string) => {
    setPoppedId(id);
    likeScale.setValue(1);
    Animated.sequence([
      Animated.timing(likeScale, { toValue: 1.35, duration: 110, useNativeDriver: true }),
      Animated.spring(likeScale, { toValue: 1, friction: 3, useNativeDriver: true }),
    ]).start();
  }, [likeScale]);
  const router = useRouter();
  const { t } = useTranslation();
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
  // Relevance order of top-level comment ids, snapshotted at load (see rankTopLevelIds).
  const [topOrder, setTopOrder] = useState<string[]>([]);
  const [likes, setLikes] = useState<Record<string, number>>({});
  const [likedByMe, setLikedByMe] = useState<Set<string>>(new Set());
  const [replyTo, setReplyTo] = useState<{ id: string; name: string } | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  // Staged image/GIF attachment + GIF picker for comments.
  const [pendingAttachment, setPendingAttachment] = useState<Attachment | null>(null);

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    setUserId(user?.id ?? null);
    if (user) supabase.from('profiles').select('username, display_name, avatar_url, badge_tier, badge_show, profile_theme').eq('id', user.id).single()
      .then(({ data }) => setUserProfile(data));

    const { data: comments } = await supabase
      .from('comments')
      .select('id, body, created_at, user_id, parent_id, profiles!comments_user_id_fkey(username, display_name, avatar_url, badge_tier, badge_show, profile_theme, hidden)')
      .eq('post_id', postId)
      .order('created_at', { ascending: true });
    if (!comments) return;
    // Old comments from now-hidden accounts stay, but read as "Hidden account".
    setRows(comments.map((c: any) => ({
      ...c, profiles: maskHiddenProfile(c.profiles, c.user_id === user?.id),
    })) as any);

    const ids = comments.map((c: any) => c.id);
    const counts: Record<string, number> = {};
    const mine = new Set<string>();
    if (ids.length) {
      const { data: cl } = await supabase.from('comment_likes').select('comment_id, user_id').in('comment_id', ids);
      (cl ?? []).forEach((l: any) => {
        counts[l.comment_id] = (counts[l.comment_id] || 0) + 1;
        if (user && l.user_id === user.id) mine.add(l.comment_id);
      });
    }
    setLikes(counts);
    setLikedByMe(mine);
    // Snapshot the relevance order now (with fresh like/reply counts) so the list
    // is stable — liking a comment later won't reshuffle it mid-read.
    setTopOrder(rankTopLevelIds(comments, counts));
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

  // Top-level comments in relevance order (topOrder), with any posted-this-session
  // comments not yet in the snapshot appended at the end (they get ranked on the
  // next load/refresh). Replies stay chronological within their thread.
  const topLevel = useMemo(() => {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const seen = new Set<string>();
    const out: Row[] = [];
    for (const id of topOrder) {
      const r = byId.get(id);
      if (r && !r.parent_id) { out.push(r); seen.add(id); }
    }
    for (const r of rows) if (!r.parent_id && !seen.has(r.id)) out.push(r);
    return out;
  }, [rows, topOrder]);
  // Replies grouped by parent id, built once per `rows` change — replaces an
  // O(n²) `rows.filter` that ran per top-level comment on every render (e.g.
  // every keystroke while composing).
  const repliesByParent = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of rows) {
      if (!r.parent_id) continue;
      const arr = m.get(r.parent_id);
      if (arr) arr.push(r); else m.set(r.parent_id, [r]);
    }
    return m;
  }, [rows]);
  const repliesOf = (id: string) => repliesByParent.get(id) ?? [];

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

  // Open the in-app photo grid (rendered in its own overlay so it works from the
  // Now Playing player, where the native picker gets stranded behind the overlay).
  function attachImage() {
    if (!userId) return;
    openPhotoPicker({ userId, onPicked: setPendingAttachment });
  }

  async function submit() {
    if ((!text.trim() && !pendingAttachment) || !userId || sending) return;
    // Hidden accounts browse/listen only — no commenting while invisible.
    if ((myProfile as any)?.hidden) {
      Alert.alert(t('comments.hiddenTitle'), t('comments.hiddenBody'));
      return;
    }
    setSending(true);
    const caption = text.trim();
    const pending = pendingAttachment;
    // An attachment carries its caption in the body marker; mentions still run
    // over the human-typed caption only.
    const body = pending ? attachmentBody(pending, caption) : caption;
    const parent_id = replyTo?.id ?? null;
    setText('');
    setReplyTo(null);
    setPendingAttachment(null);
    const { data, error } = await supabase
      .from('comments').insert({ user_id: userId, post_id: postId, body, parent_id }).select().single();
    if (error || !data) {
      // Restore the draft so nothing is lost, and surface the failure instead of
      // dropping the comment silently.
      setText(caption);
      setPendingAttachment(pending);
      if (parent_id) setReplyTo(replyTo);
      Alert.alert(t('comments.postFailedTitle'), error?.message || t('comments.postFailedBody'));
      setSending(false);
      return;
    }
    bumpBadge('comments');
    onPosted?.();
    setRows(prev => [...prev, { ...(data as any), profiles: myProfile ?? userProfile }]);
    if (!parent_id) setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    if (ownerId && ownerId !== userId) createNotification({ userId: ownerId, actorId: userId, type: 'comment', postId });
    if (caption) processMentions({ text: caption, actorId: userId, postId, commentId: (data as any).id });
    setSending(false);
  }

  async function remove(id: string, authorId: string) {
    if (authorId !== userId) return;
    await supabase.from('comments').delete().eq('id', id);
    setRows(prev => prev.filter(r => r.id !== id && r.parent_id !== id));
  }

  // Queue a reply to `item` (used by the Reply button AND the long-press sheet):
  // reply to the thread root, prefill "@username " when replying to a reply, and
  // pop the keyboard.
  function beginReply(item: Row) {
    onEngage?.();
    setReplyTo({ id: item.parent_id ?? item.id, name: item.profiles?.username || '' });
    if (item.parent_id != null && item.profiles?.username) {
      setText(prev => (prev.trim().length ? prev : `@${item.profiles.username} `));
    }
    inputRef.current?.focus();
  }

  // Long-press a comment → themed action sheet (Reply · Delete own · Report other)
  // instead of the old instant delete.
  function openCommentSheet(item: Row) {
    openCommentActions({
      isOwn: item.user_id === userId,
      onReply: () => beginReply(item),
      onDelete: () => remove(item.id, item.user_id),
      onReport: () => reportUser(item.user_id),
    });
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
        <TouchableOpacity activeOpacity={1} onPress={() => Keyboard.dismiss()} onLongPress={() => openCommentSheet(item)} delayLongPress={280}>
          <View style={styles.head}>
            <TouchableOpacity onPress={() => goToProfile(item.user_id)}>
              <Text style={styles.name}>{item.profiles?.display_name}</Text>
            </TouchableOpacity>
            <BadgeEmblem profile={item.profiles} ownerId={item.user_id} size={12} />
            <Text style={styles.time}>{timeAgo(item.created_at)}</Text>
          </View>
          {(() => {
            const att = parseAttachment(item.body);
            if (att) {
              const isGif = att.type === 'gif';
              const isOwn = item.user_id === userId;
              // A GIF: tap AND long-press open the GIF sheet (with Delete when it's
              // your own). A plain image: tap opens the viewer, long-press opens the
              // comment sheet (so it's still deletable/reportable).
              const openGif = () => openGifAttachment(att, {
                userId,
                onView: () => openImageViewer(att.url),
                canDelete: isOwn,
                onDelete: () => remove(item.id, item.user_id),
              });
              return (
                <View style={styles.commentAttach}>
                  <AttachmentView
                    url={att.url} w={att.w} h={att.h} maxWidth={132} radius={12}
                    onPress={isGif ? openGif : () => openImageViewer(att.url)}
                    onLongPress={isGif ? openGif : () => openCommentSheet(item)}
                  />
                  {att.text ? <MentionText style={styles.text} text={att.text} onBeforeNavigate={onNavigate} /> : null}
                </View>
              );
            }
            return <TranslatableText text={item.body} render={(s) => <MentionText style={styles.text} text={s} onBeforeNavigate={onNavigate} />} />;
          })()}
        </TouchableOpacity>
        <View style={styles.metaRow}>
          <TouchableOpacity
            style={styles.metaBtn}
            onPress={() => { popLike(item.id); toggleLike(item.id); }}
            hitSlop={{ top: 6, bottom: 8, left: 8, right: 4 }}
          >
            <Animated.View style={{ transform: [{ scale: poppedId === item.id ? likeScale : 1 }] }}>
              <Ionicons
                name={likedByMe.has(item.id) ? 'heart' : 'heart-outline'}
                size={16} color={likedByMe.has(item.id) ? colors.like : colors.textTertiary}
              />
            </Animated.View>
            {(likes[item.id] || 0) > 0 && <Text style={styles.metaText}>{likes[item.id]}</Text>}
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.metaBtn}
            onPress={() => beginReply(item)}
            hitSlop={{ top: 6, bottom: 8, left: 4, right: 8 }}
          >
            <Ionicons name="arrow-undo-outline" size={15} color={colors.textTertiary} />
            <Text style={styles.metaText}>{t('comments.reply')}</Text>
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
        keyboardDismissMode="on-drag"
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
              <Text style={styles.label}>{t('comments.title')}</Text>
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
            <Text style={styles.emptyTitle}>{t('comments.emptyTitle')}</Text>
            <Text style={styles.emptySub}>{t('comments.emptySub')}</Text>
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

      {/* The input bar always gets a horizontal inset (host's contentPadding,
          or a default) — with none, the input's rounded corners sat clipped
          against the screen edge (the expanded-post host passes no padding so
          its media can stay full-bleed). */}
      <View style={[styles.inputWrap, { marginHorizontal: contentPadding ?? SPACING.md }]}>
        {replyTo && (
          <View style={styles.replyingBar}>
            <Ionicons name="arrow-undo" size={13} color={colors.primary} />
            <Text style={styles.replyingText} numberOfLines={1}>
              {t('comments.replyingTo')} <Text style={styles.replyingName}>@{replyTo.name}</Text>
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
        {pendingAttachment && (
          // Full-width row is a keyboard-dismiss zone; the bordered box hugs the
          // GIF only, so tapping the empty space beside it exits typing (handy in
          // the tight landscape comment sheet) rather than doing nothing.
          <Pressable style={styles.attachPreviewRow} onPress={() => Keyboard.dismiss()}>
            <View style={styles.attachPreviewItem}>
              <AttachmentView url={pendingAttachment.url} w={pendingAttachment.w} h={pendingAttachment.h} maxWidth={96} radius={10} />
              <TouchableOpacity style={styles.attachRemove} onPress={() => setPendingAttachment(null)} hitSlop={8}>
                <Ionicons name="close-circle" size={20} color={colors.text} />
              </TouchableOpacity>
            </View>
          </Pressable>
        )}
        <View style={styles.inputBar}>
          <TouchableOpacity style={styles.attachBtn} onPress={attachImage} activeOpacity={0.7}>
            <Ionicons name="image-outline" size={22} color={colors.textTertiary} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.gifBtn} onPress={() => openGifPicker({ userId, onSelect: (g) => setPendingAttachment({ type: 'gif', url: g.url, w: g.w, h: g.h, src: g.src }) })} activeOpacity={0.7}>
            <Text style={styles.gifBtnText}>GIF</Text>
          </TouchableOpacity>
          <TextInput
            ref={inputRef}
            style={styles.input}
            placeholder={replyTo ? t('comments.replyPlaceholder') : t('comments.addPlaceholder')}
            placeholderTextColor={colors.textTertiary}
            value={text} onChangeText={(t) => { setText(t); onEngage?.(); }}
            onFocus={() => { setInputFocused(true); onEngage?.(); }}
            onBlur={() => setInputFocused(false)}
            multiline maxLength={300}
          />
          <TouchableOpacity style={[styles.sendBtn, (!text.trim() && !pendingAttachment) && styles.sendDisabled]} onPress={submit} disabled={(!text.trim() && !pendingAttachment) || sending}>
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
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', gap: SPACING.xs, paddingTop: SPACING.sm + 2, paddingBottom: SPACING.md },
  commentAttach: { marginTop: 4, gap: 4 },
  attachPreviewRow: { flexDirection: 'row', paddingTop: SPACING.sm },
  // Hugs the GIF (doesn't stretch across the row) so only the thumbnail is the
  // bounded/interactive element — the rest of the row dismisses the keyboard.
  attachPreviewItem: { alignSelf: 'flex-start' },
  attachRemove: { position: 'absolute', top: -5, right: -5, backgroundColor: colors.background, borderRadius: RADIUS.full },
  attachBtn: { width: 36, height: 44, alignItems: 'center', justifyContent: 'center' },
  gifBtn: {
    height: 44, paddingHorizontal: 7, borderRadius: RADIUS.sm,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: colors.textTertiary,
  },
  gifBtnText: { color: colors.textTertiary, fontSize: 11, fontWeight: '900', letterSpacing: 0.3 },
  input: {
    flex: 1, backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: 22, paddingHorizontal: SPACING.md + 2, paddingVertical: 11, minHeight: 44,
    color: colors.text, fontSize: 15, lineHeight: 20, maxHeight: 110,
  },
  sendBtn: { width: 44, height: 44, borderRadius: RADIUS.full, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  sendDisabled: { opacity: 0.4 },
});
