/**
 * Requires a `notifications` table in Supabase:
 *
 * create table notifications (
 *   id uuid default gen_random_uuid() primary key,
 *   user_id uuid references profiles(id) on delete cascade,
 *   actor_id uuid references profiles(id) on delete cascade,
 *   type text not null,   -- 'like' | 'comment' | 'follow'
 *   post_id uuid references posts(id) on delete cascade,
 *   read boolean default false,
 *   created_at timestamptz default now()
 * );
 * alter table notifications enable row level security;
 * create policy "Users see own notifications" on notifications
 *   for select using (auth.uid() = user_id);
 * create policy "Authenticated can insert" on notifications
 *   for insert with check (auth.uid() = actor_id);
 */

import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  RefreshControl,
} from 'react-native';
import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { supabase } from '../lib/supabase';
import { COLORS, SPACING, RADIUS } from '../constants/theme';
import { timeAgo } from '../lib/timeAgo';

type Notification = {
  id: string;
  type: 'like' | 'comment' | 'follow';
  post_id: string | null;
  read: boolean;
  created_at: string;
  actor: {
    id: string;
    username: string;
    display_name: string;
    avatar_url: string | null;
  };
};

function notificationText(type: string) {
  switch (type) {
    case 'like': return 'liked your post';
    case 'comment': return 'commented on your post';
    case 'follow': return 'started following you';
    default: return 'interacted with you';
  }
}

function notificationIcon(type: string) {
  switch (type) {
    case 'like': return '❤️';
    case 'comment': return '💬';
    case 'follow': return '👤';
    default: return '🔔';
  }
}

export default function NotificationsScreen() {
  const router = useRouter();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    fetchNotifications();
  }, []);

  async function fetchNotifications() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data, error } = await supabase
      .from('notifications')
      .select(`
        id, type, post_id, read, created_at,
        actor:profiles!actor_id (id, username, display_name, avatar_url)
      `)
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) console.error('notifications fetch error:', error.message);
    if (data) setNotifications(data as any);

    // Mark all as read
    await supabase
      .from('notifications')
      .update({ read: true })
      .eq('user_id', user.id)
      .eq('read', false);

    setLoading(false);
    setRefreshing(false);
  }

  function handlePress(notif: Notification) {
    if (notif.post_id) {
      router.push(`/post/${notif.post_id}`);
    } else {
      router.push(`/profile/${notif.actor.id}`);
    }
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
        <Text style={styles.headerTitle}>Notifications</Text>
        <TouchableOpacity onPress={() => { setRefreshing(true); fetchNotifications(); }}>
          <Text style={styles.refreshBtn}>↻</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={notifications}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); fetchNotifications(); }}
            tintColor={COLORS.primary}
          />
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyIcon}>🔔</Text>
            <Text style={styles.emptyTitle}>No notifications yet</Text>
            <Text style={styles.emptySubtitle}>
              When someone likes, comments, or follows you, it'll show here
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            style={[styles.notifRow, !item.read && styles.notifUnread]}
            onPress={() => handlePress(item)}
          >
            <View style={styles.avatarWrap}>
              {item.actor?.avatar_url ? (
                <Image source={{ uri: item.actor.avatar_url }} style={styles.avatar} />
              ) : (
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>
                    {item.actor?.display_name?.charAt(0).toUpperCase()}
                  </Text>
                </View>
              )}
              <View style={styles.notifIconBadge}>
                <Text style={styles.notifIconText}>{notificationIcon(item.type)}</Text>
              </View>
            </View>

            <View style={styles.notifContent}>
              <Text style={styles.notifText} numberOfLines={2}>
                <Text style={styles.notifName}>{item.actor?.display_name}</Text>
                {' '}{notificationText(item.type)}
              </Text>
              <Text style={styles.notifTime}>{timeAgo(item.created_at)}</Text>
            </View>

            {!item.read && <View style={styles.unreadDot} />}
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  loadingContainer: { flex: 1, backgroundColor: COLORS.background, alignItems: 'center', justifyContent: 'center' },
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
  backBtn: { color: COLORS.primary, fontSize: 16, fontWeight: '600' },
  headerTitle: { color: COLORS.text, fontSize: 18, fontWeight: 'bold' },
  refreshBtn: { color: COLORS.primary, fontSize: 22, fontWeight: '400', paddingHorizontal: 4 },
  listContent: { padding: SPACING.md, gap: SPACING.xs },
  notifRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.sm,
    borderRadius: RADIUS.md,
    gap: SPACING.md,
  },
  notifUnread: {
    backgroundColor: COLORS.primary + '11',
  },
  avatarWrap: {
    position: 'relative',
    width: 48,
    height: 48,
  },
  avatar: {
    width: 48, height: 48, borderRadius: RADIUS.full,
    backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: COLORS.text, fontSize: 18, fontWeight: 'bold' },
  notifIconBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 20,
    height: 20,
    borderRadius: RADIUS.full,
    backgroundColor: COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  notifIconText: { fontSize: 10 },
  notifContent: { flex: 1 },
  notifText: { color: COLORS.textSecondary, fontSize: 14, lineHeight: 20 },
  notifName: { color: COLORS.text, fontWeight: '700' },
  notifTime: { color: COLORS.textTertiary, fontSize: 12, marginTop: 2 },
  unreadDot: {
    width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.primary,
  },
  emptyContainer: {
    alignItems: 'center', paddingTop: SPACING.xxl * 2, gap: SPACING.md,
  },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { color: COLORS.text, fontSize: 20, fontWeight: 'bold' },
  emptySubtitle: {
    color: COLORS.textSecondary, fontSize: 14,
    textAlign: 'center', paddingHorizontal: SPACING.xl,
  },
});
