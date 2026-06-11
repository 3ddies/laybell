import {
  View, Text, StyleSheet, FlatList,
  TouchableOpacity, ActivityIndicator, RefreshControl,
} from 'react-native';
import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { useFollow } from '../contexts/FollowContext';
import { useStories } from '../contexts/StoriesContext';
import StoryAvatar from '../components/StoryAvatar';
import BadgeEmblem from '../components/BadgeEmblem';
import FollowButton from '../components/FollowButton';
import {
  getRotatingSuggestions, loadContactHashesIfEnabled, REASON_LABEL, type SuggestedAccount,
} from '../lib/suggestions';
import { COLORS, SPACING, RADIUS } from '../constants/theme';

type Profile = { id: string; username: string; display_name: string; avatar_url: string | null; badge_tier?: string | null; badge_show?: boolean | null };

// The current user's friends (mutual follows). Below the list — once they've
// scrolled past it — a rotating "Suggested for you" section to discover more
// accounts (see getRotatingSuggestions: highest-recommended on top, auto-rotates
// the bottom 60% every few days).
export default function FriendsScreen() {
  const router = useRouter();
  const { following } = useFollow();
  const [friends, setFriends] = useState<Profile[]>([]);
  const [suggestions, setSuggestions] = useState<SuggestedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => { load(); }, []);

  // Keep story rings on these avatars fresh when the screen is shown.
  const { refresh: refreshStories } = useStories();
  useFocusEffect(useCallback(() => { refreshStories(); }, [refreshStories]));

  async function load() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); setRefreshing(false); return; }

    // Friends = mutual follows: people I follow who also follow me.
    const [outRes, inRes] = await Promise.all([
      supabase.from('follows').select('following_id').eq('follower_id', user.id),
      supabase.from('follows').select('follower_id').eq('following_id', user.id),
    ]);
    const iFollow = new Set((outRes.data ?? []).map((f: any) => f.following_id));
    const friendIds = (inRes.data ?? []).map((f: any) => f.follower_id).filter((id: string) => iFollow.has(id));

    if (friendIds.length) {
      const { data } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, badge_tier, badge_show, profile_theme')
        .in('id', friendIds);
      setFriends((data ?? []) as Profile[]);
    } else {
      setFriends([]);
    }

    // Rotating discovery feed for the footer.
    const contactHashes = await loadContactHashesIfEnabled(user.id);
    setSuggestions(await getRotatingSuggestions(user.id, { contactHashes }));

    setLoading(false);
    setRefreshing(false);
  }

  async function onRefresh() { setRefreshing(true); await load(); }

  // Drop anyone just followed so the discovery list stays fresh as they tap.
  const liveSuggestions = suggestions.filter(s => !following.has(s.id));

  const renderRow = (p: Profile, sub?: string) => (
    <View style={styles.userRow}>
      <TouchableOpacity style={styles.userLeft} onPress={() => router.push(`/profile/${p.id}`)}>
        <StoryAvatar userId={p.id} avatarUrl={p.avatar_url} name={p.display_name} size={46} />
        <View style={styles.userInfo}>
          <View style={styles.nameRow}>
            <Text style={styles.displayName} numberOfLines={1}>{p.display_name}</Text>
            <BadgeEmblem profile={p} size={13} />
          </View>
          <Text style={styles.username} numberOfLines={1}>@{p.username}</Text>
          {sub ? <Text style={styles.reason} numberOfLines={1}>{sub}</Text> : null}
        </View>
      </TouchableOpacity>
      <FollowButton userId={p.id} />
    </View>
  );

  const footer = liveSuggestions.length ? (
    <View style={styles.suggestSection}>
      <Text style={styles.sectionTitle}>Suggested for you</Text>
      {liveSuggestions.map(s => (
        <View key={s.id}>{renderRow(s, REASON_LABEL[s.reason])}</View>
      ))}
    </View>
  ) : null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={COLORS.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Friends</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.centered}><ActivityIndicator color={COLORS.primary} size="large" /></View>
      ) : (
        <FlatList
          data={friends}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />}
          ListHeaderComponent={friends.length ? <Text style={styles.sectionTitle}>Your friends</Text> : null}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="people-outline" size={40} color={COLORS.textTertiary} />
              <Text style={styles.emptyText}>No friends yet</Text>
              <Text style={styles.emptySub}>When you and someone follow each other you become friends — they'll show up here.</Text>
            </View>
          }
          renderItem={({ item }) => renderRow(item)}
          ListFooterComponent={footer}
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
  sectionTitle: {
    color: COLORS.textTertiary, fontSize: 11, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.8, paddingHorizontal: SPACING.xs, marginBottom: SPACING.xs,
  },
  userRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: COLORS.surfaceLight, borderRadius: RADIUS.md,
    padding: SPACING.md, borderWidth: 1, borderColor: COLORS.border, gap: SPACING.sm,
  },
  userLeft: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, flex: 1 },
  userInfo: { flex: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  displayName: { color: COLORS.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  username: { color: COLORS.textSecondary, fontSize: 12, marginTop: 1 },
  reason: { color: COLORS.primaryLight, fontSize: 11, fontWeight: '600', marginTop: 2 },

  // Discovery section below the friends list.
  suggestSection: { gap: SPACING.sm, marginTop: SPACING.lg },

  empty: { alignItems: 'center', paddingTop: SPACING.xxl, gap: SPACING.sm, paddingHorizontal: SPACING.xl },
  emptyText: { color: COLORS.text, fontSize: 16, fontWeight: '700' },
  emptySub: { color: COLORS.textSecondary, fontSize: 13, textAlign: 'center', lineHeight: 19 },
});
