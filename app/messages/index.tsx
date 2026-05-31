import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { COLORS, SPACING, RADIUS } from '../../constants/theme';

type Conversation = {
  id: string;
  other_user: {
    id: string;
    username: string;
    display_name: string;
    avatar_url: string | null;
  };
  last_message: string;
  last_message_time: string;
};

export default function MessagesScreen() {
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  useEffect(() => {
    setup();
  }, []);

  async function setup() {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      setCurrentUserId(user.id);
      await fetchConversations(user.id);
    }
    setLoading(false);
  }

  async function fetchConversations(userId: string) {
    const { data } = await supabase
      .from('messages')
      .select(`
        id,
        body,
        created_at,
        sender_id,
        receiver_id
      `)
      .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
      .order('created_at', { ascending: false });

    if (!data) return;

    // Get unique conversation partners
    const partnerIds = new Set<string>();
    const latestMessages: Record<string, any> = {};

    data.forEach(msg => {
      const partnerId = msg.sender_id === userId
        ? msg.receiver_id
        : msg.sender_id;

      if (partnerId && !partnerIds.has(partnerId)) {
        partnerIds.add(partnerId);
        latestMessages[partnerId] = msg;
      }
    });

    if (partnerIds.size === 0) {
      setLoading(false);
      return;
    }

    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url')
      .in('id', Array.from(partnerIds));

    if (profiles) {
      const convos = profiles.map(profile => ({
        id: profile.id,
        other_user: profile,
        last_message: latestMessages[profile.id]?.body || '',
        last_message_time: latestMessages[profile.id]?.created_at || '',
      }));
      setConversations(convos);
    }
  }

  function timeAgo(dateString: string) {
    const now = new Date();
    const date = new Date(dateString);
    const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
  }

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color={COLORS.primary} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.backBtn}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Messages</Text>
        <View style={{ width: 50 }} />
      </View>

      <FlatList
        data={conversations}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyIcon}>✉️</Text>
            <Text style={styles.emptyTitle}>No messages yet</Text>
            <Text style={styles.emptySubtitle}>
              Visit an artist's profile and tap Message to start a conversation
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.conversationRow}
            onPress={() => router.push(`/messages/${item.other_user.id}`)}
          >
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {item.other_user.display_name?.charAt(0).toUpperCase()}
              </Text>
            </View>
            <View style={styles.conversationInfo}>
              <View style={styles.conversationHeader}>
                <Text style={styles.displayName}>
                  {item.other_user.display_name}
                </Text>
                <Text style={styles.timeText}>
                  {timeAgo(item.last_message_time)}
                </Text>
              </View>
              <Text style={styles.lastMessage} numberOfLines={1}>
                {item.last_message}
              </Text>
            </View>
          </TouchableOpacity>
        )}
      />
    </View>
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
    fontSize: 16,
    fontWeight: '600',
  },
  headerTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: 'bold',
  },
  listContent: {
    padding: SPACING.md,
    gap: SPACING.sm,
  },
  conversationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: SPACING.md,
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: SPACING.md,
  },
  avatar: {
    width: 50,
    height: 50,
    borderRadius: RADIUS.full,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: 'bold',
  },
  conversationInfo: {
    flex: 1,
  },
  conversationHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  displayName: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '700',
  },
  timeText: {
    color: COLORS.textTertiary,
    fontSize: 12,
  },
  lastMessage: {
    color: COLORS.textSecondary,
    fontSize: 13,
    marginTop: 2,
  },
  emptyContainer: {
    alignItems: 'center',
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
    textAlign: 'center',
    paddingHorizontal: SPACING.lg,
  },
});