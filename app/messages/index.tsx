import {
  View, Text, StyleSheet, FlatList, TextInput,
  TouchableOpacity, ActivityIndicator, Image, RefreshControl, Keyboard,
} from 'react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../../constants/theme';
import { timeAgo } from '../../lib/timeAgo';
import { sharedPostId } from '../../lib/postLinks';
import HighlightText from '../../components/HighlightText';

type Conversation = {
  id: string;
  other_user: { id: string; username: string; display_name: string; avatar_url: string | null };
  last_message: string;
  last_message_time: string;
  unread: number;
  bodies: string[]; // every message body in this convo (for keyword search)
};

// First non-shared-post message in the convo that contains the query, or null.
function matchingMessage(c: Conversation, q: string): string | null {
  if (!q) return null;
  return c.bodies.find(b => !sharedPostId(b) && b.toLowerCase().includes(q)) ?? null;
}

export default function MessagesScreen() {
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => { setup(); }, []);

  // Refresh on focus so reading a thread (which marks it read) clears the unread
  // highlight here, and any newly-received messages re-sort to the top.
  useFocusEffect(
    useCallback(() => {
      if (currentUserId) fetchConversations(currentUserId);
    }, [currentUserId])
  );

  async function onRefresh() {
    if (!currentUserId) return;
    setRefreshing(true);
    await fetchConversations(currentUserId);
    setRefreshing(false);
  }

  async function setup() {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) { setCurrentUserId(user.id); await fetchConversations(user.id); }
    setLoading(false);
  }

  async function fetchConversations(userId: string) {
    const { data } = await supabase
      .from('messages')
      .select('id, body, created_at, sender_id, receiver_id, read')
      .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
      .order('created_at', { ascending: false });

    if (!data) return;

    // `data` is newest-first, so the first message seen per partner is the latest.
    const partnerIds: string[] = [];
    const latestMessages: Record<string, any> = {};
    const unreadCounts: Record<string, number> = {};
    const bodiesByPartner: Record<string, string[]> = {};
    data.forEach(msg => {
      const partnerId = msg.sender_id === userId ? msg.receiver_id : msg.sender_id;
      if (!partnerId) return;
      if (!latestMessages[partnerId]) { partnerIds.push(partnerId); latestMessages[partnerId] = msg; }
      if (!bodiesByPartner[partnerId]) bodiesByPartner[partnerId] = [];
      if (msg.body) bodiesByPartner[partnerId].push(msg.body);
      // Count messages they sent me that I haven't read yet (read === false,
      // matching the unread-badge query elsewhere, so legacy null rows aren't counted).
      if (msg.receiver_id === userId && msg.read === false) {
        unreadCounts[partnerId] = (unreadCounts[partnerId] || 0) + 1;
      }
    });

    if (partnerIds.length === 0) { setConversations([]); return; }

    const { data: profiles } = await supabase
      .from('profiles').select('id, username, display_name, avatar_url').in('id', partnerIds);
    if (!profiles) return;

    const profileMap = Object.fromEntries(profiles.map(p => [p.id, p]));
    const convos = partnerIds
      .map(pid => {
        const p = profileMap[pid];
        if (!p) return null;
        return {
          id: pid,
          other_user: p,
          last_message: latestMessages[pid]?.body || '',
          last_message_time: latestMessages[pid]?.created_at || '',
          unread: unreadCounts[pid] || 0,
          bodies: bodiesByPartner[pid] || [],
        };
      })
      .filter(Boolean) as Conversation[];

    // Most recently interacted-with conversations first.
    convos.sort((a, b) => new Date(b.last_message_time).getTime() - new Date(a.last_message_time).getTime());
    setConversations(convos);
  }

  // Match conversations by partner name OR any message text in the thread.
  const q = searchQuery.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return conversations;
    return conversations.filter(c =>
      (c.other_user.display_name || '').toLowerCase().includes(q) ||
      (c.other_user.username || '').toLowerCase().includes(q) ||
      c.bodies.some(b => !sharedPostId(b) && b.toLowerCase().includes(q))
    );
  }, [conversations, q]);

  if (loading) {
    return <View style={styles.loadingContainer}><ActivityIndicator color={COLORS.primary} size="large" /></View>;
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={COLORS.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Messages</Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Search chats by username or message text */}
      <View style={styles.searchRow}>
        <View style={styles.searchBar}>
          <Ionicons name="search-outline" size={18} color={COLORS.textTertiary} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search names or messages..."
            placeholderTextColor={COLORS.textTertiary}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity
              onPress={() => { setSearchQuery(''); Keyboard.dismiss(); }}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              style={styles.searchClear}
            >
              <Ionicons name="close-circle" size={20} color={COLORS.textTertiary} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <FlatList
        data={filtered}
        keyboardShouldPersistTaps="handled"
        keyExtractor={item => item.id}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />
        }
        ListEmptyComponent={
          q ? (
            <View style={styles.emptyContainer}>
              <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.emptyIcon}>
                <Ionicons name="search-outline" size={32} color={COLORS.primary} />
              </LinearGradient>
              <Text style={styles.emptyTitle}>No chats found</Text>
              <Text style={styles.emptySubtitle}>No names or messages match "{searchQuery.trim()}"</Text>
            </View>
          ) : (
            <View style={styles.emptyContainer}>
              <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.emptyIcon}>
                <Ionicons name="chatbubbles-outline" size={36} color={COLORS.primary} />
              </LinearGradient>
              <Text style={styles.emptyTitle}>No messages yet</Text>
              <Text style={styles.emptySubtitle}>Visit someone's profile and tap Message to start a conversation</Text>
            </View>
          )
        }
        renderItem={({ item }) => {
          const unread = item.unread > 0;
          // When searching, prefer a matching message as the preview so the hit is visible.
          const matchMsg = matchingMessage(item, q);
          const preview = matchMsg ?? item.last_message;
          const showShared = !matchMsg && sharedPostId(item.last_message);
          return (
          <TouchableOpacity
            style={[styles.conversationRow, unread && styles.conversationRowUnread]}
            onPress={() => router.push(`/messages/${item.other_user.id}`)}
          >
            {item.other_user.avatar_url ? (
              <Image source={{ uri: item.other_user.avatar_url }} style={styles.avatar} />
            ) : (
              <LinearGradient colors={GRADIENTS.primary} style={styles.avatar}>
                <Text style={styles.avatarText}>{item.other_user.display_name?.charAt(0).toUpperCase()}</Text>
              </LinearGradient>
            )}
            <View style={styles.convInfo}>
              <View style={styles.convHeader}>
                <HighlightText
                  text={item.other_user.display_name}
                  query={searchQuery}
                  style={[styles.displayName, unread && styles.displayNameUnread]}
                  highlightStyle={styles.highlight}
                  numberOfLines={1}
                />
                <Text style={[styles.timeText, unread && styles.timeUnread]}>{timeAgo(item.last_message_time)}</Text>
              </View>
              {showShared ? (
                <View style={styles.sharedPreview}>
                  <Ionicons name="albums-outline" size={12} color={unread ? COLORS.text : COLORS.textSecondary} />
                  <Text style={[styles.lastMessage, unread && styles.lastMessageUnread]} numberOfLines={1}>Shared a post</Text>
                </View>
              ) : (
                <HighlightText
                  text={preview}
                  query={searchQuery}
                  style={[styles.lastMessage, unread && styles.lastMessageUnread]}
                  highlightStyle={styles.highlight}
                  numberOfLines={1}
                />
              )}
            </View>
            {unread ? (
              <View style={styles.unreadBadge}>
                <Text style={styles.unreadBadgeText}>{item.unread > 9 ? '9+' : item.unread}</Text>
              </View>
            ) : (
              <Ionicons name="chevron-forward" size={16} color={COLORS.textTertiary} />
            )}
          </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  loadingContainer: { flex: 1, backgroundColor: COLORS.background, alignItems: 'center', justifyContent: 'center' },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm,
    paddingTop: SPACING.xxl + SPACING.sm,
    paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: COLORS.border,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: COLORS.text, fontSize: 18, fontWeight: '800' },

  searchRow: { paddingHorizontal: SPACING.md, paddingTop: SPACING.sm },
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: COLORS.surfaceLight, borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.md,
  },
  searchInput: { flex: 1, paddingVertical: SPACING.sm + 2, color: COLORS.text, fontSize: 15 },
  searchClear: { padding: 2 },
  // Search match highlight (in usernames and message previews).
  highlight: { color: COLORS.primary, fontWeight: '800' },

  // flexGrow lets the list fill the viewport so pull-to-refresh can be started
  // anywhere on the screen — even when there are few or no conversations.
  listContent: { padding: SPACING.md, gap: SPACING.sm, flexGrow: 1 },

  conversationRow: {
    flexDirection: 'row', alignItems: 'center',
    padding: SPACING.md, backgroundColor: COLORS.surfaceLight,
    borderRadius: RADIUS.md, borderWidth: 1, borderColor: COLORS.border, gap: SPACING.md,
  },
  // Unread conversations get a subtle primary tint + accent border.
  conversationRowUnread: { backgroundColor: COLORS.primary + '14', borderColor: COLORS.primary + '66' },
  avatar: { width: 50, height: 50, borderRadius: RADIUS.full, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: COLORS.text, fontSize: 20, fontWeight: '700' },
  convInfo: { flex: 1 },
  convHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: SPACING.sm },
  displayName: { flex: 1, color: COLORS.text, fontSize: 15, fontWeight: '700' },
  displayNameUnread: { fontWeight: '800' },
  timeText: { color: COLORS.textTertiary, fontSize: 12 },
  timeUnread: { color: COLORS.primary, fontWeight: '700' },
  lastMessage: { color: COLORS.textSecondary, fontSize: 13, marginTop: 2 },
  lastMessageUnread: { color: COLORS.text, fontWeight: '600' },
  sharedPreview: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  unreadBadge: {
    minWidth: 20, height: 20, borderRadius: 10, backgroundColor: COLORS.primary,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6,
  },
  unreadBadgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },

  emptyContainer: { alignItems: 'center', paddingTop: SPACING.xxl, gap: SPACING.md },
  emptyIcon: { width: 80, height: 80, borderRadius: RADIUS.xl, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { color: COLORS.text, fontSize: 18, fontWeight: '700' },
  emptySubtitle: { color: COLORS.textSecondary, fontSize: 14, textAlign: 'center', paddingHorizontal: SPACING.xl },
});
