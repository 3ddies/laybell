import {
  View, Text, StyleSheet, FlatList,
  TouchableOpacity, ActivityIndicator, Image, RefreshControl,
} from 'react-native';
import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../../constants/theme';
import { timeAgo } from '../../lib/timeAgo';
import { sharedPostId } from '../../lib/postLinks';

type Conversation = {
  id: string;
  other_user: { id: string; username: string; display_name: string; avatar_url: string | null };
  last_message: string;
  last_message_time: string;
  unread: number;
};

export default function MessagesScreen() {
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

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
    data.forEach(msg => {
      const partnerId = msg.sender_id === userId ? msg.receiver_id : msg.sender_id;
      if (!partnerId) return;
      if (!latestMessages[partnerId]) { partnerIds.push(partnerId); latestMessages[partnerId] = msg; }
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
        };
      })
      .filter(Boolean) as Conversation[];

    // Most recently interacted-with conversations first.
    convos.sort((a, b) => new Date(b.last_message_time).getTime() - new Date(a.last_message_time).getTime());
    setConversations(convos);
  }

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

      <FlatList
        data={conversations}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.emptyIcon}>
              <Ionicons name="chatbubbles-outline" size={36} color={COLORS.primary} />
            </LinearGradient>
            <Text style={styles.emptyTitle}>No messages yet</Text>
            <Text style={styles.emptySubtitle}>Visit someone's profile and tap Message to start a conversation</Text>
          </View>
        }
        renderItem={({ item }) => {
          const unread = item.unread > 0;
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
                <Text style={[styles.displayName, unread && styles.displayNameUnread]} numberOfLines={1}>{item.other_user.display_name}</Text>
                <Text style={[styles.timeText, unread && styles.timeUnread]}>{timeAgo(item.last_message_time)}</Text>
              </View>
              {sharedPostId(item.last_message) ? (
                <View style={styles.sharedPreview}>
                  <Ionicons name="albums-outline" size={12} color={unread ? COLORS.text : COLORS.textSecondary} />
                  <Text style={[styles.lastMessage, unread && styles.lastMessageUnread]} numberOfLines={1}>Shared a post</Text>
                </View>
              ) : (
                <Text style={[styles.lastMessage, unread && styles.lastMessageUnread]} numberOfLines={1}>{item.last_message}</Text>
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
