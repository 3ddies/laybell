import {
  View, Text, StyleSheet, FlatList, TextInput,
  TouchableOpacity, Pressable, Image, RefreshControl, Keyboard, Animated, Easing,
} from 'react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { SPACING, RADIUS, GRADIENTS, SHADOWS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useSearchSwipeLock } from '../../contexts/PagerContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { timeAgo } from '../../lib/timeAgo';
import { sharedPostId, parseStoryReply } from '../../lib/postLinks';
import { parseAttachment } from '../../lib/attachments';
import { isOfferBody } from '../../lib/offerMessage';
import { isStudioInviteBody } from '../../lib/studioInvite';
import { fetchBlockedIds } from '../../lib/blocks';
import { maskHiddenProfile } from '../../lib/hiddenProfile';
import HighlightText from '../../components/HighlightText';
import StoryAvatar from '../../components/StoryAvatar';
import BadgeEmblem from '../../components/BadgeEmblem';
import GroupAvatar from '../../components/GroupAvatar';
import SwipeBackPager from '../../components/SwipeBackPager';
import { ListRowsSkeleton } from '../../components/Skeleton';
import { useStories } from '../../contexts/StoriesContext';
import { useFollow } from '../../contexts/FollowContext';
import { fetchGroupConversations, groupTitle, parseRenameEvent, type GroupProfile } from '../../lib/groups';

type MsgTab = 'main' | 'friends' | 'followers';
const MSG_TABS: MsgTab[] = ['main', 'friends', 'followers'];

// A row in the list is either a 1:1 DM or a group. Both carry `bodies` +
// `sharedCaptions` so the keyword search treats them uniformly.
type DmConversation = {
  kind: 'dm';
  id: string;
  other_user: { id: string; username: string; display_name: string; avatar_url: string | null; badge_tier?: string | null; badge_show?: boolean | null };
  // Who sent the latest message. Groups have always carried this (their
  // preview is prefixed "Sender: …"); DMs need it too, because an offer preview
  // reads differently from each end — "Sent you an offer" is nonsense to the
  // person who sent it.
  last_sender_id: string | null;
  last_message: string;
  last_message_time: string;
  unread: number;
  bodies: string[];
  sharedCaptions: string[];
};
type GroupConversation = {
  kind: 'group';
  id: string;                 // conversation id
  title: string | null;
  avatarUrl: string | null;
  members: GroupProfile[];
  last_sender_id: string | null;
  last_message: string;
  last_message_time: string;
  unread: number;
  bodies: string[];
  sharedCaptions: string[];
};
type Conversation = DmConversation | GroupConversation;

// First non-shared-post message in the convo that contains the query, or null.
function matchingMessage(c: Conversation, q: string): string | null {
  if (!q) return null;
  return c.bodies.find(b => !sharedPostId(b) && b.toLowerCase().includes(q)) ?? null;
}

// An offer that has ARRIVED and has not been opened yet.
//
// `unread` only ever counts messages sent TO me, so this cannot match an offer
// I sent myself — the buyer sees their own offer sitting in the thread at its
// natural place in the timeline, which is right, because there is nothing for
// them to do about it.
function pendingOfferRow(c: Conversation): boolean {
  return c.kind === 'dm' && c.unread > 0 && isOfferBody(c.last_message);
}

// First shared-post caption in the convo that contains the query, or null.
function matchingCaption(c: Conversation, q: string): string | null {
  if (!q) return null;
  return c.sharedCaptions.find(cap => cap.toLowerCase().includes(q)) ?? null;
}

export default function MessagesScreen() {
  const { colors, mode } = useTheme();
  const isLight = mode === 'light';

  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  // Focus glow on the search field. Driven from the searchFocused state that
  // already existed for the clear button, so there is no new source of truth.
  //
  // useNativeDriver is FALSE and has to be: borderColor and shadowOpacity are
  // not native-drivable properties. That is affordable here and nowhere else —
  // one view, on focus, for 180ms, not something running per frame in a list.
  const searchGlow = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(searchGlow, {
      toValue: searchFocused ? 1 : 0,
      duration: 180,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
  }, [searchFocused, searchGlow]);
  // Holds the swipe-back gesture off while searching (SwipeBackPager reads it).
  useSearchSwipeLock(searchFocused || searchQuery.length > 0);
  const [tab, setTab] = useState<MsgTab>('main');
  const { friends, followers } = useFollow();
  const { refresh: refreshStories } = useStories();

  useEffect(() => { setup(); }, []);

  // Refresh on focus so reading a thread (which marks it read) clears the unread
  // highlight here, and any newly-received messages re-sort to the top.
  useFocusEffect(
    useCallback(() => {
      if (currentUserId) fetchConversations(currentUserId);
      refreshStories(); // keep story rings on conversation avatars fresh
    }, [currentUserId, refreshStories])
  );

  async function onRefresh() {
    if (!currentUserId) return;
    setRefreshing(true);
    await fetchConversations(currentUserId);
    setRefreshing(false);
  }

  async function setup() {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) { setCurrentUserId(user.id); await fetchConversations(user.id); }
    } finally {
      // Never strand the inbox on a skeleton if the fetch rejects.
      setLoading(false);
    }
  }

  async function fetchConversations(userId: string) {
    const [{ data }, blockedIds, groups] = await Promise.all([
      supabase
        .from('messages')
        .select('id, body, created_at, sender_id, receiver_id, read')
        .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
        .order('created_at', { ascending: false }),
      fetchBlockedIds(),
      // Groups I'm in. Returns [] pre-migration (table absent), so DMs keep working.
      fetchGroupConversations(userId),
    ]);

    // Group rows map straight across; they merge with the DM rows below.
    const groupConvos: Conversation[] = (groups ?? []).map(g => ({
      kind: 'group' as const,
      id: g.id,
      title: g.title,
      avatarUrl: g.avatar_url,
      members: g.members,
      last_sender_id: g.last_sender_id,
      last_message: g.last_message,
      last_message_time: g.last_message_time,
      unread: g.unread,
      bodies: g.bodies,
      sharedCaptions: [],
    }));

    // Merge DMs + groups, newest activity first, and commit.
    const finish = (dmConvos: Conversation[]) => {
      const merged = [...dmConvos, ...groupConvos];
      // An UNREAD OFFER outranks recency and goes to the very top. It is the one
      // thing in this inbox that costs someone something to ignore — the buyer's
      // credits sit in escrow until it is answered — so it must not slide down the
      // list as ordinary chatter arrives above it. Everything else stays
      // newest-first, and the moment it is read it rejoins them.
      merged.sort((a, b) => {
        const ao = pendingOfferRow(a) ? 1 : 0;
        const bo = pendingOfferRow(b) ? 1 : 0;
        if (ao !== bo) return bo - ao;
        return new Date(b.last_message_time).getTime() - new Date(a.last_message_time).getTime();
      });
      setConversations(merged);
    };

    const dmData = data ?? [];
    // `dmData` is newest-first, so the first message seen per partner is the latest.
    // Blocked partners are skipped entirely (their chats are hidden until unblock).
    // Group messages surface here too (my own sends), but they have a null
    // receiver → null partnerId → skipped, so they never pollute the DM list.
    const partnerIds: string[] = [];
    const latestMessages: Record<string, any> = {};
    const unreadCounts: Record<string, number> = {};
    const bodiesByPartner: Record<string, string[]> = {};
    dmData.forEach(msg => {
      const partnerId = msg.sender_id === userId ? msg.receiver_id : msg.sender_id;
      if (!partnerId || blockedIds.has(partnerId)) return;
      if (!latestMessages[partnerId]) { partnerIds.push(partnerId); latestMessages[partnerId] = msg; }
      if (!bodiesByPartner[partnerId]) bodiesByPartner[partnerId] = [];
      if (msg.body) bodiesByPartner[partnerId].push(msg.body);
      // Count messages they sent me that I haven't read yet (read === false,
      // matching the unread-badge query elsewhere, so legacy null rows aren't counted).
      if (msg.receiver_id === userId && msg.read === false) {
        unreadCounts[partnerId] = (unreadCounts[partnerId] || 0) + 1;
      }
    });

    if (partnerIds.length === 0) { finish([]); return; }

    // Resolve captions of any posts shared in these chats so search can match them.
    const allSharedIds = new Set<string>();
    const sharedIdsByPartner: Record<string, string[]> = {};
    for (const pid of partnerIds) {
      const ids: string[] = [];
      for (const b of bodiesByPartner[pid] || []) {
        const sid = sharedPostId(b);
        if (sid) { ids.push(sid); allSharedIds.add(sid); }
      }
      sharedIdsByPartner[pid] = ids;
    }
    let captionById: Record<string, string> = {};
    if (allSharedIds.size > 0) {
      const { data: sharedPosts } = await supabase.from('posts').select('id, caption').in('id', [...allSharedIds]);
      captionById = Object.fromEntries((sharedPosts ?? []).map((p: any) => [p.id, p.caption || '']));
    }

    const { data: profiles } = await supabase
      .from('profiles').select('id, username, display_name, avatar_url, badge_tier, badge_show, profile_theme, hidden').in('id', partnerIds);
    if (!profiles) { finish([]); return; }

    // Partners who have since hidden their account read as "Hidden account".
    const profileMap = Object.fromEntries(profiles.map(p => [p.id, maskHiddenProfile(p as any)]));
    const dmConvos = partnerIds
      .map(pid => {
        const p = profileMap[pid];
        if (!p) return null;
        return {
          kind: 'dm' as const,
          id: pid,
          other_user: p,
          last_sender_id: latestMessages[pid]?.sender_id ?? null,
          last_message: latestMessages[pid]?.body || '',
          last_message_time: latestMessages[pid]?.created_at || '',
          unread: unreadCounts[pid] || 0,
          bodies: bodiesByPartner[pid] || [],
          sharedCaptions: (sharedIdsByPartner[pid] || []).map(id => captionById[id]).filter((c): c is string => !!c),
        };
      })
      .filter(Boolean) as Conversation[];

    finish(dmConvos);
  }

  // Match conversations by partner/group name, member names, OR message text.
  const q = searchQuery.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return conversations;
    return conversations.filter(c => {
      const bodyHit = c.bodies.some(b => !sharedPostId(b) && b.toLowerCase().includes(q))
        || c.sharedCaptions.some(cap => cap.toLowerCase().includes(q));
      if (c.kind === 'group') {
        return groupTitle(c.members, currentUserId, c.title).toLowerCase().includes(q)
          || c.members.some(m => (m.display_name || '').toLowerCase().includes(q) || (m.username || '').toLowerCase().includes(q))
          || bodyHit;
      }
      return (c.other_user.display_name || '').toLowerCase().includes(q)
        || (c.other_user.username || '').toLowerCase().includes(q)
        || bodyHit;
    });
  }, [conversations, q, currentUserId]);

  // Then narrow by the selected tab. Main = all (incl. groups); Friends = mutual
  // follows; Followers = one-sided. Groups aren't a single relationship, so they
  // only appear on Main.
  const tabFiltered = useMemo(() => {
    if (tab === 'friends') return filtered.filter(c => c.kind === 'dm' && friends.has(c.other_user.id));
    if (tab === 'followers') return filtered.filter(c => c.kind === 'dm' && followers.has(c.other_user.id) && !friends.has(c.other_user.id));
    return filtered;
  }, [filtered, tab, friends, followers]);

  if (loading) {
    // Same SwipeBackPager root as the loaded tree so the pager instance (and
    // its slide-in entrance) carries over when the content swaps in. Render the
    // static chrome (header + search pill + segmented tabs) so it doesn't jump
    // when content arrives, then grey pulsating conversation-row placeholders.
    return (
      <SwipeBackPager>
        <View style={styles.container}>
          <View style={[styles.header, { paddingTop: Math.max(insets.top, SPACING.md) }]}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} style={styles.backBtn} onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="chevron-back" size={26} color={colors.text} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>{t('messages.title')}</Text>
            <TouchableOpacity
              style={styles.newGroupBtn}
              onPress={() => router.push('/messages/new-group')}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityLabel={t('groups.newGroup')}
            >
              <Ionicons name="create-outline" size={24} color={colors.text} />
            </TouchableOpacity>
          </View>

          <View style={styles.searchRow}>
            <View style={styles.searchBar}>
              <Ionicons name="search-outline" size={18} color={colors.textTertiary} />
              <TextInput
                style={styles.searchInput}
                placeholder={t('messages.searchPlaceholder')}
                placeholderTextColor={colors.textSecondary}
                editable={false}
              />
            </View>
          </View>

          <View style={styles.tabRow}>
            {MSG_TABS.map((key) => {
              const active = tab === key;
              return (
                <View key={key} style={[styles.tab, active && styles.tabActive, active && isLight && styles.tabActiveLight]}>
                  <Text style={[styles.tabText, active && styles.tabTextActive, active && isLight && styles.tabTextActiveLight]}>{t(`messages.tab.${key}`)}</Text>
                </View>
              );
            })}
          </View>

          <View style={styles.list}>
            <ListRowsSkeleton rows={8} trailing={false} />
          </View>
        </View>
      </SwipeBackPager>
    );
  }

  return (
    // Swipe right anywhere to slide the whole page (header included) off and
    // reveal the screen underneath — one motion, same feel as the tab pager.
    <SwipeBackPager>
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: Math.max(insets.top, SPACING.md) }]}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} style={styles.backBtn} onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('messages.title')}</Text>
        <TouchableOpacity
          style={styles.newGroupBtn}
          onPress={() => router.push('/messages/new-group')}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityLabel={t('groups.newGroup')}
        >
          <Ionicons name="create-outline" size={24} color={colors.text} />
        </TouchableOpacity>
      </View>

      {/* Search chats by username or message text */}
      <View style={styles.searchRow}>
        <Animated.View
          style={[
            styles.searchBar,
            {
              borderColor: searchGlow.interpolate({
                inputRange: [0, 1],
                outputRange: [colors.borderStrong, SEARCH_GLOW],
              }),
              shadowColor: SEARCH_GLOW,
              shadowOpacity: searchGlow.interpolate({ inputRange: [0, 1], outputRange: [0, 0.5] }),
              shadowRadius: 10,
              shadowOffset: { width: 0, height: 0 },
            },
          ]}
        >
          <Ionicons
            name="search-outline"
            size={18}
            // The icon takes the glow too. A ring that lights up while the thing
            // inside it stays grey reads as a border effect; moving both is what
            // makes it read as the FIELD being active.
            color={searchFocused ? SEARCH_GLOW : colors.textTertiary}
          />
          <TextInput
            style={styles.searchInput}
            placeholder={t('messages.searchPlaceholder')}
            placeholderTextColor={colors.textSecondary}
            selectionColor={SEARCH_GLOW}
            value={searchQuery}
            onChangeText={setSearchQuery}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
          />
          {(searchQuery.length > 0 || searchFocused) && (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.clear')}
              onPress={() => { setSearchQuery(''); Keyboard.dismiss(); }}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              style={styles.searchClear}
            >
              <Ionicons name="close-circle" size={20} color={colors.textTertiary} />
            </TouchableOpacity>
          )}
        </Animated.View>
      </View>

      {/* Filter conversations by relationship */}
      <View style={styles.tabRow}>
        {MSG_TABS.map((key) => {
          const active = tab === key;
          return (
            <TouchableOpacity
              key={key}
              style={[styles.tab, active && styles.tabActive, active && isLight && styles.tabActiveLight]}
              onPress={() => setTab(key)}
              activeOpacity={0.85}
            >
              <Text style={[styles.tabText, active && styles.tabTextActive, active && isLight && styles.tabTextActiveLight]}>{t(`messages.tab.${key}`)}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <FlatList
        data={tabFiltered}
        style={styles.list}
        keyboardShouldPersistTaps="handled"
        keyExtractor={item => item.id}
        contentContainerStyle={styles.listContent}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
        ListEmptyComponent={
          q ? (
            <View style={styles.emptyContainer}>
              <Ionicons name="search-outline" size={64} color={colors.textTertiary} />
              <Text style={styles.emptyTitle}>{t('messages.empty.noChatsFound')}</Text>
              <Text style={styles.emptySubtitle}>{t('messages.empty.noChatsFoundSub', { query: searchQuery.trim() })}</Text>
            </View>
          ) : tab === 'friends' ? (
            <View style={styles.emptyContainer}>
              <Ionicons name="people-outline" size={64} color={colors.textTertiary} />
              <Text style={styles.emptyTitle}>{t('messages.empty.friendsTitle')}</Text>
              <Text style={styles.emptySubtitle}>{t('messages.empty.friendsSub')}</Text>
            </View>
          ) : tab === 'followers' ? (
            <View style={styles.emptyContainer}>
              <Ionicons name="person-outline" size={64} color={colors.textTertiary} />
              <Text style={styles.emptyTitle}>{t('messages.empty.followersTitle')}</Text>
              <Text style={styles.emptySubtitle}>{t('messages.empty.followersSub')}</Text>
            </View>
          ) : (
            <View style={styles.emptyContainer}>
              <Ionicons name="chatbubbles-outline" size={64} color={colors.textTertiary} />
              <Text style={styles.emptyTitle}>{t('messages.empty.title')}</Text>
              <Text style={styles.emptySubtitle}>{t('messages.empty.sub')}</Text>
            </View>
          )
        }
        renderItem={({ item }) => {
          // Group rows: clustered avatar, group name, and a "Sender: message" preview.
          if (item.kind === 'group') {
            const gUnread = item.unread > 0;
            const gTitle = groupTitle(item.members, currentUserId, item.title);
            const others = item.members.filter(m => m.id !== currentUserId);
            const sender = item.last_sender_id ? item.members.find(m => m.id === item.last_sender_id) : null;
            const senderName = item.last_sender_id === currentUserId
              ? t('groups.preview.you')
              : (sender?.display_name || sender?.username || '');
            // A rename system line shows as its own clean preview (no "Sender:").
            const renameEvt = parseRenameEvent(item.last_message);
            const gAtt = parseAttachment(item.last_message);
            const previewText = renameEvt !== null
              ? (renameEvt ? t('groups.preview.renamedTo', { name: renameEvt }) : t('groups.preview.renamedCleared'))
              : gAtt ? (gAtt.type === 'gif' ? t('messages.preview.gif') : t('messages.preview.photo'))
              : sharedPostId(item.last_message) ? t('messages.preview.sharedPost') : item.last_message;
            const gPreview = renameEvt === null && senderName && previewText ? `${senderName}: ${previewText}` : previewText;
            return (
              <Pressable
                style={({ pressed }) => [styles.conversationRow, pressed && styles.conversationRowPressed]}
                onPress={() => router.push(`/messages/group/${item.id}`)}
              >
                <View style={styles.unreadGutter}>{gUnread ? <View style={styles.unreadDot} /> : null}</View>
                <GroupAvatar avatarUrl={item.avatarUrl} members={others} size={56} />
                <View style={styles.convInfo}>
                  <View style={styles.convHeader}>
                    <View style={styles.convNameRow}>
                      <HighlightText
                        text={gTitle}
                        query={searchQuery}
                        style={[styles.displayName, gUnread && styles.displayNameUnread]}
                        highlightStyle={styles.highlight}
                        numberOfLines={1}
                      />
                    </View>
                    <Text style={[styles.timeText, gUnread && styles.timeUnread]}>{timeAgo(item.last_message_time)}</Text>
                  </View>
                  <HighlightText
                    text={gPreview}
                    query={searchQuery}
                    style={[styles.lastMessage, gUnread && styles.lastMessageUnread]}
                    highlightStyle={styles.highlight}
                    numberOfLines={2}
                  />
                </View>
              </Pressable>
            );
          }
          const unread = item.unread > 0;
          // When searching, surface whatever matched so the hit is visible:
          // a message body, then a shared-post caption, then (if only the handle
          // matched) the @username — otherwise fall back to the latest message.
          const matchMsg = matchingMessage(item, q);
          const matchCaption = !matchMsg ? matchingCaption(item, q) : null;
          const nameMatches = !!q && (item.other_user.display_name || '').toLowerCase().includes(q);
          const userMatches = !!q && (item.other_user.username || '').toLowerCase().includes(q);
          const usernamePreview = !matchMsg && !matchCaption && userMatches && !nameMatches
            ? `@${item.other_user.username}` : null;
          const showShared = !matchMsg && !matchCaption && !usernamePreview && sharedPostId(item.last_message);
          const storyReply = !matchMsg && !matchCaption && !usernamePreview && parseStoryReply(item.last_message);
          const dmAtt = !matchMsg && !matchCaption && !usernamePreview && parseAttachment(item.last_message);
          // Deliberately says only THAT an offer happened. The amount is on the card
          // inside the thread, matching the push — an inbox is read over shoulders.
          const isOffer = !matchMsg && !matchCaption && !usernamePreview && isOfferBody(item.last_message);
          // Whose offer it is changes the sentence, not just the pronoun: the buyer
          // is looking at something they did, not something that arrived.
          const offerFromMe = isOffer && !!currentUserId && item.last_sender_id === currentUserId;
          const offerPending = isOffer && unread;
          // Same reason as the offer above: never print the encoded body.
          const isStudio = !matchMsg && !matchCaption && !usernamePreview && isStudioInviteBody(item.last_message);
          const studioFromMe = isStudio && !!currentUserId && item.last_sender_id === currentUserId;
          const preview = matchMsg ?? (dmAtt ? (dmAtt.type === 'gif' ? t('messages.preview.gif') : t('messages.preview.photo')) : item.last_message);
          return (
          <Pressable
            style={({ pressed }) => [
              styles.conversationRow,
              offerPending && styles.conversationRowOffer,
              pressed && styles.conversationRowPressed,
            ]}
            onPress={() => router.push(`/messages/${item.other_user.id}`)}
          >
            <View style={styles.unreadGutter}>
              {unread ? <View style={[styles.unreadDot, offerPending && styles.unreadDotOffer]} /> : null}
            </View>
            <StoryAvatar
              userId={item.other_user.id}
              avatarUrl={item.other_user.avatar_url}
              name={item.other_user.display_name}
              size={56}
            />
            <View style={styles.convInfo}>
              <View style={styles.convHeader}>
                <View style={styles.convNameRow}>
                  <HighlightText
                    text={item.other_user.display_name}
                    query={searchQuery}
                    style={[styles.displayName, unread && styles.displayNameUnread]}
                    highlightStyle={styles.highlight}
                    numberOfLines={1}
                  />
                  <BadgeEmblem profile={item.other_user} size={13} />
                </View>
                <Text style={[styles.timeText, unread && styles.timeUnread]}>{timeAgo(item.last_message_time)}</Text>
              </View>
              {matchCaption ? (
                <View style={styles.sharedPreview}>
                  <Ionicons name="albums-outline" size={12} color={unread ? colors.text : colors.textSecondary} />
                  <HighlightText
                    text={matchCaption}
                    query={searchQuery}
                    style={[styles.lastMessage, unread && styles.lastMessageUnread]}
                    highlightStyle={styles.highlight}
                    numberOfLines={1}
                  />
                </View>
              ) : usernamePreview ? (
                <HighlightText
                  text={usernamePreview}
                  query={searchQuery}
                  style={[styles.lastMessage, unread && styles.lastMessageUnread]}
                  highlightStyle={styles.highlight}
                  numberOfLines={1}
                />
              ) : isOffer ? (
                <View style={styles.sharedPreview}>
                  <Ionicons name="pricetag" size={12} color={offerPending ? colors.success : colors.textSecondary} />
                  <Text
                    style={[styles.lastMessage, unread && styles.lastMessageUnread, offerPending && styles.lastMessageOffer]}
                    numberOfLines={1}
                  >
                    {t(offerFromMe ? 'messages.preview.offerSent' : 'messages.preview.offer')}
                  </Text>
                </View>
              ) : isStudio ? (
                <View style={styles.sharedPreview}>
                  <Ionicons name="mic" size={12} color={unread ? colors.primary : colors.textSecondary} />
                  <Text style={[styles.lastMessage, unread && styles.lastMessageUnread]} numberOfLines={1}>
                    {t(studioFromMe ? 'messages.preview.studioSent' : 'messages.preview.studio')}
                  </Text>
                </View>
              ) : storyReply ? (
                <Text style={[styles.lastMessage, unread && styles.lastMessageUnread]} numberOfLines={1}>{t('messages.preview.storyReply')}</Text>
              ) : showShared ? (
                <Text style={[styles.lastMessage, unread && styles.lastMessageUnread]} numberOfLines={1}>{t('messages.preview.sharedPost')}</Text>
              ) : (
                <HighlightText
                  text={preview}
                  query={searchQuery}
                  style={[styles.lastMessage, unread && styles.lastMessageUnread]}
                  highlightStyle={styles.highlight}
                  numberOfLines={2}
                />
              )}
            </View>
          </Pressable>
          );
        }}
      />
    </View>
    </SwipeBackPager>
  );
}

// Row geometry, in one place. These four numbers decide where the avatar sits
// AND where the separator starts; the separator was a hand-summed literal of the
// same values, which is fine until one of them moves.
//
// NOTE 56, not the 50 in `styles.avatar` — that style is vestigial, the row
// draws a StoryAvatar at 56.
// Tuned so the avatar's LEADING EDGE lands at 4+8+4 = 16pt — the same margin the
// search bar and the header use. That is the number that makes it look settled
// rather than merely closer: the column of avatars now lines up with everything
// else on the screen instead of floating in from its own inset.
// iOS system blue. Deliberately NOT the app's orange: this is a focus state, not
// a brand moment, and the orange is already doing the work of every primary
// action on the screen behind it.
const SEARCH_GLOW = '#0A84FF';

const ROW_PAD_L = SPACING.xs;   // 4
const UNREAD_GUTTER = 8;        // was 12; on a read row that is pure dead space
const DOT_GAP = SPACING.xs;     // 4 — dot → avatar
// Kept generous, and now separate: one `gap` for both meant tightening the left
// edge also squeezed the name against the face.
const TEXT_GAP = SPACING.sm + 4; // 12 — avatar → text
const AVATAR_SIZE = 56;

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  loadingContainer: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },
  list: { flex: 1 },

  // paddingTop is applied at runtime (insets.top + the same amount as paddingBottom)
  // so the title + back button sit vertically centered, evenly spaced below the notch.
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm,
    paddingBottom: SPACING.sm + 4,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  backBtn: { width: 42, alignItems: 'flex-start', justifyContent: 'center', paddingVertical: SPACING.xs },
  headerSpacer: { width: 42 }, // matches the back button's footprint → title truly centered
  newGroupBtn: { width: 42, alignItems: 'flex-end', justifyContent: 'center', paddingVertical: SPACING.xs },
  headerTitle: { color: colors.text, fontSize: 20, fontWeight: '800', letterSpacing: 0.2 },

  searchRow: { paddingHorizontal: SPACING.md, paddingTop: SPACING.md, paddingBottom: SPACING.sm + 4 },
  // OUTLINE ONLY — no fill, no shadow. The filled `surfaceElevated` panel plus a
  // drop shadow made the field read as a card sitting ON the page; against the
  // page background that panel was just a pale block with a smudge under it.
  // A hairline outline alone defines the field perfectly well and lets it sit IN
  // the page instead. The border is the only thing drawing it now, so keep it.
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: 'transparent', borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.md,
    borderWidth: 1, borderColor: colors.borderStrong,
  },
  // System font (SF Pro / Roboto — same family Instagram's search uses), tuned light
  // and lightly tracked for that clean, airy search-field look.
  searchInput: { flex: 1, paddingVertical: SPACING.sm + 3, color: colors.text, fontSize: 15, fontWeight: '400', letterSpacing: 0.2 },

  // Segmented relationship filter (Main / Friends / Followers). Equal gaps above
  // (search) and below (list) keep the stack evenly spaced.
  tabRow: {
    flexDirection: 'row',
    marginHorizontal: SPACING.md, marginBottom: SPACING.sm + 4,
    // No track. The recessed `surface` fill behind the segments was the second
    // pale block in this header; without it the selected pill carries the whole
    // job of showing which filter is on — which it already did, being the
    // highest-contrast element on the screen. Unselected segments are now plain
    // text on the page, matching the outlined search field above.
    backgroundColor: 'transparent', borderRadius: RADIUS.full, padding: 3, gap: 3,
  },
  tab: { flex: 1, paddingVertical: 9, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  // Selected segment. In dark/grey a white pill on near-black is exactly right,
  // and it stays.
  tabActive: { backgroundColor: colors.text, ...SHADOWS.sm },
  // Light mode gets the iOS segmented-control chip instead of that same rule
  // inverted, which produced a black slab — the heaviest object on a screen
  // whose whole job is to be a quiet list.
  //
  // The fill cannot carry it (surfaceElevated on this background is 1.06:1), so
  // the EDGE and the LIFT do, the way Apple's own control works: a near-white
  // chip, a defined hairline, and a soft shadow. SHADOWS.sm is 40% black, which
  // is tuned for dark grounds and reads as dirt on cream — this is 14%.
  tabActiveLight: {
    backgroundColor: colors.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderStrong,
    shadowColor: '#000', shadowOpacity: 0.14, shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 }, elevation: 2,
  },
  tabText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  tabTextActive: { color: colors.background, fontWeight: '700' },
  // Dark ink on the light chip. Selection is then carried by weight, ink and the
  // lift together rather than by one slab of black.
  tabTextActiveLight: { color: colors.text },
  searchClear: { padding: 2 },
  // Search match highlight (in usernames and message previews).
  highlight: { color: colors.primary, fontWeight: '800' },

  // flexGrow lets the list fill the viewport so pull-to-refresh can be started
  // anywhere on the screen — even when there are few or no conversations.
  listContent: { flexGrow: 1, paddingVertical: SPACING.xs },

  // iOS-style flush row — no card/border; hairline separators give the structure.
  //
  // The avatar used to start 32pt in (8 padding + a 12 gutter + a 12 gap), which
  // on a row with no unread dot — most of them — is 20pt of nothing before the
  // first thing you look at. Now 26pt, with the dot sitting 12pt from the edge
  // where iOS puts its own. Not tighter: the dot needs to clear the edge, and a
  // 50pt circle hard against the bezel reads as a rendering mistake.
  conversationRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, paddingLeft: ROW_PAD_L, paddingRight: SPACING.md,
    backgroundColor: colors.background,
  },
  // An unopened offer, highlighted green. A tint rather than a left accent bar:
  // a border would shift the avatar 3px and make the pinned row sit out of line
  // with the ones under it.
  conversationRowOffer: { backgroundColor: colors.success + '1A' },
  conversationRowPressed: { backgroundColor: colors.surfaceLight },
  // Leading unread dot — reserves its width even when read so avatars stay aligned.
  unreadGutter: { width: UNREAD_GUTTER, marginRight: DOT_GAP, alignItems: 'center', justifyContent: 'center' },
  // 8, not 9: it has to fit inside UNREAD_GUTTER rather than spill past it.
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary },
  unreadDotOffer: { backgroundColor: colors.success },
  // Hairline separator inset to the avatar's edge (iOS Messages style), computed
  // from the row's own geometry so moving the row cannot leave it behind.
  separator: {
    height: StyleSheet.hairlineWidth, backgroundColor: colors.border,
    marginLeft: ROW_PAD_L + UNREAD_GUTTER + DOT_GAP + AVATAR_SIZE,
  },
  avatar: { width: 50, height: 50, borderRadius: RADIUS.full, backgroundColor: colors.avatarBg, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.text, fontSize: 20, fontWeight: '700' },
  convInfo: { flex: 1, marginLeft: TEXT_GAP, justifyContent: 'center', gap: 3 },
  convHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: SPACING.sm },
  convNameRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 5 },
  displayName: { flexShrink: 1, color: colors.text, fontSize: 16.5, fontWeight: '600', letterSpacing: -0.2 },
  displayNameUnread: { fontWeight: '700' },
  // textSecondary, not textTertiary: tertiary measures 1.82:1 on the light
  // background, which is what made this list read as washed out. 5.68:1 now, and
  // unchanged in dark where tertiary was already fine.
  timeText: { color: colors.textSecondary, fontSize: 13 },
  timeUnread: { color: colors.primary, fontWeight: '600' },
  lastMessage: { color: colors.textSecondary, fontSize: 14, lineHeight: 19 },
  lastMessageUnread: { color: colors.text, fontWeight: '500' },
  lastMessageOffer: { color: colors.success, fontWeight: '700' },
  sharedPreview: { flexDirection: 'row', alignItems: 'center', gap: 4 },

  // Apple's own empty-state shape: a large muted glyph, a title, a line of
  // explanation, and nothing drawn around any of it. The boxed icon this
  // replaces gave the emptiest screen in the app its most decorated object.
  emptyContainer: { alignItems: 'center', paddingTop: SPACING.xxl * 1.5, gap: SPACING.sm },
  // Hierarchy the iOS way: the title carries the weight, the line under it is
  // deliberately quiet. Same size gap and the same two colours as the Music tab,
  // so the two screens read as one pattern rather than two takes on it.
  emptyTitle: { color: colors.text, fontSize: 19, fontWeight: '800', letterSpacing: -0.4, marginTop: SPACING.sm },
  emptySubtitle: { color: colors.textTertiary, fontSize: 13.5, lineHeight: 19, textAlign: 'center', maxWidth: 260 },
});
