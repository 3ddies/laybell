import {
  View, Text, StyleSheet, FlatList,
  TouchableOpacity, ActivityIndicator, Image, RefreshControl,
} from 'react-native';
import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../constants/theme';
import { timeAgo } from '../lib/timeAgo';

type Notification = {
  id: string; type: 'like' | 'comment' | 'follow';
  post_id: string | null; actor_id: string; read: boolean; created_at: string;
  actor: { id: string; username: string; display_name: string; avatar_url: string | null } | null;
};

function notificationText(type: string) {
  switch (type) {
    case 'like': return 'liked your post';
    case 'comment': return 'commented on your post';
    case 'follow': return 'started following you';
    default: return 'interacted with you';
  }
}

function notificationIcon(type: string): { name: any; color: string } {
  switch (type) {
    case 'like': return { name: 'heart', color: COLORS.like };
    case 'comment': return { name: 'chatbubble', color: COLORS.primary };
    case 'follow': return { name: 'person-add', color: COLORS.primaryLight };
    default: return { name: 'notifications', color: COLORS.primary };
  }
}

export default function NotificationsScreen() {
  const router = useRouter();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => { fetchNotifications(); }, []);

  async function fetchNotifications() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data: notifData, error } = await supabase
      .from('notifications')
      .select('id, type, post_id, read, created_at, actor_id')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) console.error('notifications fetch error:', error.message);

    if (notifData && notifData.length > 0) {
      const actorIds = [...new Set(notifData.map(n => n.actor_id))];
      const { data: profileData } = await supabase
        .from('profiles').select('id, username, display_name, avatar_url').in('id', actorIds);
      const profileMap = Object.fromEntries((profileData ?? []).map(p => [p.id, p]));
      setNotifications(notifData.map(n => ({ ...n, actor: profileMap[n.actor_id] ?? null })) as any);
    } else {
      setNotifications([]);
    }

    await supabase.from('notifications').update({ read: true }).eq('user_id', user.id).eq('read', false);
    setLoading(false);
    setRefreshing(false);
  }

  function handlePress(notif: Notification) {
    if (notif.post_id) router.push(`/post/${notif.post_id}`);
    else if (notif.actor_id) router.push(`/profile/${notif.actor_id}`);
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
        <Text style={styles.headerTitle}>Notifications</Text>
        <View style={{ width: 40 }} />
      </View>

      <FlatList
        data={notifications}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchNotifications(); }} tintColor={COLORS.primary} />
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <LinearGradient colors={['#1C0A04', COLORS.background]} style={styles.emptyIconWrap}>
              <Ionicons name="notifications-outline" size={40} color={COLORS.primary} />
            </LinearGradient>
            <Text style={styles.emptyTitle}>No notifications yet</Text>
            <Text style={styles.emptySubtitle}>When someone likes, comments, or follows you — it'll show here</Text>
          </View>
        }
        renderItem={({ item }) => {
          const icon = notificationIcon(item.type);
          return (
            <TouchableOpacity
              style={[styles.notifRow, !item.read && styles.notifUnread]}
              onPress={() => handlePress(item)}
            >
              <View style={styles.avatarWrap}>
                {item.actor?.avatar_url ? (
                  <Image source={{ uri: item.actor.avatar_url }} style={styles.avatar} />
                ) : (
                  <LinearGradient colors={GRADIENTS.primary} style={styles.avatar}>
                    <Text style={styles.avatarText}>{item.actor?.display_name?.charAt(0).toUpperCase()}</Text>
                  </LinearGradient>
                )}
                <View style={[styles.iconBadge, { backgroundColor: icon.color }]}>
                  <Ionicons name={icon.name} size={10} color={COLORS.text} />
                </View>
              </View>

              <View style={styles.notifContent}>
                <Text style={styles.notifText} numberOfLines={2}>
                  <Text style={styles.notifName}>{item.actor?.display_name ?? 'Someone'}</Text>
                  {' '}{notificationText(item.type)}
                </Text>
                <Text style={styles.notifTime}>{timeAgo(item.created_at)}</Text>
              </View>

              {!item.read && <View style={styles.unreadDot} />}
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
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: COLORS.border,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: COLORS.text, fontSize: 18, fontWeight: '800' },
  listContent: { padding: SPACING.md, gap: SPACING.xs },
  notifRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: SPACING.md, paddingHorizontal: SPACING.sm, borderRadius: RADIUS.md, gap: SPACING.md },
  notifUnread: { backgroundColor: COLORS.primary + '0D' },
  avatarWrap: { position: 'relative', width: 50, height: 50 },
  avatar: { width: 50, height: 50, borderRadius: RADIUS.full, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: COLORS.text, fontSize: 18, fontWeight: '700' },
  iconBadge: { position: 'absolute', bottom: -2, right: -2, width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: COLORS.background },
  notifContent: { flex: 1 },
  notifText: { color: COLORS.textSecondary, fontSize: 14, lineHeight: 20 },
  notifName: { color: COLORS.text, fontWeight: '700' },
  notifTime: { color: COLORS.textTertiary, fontSize: 12, marginTop: 3 },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.primary },
  emptyContainer: { alignItems: 'center', paddingTop: SPACING.xxl * 2, gap: SPACING.md, paddingHorizontal: SPACING.xl },
  emptyIconWrap: { width: 90, height: 90, borderRadius: RADIUS.xl + 8, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { color: COLORS.text, fontSize: 20, fontWeight: '800' },
  emptySubtitle: { color: COLORS.textSecondary, fontSize: 14, textAlign: 'center', lineHeight: 22 },
});
