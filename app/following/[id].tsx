import {
  View, Text, StyleSheet, FlatList,
  TouchableOpacity, ActivityIndicator, Image, RefreshControl,
} from 'react-native';
import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../../constants/theme';
import StoryAvatar from '../../components/StoryAvatar';
import BadgeEmblem from '../../components/BadgeEmblem';
import FollowButton from '../../components/FollowButton';
import { useStories } from '../../contexts/StoriesContext';

type User = { id: string; username: string; display_name: string; avatar_url: string | null; badge_tier?: string | null; badge_show?: boolean | null };

export default function FollowingScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => { setup(); }, [id]);

  // Keep story rings on these avatars fresh when the screen is shown.
  const { refresh: refreshStories } = useStories();
  useFocusEffect(useCallback(() => { refreshStories(); }, [refreshStories]));

  async function onRefresh() {
    setRefreshing(true);
    await setup();
    setRefreshing(false);
  }

  async function setup() {
    // Connection state (follow / friend) is handled app-wide by FollowButton via
    // FollowContext, so this screen only needs the following list itself.
    const { data } = await supabase.from('follows')
      .select('following_id, profiles!follows_following_id_fkey(id, username, display_name, avatar_url, badge_tier, badge_show, profile_theme)')
      .eq('follower_id', id);
    if (data) setUsers(data.map((f: any) => f.profiles).filter(Boolean));
    setLoading(false);
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={COLORS.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Following</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.centered}><ActivityIndicator color={COLORS.primary} size="large" /></View>
      ) : (
        <FlatList
          data={users}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="people-outline" size={40} color={COLORS.textTertiary} />
              <Text style={styles.emptyText}>Not following anyone yet</Text>
            </View>
          }
          renderItem={({ item }) => (
            <View style={styles.userRow}>
              <TouchableOpacity style={styles.userLeft} onPress={() => router.push(`/profile/${item.id}`)}>
                <StoryAvatar
                  userId={item.id}
                  avatarUrl={item.avatar_url}
                  name={item.display_name}
                  size={46}
                />
                <View>
                  <View style={styles.nameRow}>
                    <Text style={styles.displayName}>{item.display_name}</Text>
                    <BadgeEmblem profile={item} size={13} />
                  </View>
                  <Text style={styles.username}>@{item.username}</Text>
                </View>
              </TouchableOpacity>
              <FollowButton userId={item.id} />
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: COLORS.border,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: COLORS.text, fontSize: 18, fontWeight: '800' },
  list: { padding: SPACING.md, gap: SPACING.sm, flexGrow: 1 },
  userRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: COLORS.surfaceLight, borderRadius: RADIUS.md,
    padding: SPACING.md, borderWidth: 1, borderColor: COLORS.border,
  },
  userLeft: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, flex: 1 },
  avatar: { width: 46, height: 46, borderRadius: RADIUS.full, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: COLORS.text, fontSize: 18, fontWeight: '700' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  displayName: { color: COLORS.text, fontSize: 15, fontWeight: '700' },
  username: { color: COLORS.textSecondary, fontSize: 12, marginTop: 1 },
  followBtn: { backgroundColor: COLORS.primary, borderRadius: RADIUS.full, paddingVertical: SPACING.xs + 2, paddingHorizontal: SPACING.md },
  followBtnActive: { backgroundColor: COLORS.surfaceElevated, borderWidth: 1, borderColor: COLORS.border },
  followBtnText: { color: COLORS.text, fontSize: 13, fontWeight: '700' },
  followBtnTextActive: { color: COLORS.textSecondary },
  empty: { alignItems: 'center', paddingTop: SPACING.xxl, gap: SPACING.md },
  emptyText: { color: COLORS.textTertiary, fontSize: 14 },
});
