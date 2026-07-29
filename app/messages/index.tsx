import {
  View, Text, StyleSheet, FlatList, TextInput,
  TouchableOpacity, Pressable, Image, RefreshControl, Keyboard,
} from 'react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { SPACING, RADIUS, GRADIENTS, SHADOWS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { timeAgo } from '../../lib/timeAgo';
import { sharedPostId, parseStoryReply } from '../../lib/postLinks';
import { parseAttachment } from '../../lib/attachments';
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

// First shared-post caption in the convo that contains the query, or null.
function matchingCaption(c: Conversation, q: string): string | null {
  if (!q) return null;
  return c.sharedCaptions.find(cap => cap.toLowerCase().includes(q)) ?? null;
}

export default function MessagesScreen() {
  const { colors } = useTheme();
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
      merged.sort((a, b) => new Date(b.last_message_time).getTime() - new Date(a.last_message_time).getTime());
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
                <View key={key} style={[styles.tab, active && styles.tabActive]}>
                  <Text style={[styles.tabText, active && styles.tabTextActive]}>{t(`messages.tab.${key}`)}</Text>
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
        <View style={styles.searchBar}>
          <Ionicons name="search-outline" size={18} color={colors.textTertiary} />
          <TextInput
            style={styles.searchInput}
            placeholder={t('messages.searchPlaceholder')}
            placeholderTextColor={colors.textSecondary}
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
        </View>
      </View>

      {/* Filter conversations by relationship */}
      <View style={styles.tabRow}>
        {MSG_TABS.map((key) => {
          const active = tab === key;
          return (
            <TouchableOpacity
              key={key}
              style={[styles.tab, active && styles.tabActive]}
              onPress={() => setTab(key)}
              activeOpacity={0.85}
            >
              <Text style={[styles.tabText, active && styles.tabTextActive]}>{t(`messages.tab.${key}`)}</Text>
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
              <LinearGradient colors={[colors.primary + '24', colors.primary + '12']} style={styles.emptyIcon}>
                <Ionicons name="search-outline" size={32} color={colors.primary} />
              </LinearGradient>
              <Text style={styles.emptyTitle}>{t('messages.empty.noChatsFound')}</Text>
              <Text style={styles.emptySubtitle}>{t('messages.empty.noChatsFoundSub', { query: searchQuery.trim() })}</Text>
            </View>
          ) : tab === 'friends' ? (
            <View style={styles.emptyContainer}>
              <LinearGradient colors={[colors.primary + '24', colors.primary + '12']} style={styles.emptyIcon}>
                <Ionicons name="people-outline" size={34} color={colors.primary} />
              </LinearGradient>
              <Text style={styles.emptyTitle}>{t('messages.empty.friendsTitle')}</Text>
              <Text style={styles.emptySubtitle}>{t('messages.empty.friendsSub')}</Text>
            </View>
          ) : tab === 'followers' ? (
            <View style={styles.emptyContainer}>
              <LinearGradient colors={[colors.primary + '24', colors.primary + '12']} style={styles.emptyIcon}>
                <Ionicons name="person-outline" size={34} color={colors.primary} />
              </LinearGradient>
              <Text style={styles.emptyTitle}>{t('messages.empty.followersTitle')}</Text>
              <Text style={styles.emptySubtitle}>{t('messages.empty.followersSub')}</Text>
            </View>
          ) : (
            <View style={styles.emptyContainer}>
              <LinearGradient colors={[colors.primary + '24', colors.primary + '12']} style={styles.emptyIcon}>
                <Ionicons name="chatbubbles-outline" size={36} color={colors.primary} />
              </LinearGradient>
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
          const preview = matchMsg ?? (dmAtt ? (dmAtt.type === 'gif' ? t('messages.preview.gif') : t('messages.preview.photo')) : item.last_message);
          return (
          <Pressable
            style={({ pressed }) => [styles.conversationRow, pressed && styles.conversationRowPressed]}
            onPress={() => router.push(`/messages/${item.other_user.id}`)}
          >
            <View style={styles.unreadGutter}>
              {unread ? <View style={styles.unreadDot} /> : null}
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
  // Raised, bordered pill so the search field reads as a distinct, polished element.
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.surfaceElevated, borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    ...SHADOWS.sm,
  },
  // System font (SF Pro / Roboto — same family Instagram's search uses), tuned light
  // and lightly tracked for that clean, airy search-field look.
  searchInput: { flex: 1, paddingVertical: SPACING.sm + 3, color: colors.text, fontSize: 15, fontWeight: '400', letterSpacing: 0.2 },

  // Segmented relationship filter (Main / Friends / Followers). Equal gaps above
  // (search) and below (list) keep the stack evenly spaced.
  tabRow: {
    flexDirection: 'row',
    marginHorizontal: SPACING.md, marginBottom: SPACING.sm + 4,
    // Recessed track (a touch darker than the raised selected pill) so the
    // segmented control reads correctly in every theme.
    backgroundColor: colors.surface, borderRadius: RADIUS.full, padding: 3, gap: 3,
  },
  tab: { flex: 1, paddingVertical: 9, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  // Selected segment: a high-contrast pill — white with black text in dark/grey,
  // black with white text in light (colors.text fill + colors.background text).
  tabActive: { backgroundColor: colors.text, ...SHADOWS.sm },
  tabText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  tabTextActive: { color: colors.background, fontWeight: '700' },
  searchClear: { padding: 2 },
  // Search match highlight (in usernames and message previews).
  highlight: { color: colors.primary, fontWeight: '800' },

  // flexGrow lets the list fill the viewport so pull-to-refresh can be started
  // anywhere on the screen — even when there are few or no conversations.
  listContent: { flexGrow: 1, paddingVertical: SPACING.xs },

  // iOS-style flush row — no card/border; hairline separators give the structure.
  conversationRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, paddingLeft: SPACING.sm, paddingRight: SPACING.md,
    gap: SPACING.sm + 4, backgroundColor: colors.background,
  },
  conversationRowPressed: { backgroundColor: colors.surfaceLight },
  // Leading unread dot — reserves its width even when read so avatars stay aligned.
  unreadGutter: { width: 12, alignItems: 'center', justifyContent: 'center' },
  unreadDot: { width: 9, height: 9, borderRadius: 4.5, backgroundColor: colors.primary },
  // Hairline separator inset to the avatar's edge (iOS Messages style).
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: SPACING.sm + 12 + (SPACING.sm + 4) + 56 },
  avatar: { width: 50, height: 50, borderRadius: RADIUS.full, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.text, fontSize: 20, fontWeight: '700' },
  convInfo: { flex: 1, justifyContent: 'center', gap: 3 },
  convHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: SPACING.sm },
  convNameRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 5 },
  displayName: { flexShrink: 1, color: colors.text, fontSize: 16, fontWeight: '600' },
  displayNameUnread: { fontWeight: '700' },
  timeText: { color: colors.textTertiary, fontSize: 13 },
  timeUnread: { color: colors.primary, fontWeight: '600' },
  lastMessage: { color: colors.textSecondary, fontSize: 14, lineHeight: 19 },
  lastMessageUnread: { color: colors.text, fontWeight: '500' },
  sharedPreview: { flexDirection: 'row', alignItems: 'center', gap: 4 },

  emptyContainer: { alignItems: 'center', paddingTop: SPACING.xxl, gap: SPACING.md },
  emptyIcon: { width: 80, height: 80, borderRadius: RADIUS.xl, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '700' },
  emptySubtitle: { color: colors.textSecondary, fontSize: 14, textAlign: 'center', paddingHorizontal: SPACING.xl },
});
