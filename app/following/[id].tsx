import {
  View, Text, StyleSheet, FlatList,
  TouchableOpacity, ActivityIndicator, Image, RefreshControl,
} from 'react-native';
import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import StoryAvatar from '../../components/StoryAvatar';
import BadgeEmblem from '../../components/BadgeEmblem';
import FollowButton from '../../components/FollowButton';
import { maskHiddenProfile } from '../../lib/hiddenProfile';
import { useStories } from '../../contexts/StoriesContext';

type User = { id: string; username: string; display_name: string; avatar_url: string | null; badge_tier?: string | null; badge_show?: boolean | null };

export default function FollowingScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
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
      .select('following_id, profiles!follows_following_id_fkey(id, username, display_name, avatar_url, badge_tier, badge_show, profile_theme, hidden)')
      .eq('follower_id', id);
    const { data: { user } } = await supabase.auth.getUser();
    // Hidden accounts stay in the list but read as "Hidden account" (own row stays real).
    if (data) setUsers(data.map((f: any) => maskHiddenProfile(f.profiles, f.profiles?.id === user?.id)).filter(Boolean));
    setLoading(false);
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Following</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.centered}><ActivityIndicator color={colors.primary} size="large" /></View>
      ) : (
        <FlatList
          data={users}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="people-outline" size={40} color={colors.textTertiary} />
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
                  {!!item.username && <Text style={styles.username}>@{item.username}</Text>}
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

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  list: { padding: SPACING.md, gap: SPACING.sm, flexGrow: 1 },
  userRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.md,
    padding: SPACING.md, borderWidth: 1, borderColor: colors.border,
  },
  userLeft: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, flex: 1 },
  avatar: { width: 46, height: 46, borderRadius: RADIUS.full, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.text, fontSize: 18, fontWeight: '700' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  displayName: { color: colors.text, fontSize: 15, fontWeight: '700' },
  username: { color: colors.textSecondary, fontSize: 12, marginTop: 1 },
  followBtn: { backgroundColor: colors.primary, borderRadius: RADIUS.full, paddingVertical: SPACING.xs + 2, paddingHorizontal: SPACING.md },
  followBtnActive: { backgroundColor: colors.surfaceElevated, borderWidth: 1, borderColor: colors.border },
  followBtnText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  followBtnTextActive: { color: colors.textSecondary },
  empty: { alignItems: 'center', paddingTop: SPACING.xxl, gap: SPACING.md },
  emptyText: { color: colors.textTertiary, fontSize: 14 },
});
