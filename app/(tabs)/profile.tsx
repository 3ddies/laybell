import { useRouter } from 'expo-router';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Image,
  RefreshControl,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { COLORS, SPACING, RADIUS, GRADIENTS, SHADOWS } from '../../constants/theme';

type Profile = {
  id: string;
  username: string;
  display_name: string;
  bio: string | null;
  avatar_url: string | null;
  badge_tier: string;
  created_at: string;
};

type Stats = { followers: number; following: number; posts: number };

function getBadgeGradient(tier: string): readonly [string, string] {
  switch (tier) {
    case 'gold': return GRADIENTS.gold;
    case 'diamond': return [COLORS.diamond, '#67E8F9'];
    case 'silver': return [COLORS.silver, '#CBD5E1'];
    case 'bronze': return [COLORS.bronze, '#92400E'];
    default: return ['#333333', '#222222'];
  }
}

export default function ProfileScreen() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [stats, setStats] = useState<Stats>({ followers: 0, following: 0, posts: 0 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState('posts');
  const [userPosts, setUserPosts] = useState<any[]>([]);
  const router = useRouter();

  useEffect(() => { fetchProfile(); }, []);

  async function fetchProfile() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const [profileRes, followersRes, followingRes, postsCountRes, postsRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', user.id).single(),
      supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', user.id),
      supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', user.id),
      supabase.from('posts').select('*', { count: 'exact', head: true }).eq('user_id', user.id),
      supabase.from('posts').select('id, type, media_url, caption').eq('user_id', user.id).eq('is_public', true).order('created_at', { ascending: false }),
    ]);

    if (profileRes.data) setProfile(profileRes.data);
    setStats({ followers: followersRes.count || 0, following: followingRes.count || 0, posts: postsCountRes.count || 0 });
    if (postsRes.data) setUserPosts(postsRes.data);
    setLoading(false);
    setRefreshing(false);
  }

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color={COLORS.primary} size="large" />
      </View>
    );
  }

  const badgeGradient = getBadgeGradient(profile?.badge_tier ?? '');
  const tabs = ['Posts', 'Music', 'Videos'];
  const filtered = userPosts.filter(p =>
    activeTab === 'posts' ? true :
    activeTab === 'music' ? p.type === 'audio' :
    p.type === 'video'
  );

  return (
    <ScrollView
      style={styles.container}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchProfile(); }} tintColor={COLORS.primary} />
      }
    >
      {/* Header bar */}
      <View style={styles.headerBar}>
        <Text style={styles.usernameHeader}>@{profile?.username}</Text>
        <TouchableOpacity onPress={() => supabase.auth.signOut()}>
          <Ionicons name="log-out-outline" size={22} color={COLORS.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* Avatar + stats banner */}
      <LinearGradient colors={['#1C0A04', COLORS.background]} style={styles.banner}>
        <View style={styles.avatarWrap}>
          <LinearGradient colors={badgeGradient} style={styles.avatarRing}>
            {profile?.avatar_url ? (
              <Image source={{ uri: profile.avatar_url }} style={styles.avatarImage} />
            ) : (
              <LinearGradient colors={GRADIENTS.primary} style={styles.avatarPlaceholder}>
                <Text style={styles.avatarText}>{profile?.display_name?.charAt(0).toUpperCase()}</Text>
              </LinearGradient>
            )}
          </LinearGradient>
        </View>

        <View style={styles.statsRow}>
          {[['Posts', stats.posts], ['Followers', stats.followers], ['Following', stats.following]].map(([label, val]) => (
            <View key={label as string} style={styles.statItem}>
              <Text style={styles.statNumber}>{val}</Text>
              <Text style={styles.statLabel}>{label}</Text>
            </View>
          ))}
        </View>
      </LinearGradient>

      {/* Name + bio */}
      <View style={styles.infoSection}>
        <Text style={styles.displayName}>{profile?.display_name}</Text>
        {profile?.bio ? (
          <Text style={styles.bio}>{profile.bio}</Text>
        ) : (
          <Text style={styles.bioEmpty}>No bio yet</Text>
        )}
      </View>

      {/* Action buttons */}
      <View style={styles.actionButtons}>
        <TouchableOpacity style={styles.editButton} onPress={() => router.push('/edit-profile')}>
          <Text style={styles.editButtonText}>Edit Profile</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryButton}>
          <Ionicons name="person-add-outline" size={18} color={COLORS.text} />
        </TouchableOpacity>
      </View>

      {/* Tabs */}
      <View style={styles.tabsRow}>
        {tabs.map(tab => (
          <TouchableOpacity
            key={tab}
            style={[styles.tab, activeTab === tab.toLowerCase() && styles.activeTab]}
            onPress={() => setActiveTab(tab.toLowerCase())}
          >
            <Text style={[styles.tabText, activeTab === tab.toLowerCase() && styles.activeTabText]}>{tab}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Grid */}
      {filtered.length === 0 ? (
        <View style={styles.emptyGrid}>
          <Ionicons name="images-outline" size={40} color={COLORS.textTertiary} />
          <Text style={styles.emptyGridText}>No {activeTab} yet</Text>
        </View>
      ) : (
        <View style={styles.postsGrid}>
          {filtered.map(post => (
            <TouchableOpacity key={post.id} style={styles.gridItem} onPress={() => router.push(`/post/${post.id}`)}>
              {post.type === 'image' ? (
                <Image source={{ uri: post.media_url }} style={styles.gridImage} resizeMode="cover" />
              ) : (
                <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.gridPlaceholder}>
                  <Ionicons
                    name={post.type === 'audio' ? 'musical-notes' : 'videocam'}
                    size={28}
                    color={COLORS.primary}
                  />
                </LinearGradient>
              )}
            </TouchableOpacity>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  loadingContainer: { flex: 1, backgroundColor: COLORS.background, alignItems: 'center', justifyContent: 'center' },

  headerBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.xxl + SPACING.sm,
    paddingBottom: SPACING.sm,
  },
  usernameHeader: { color: COLORS.text, fontSize: 17, fontWeight: '700' },

  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
    gap: SPACING.lg,
  },
  avatarWrap: { alignItems: 'center', justifyContent: 'center' },
  avatarRing: {
    width: 88, height: 88, borderRadius: RADIUS.full,
    padding: 3, alignItems: 'center', justifyContent: 'center',
  },
  avatarImage: { width: 82, height: 82, borderRadius: RADIUS.full },
  avatarPlaceholder: {
    width: 82, height: 82, borderRadius: RADIUS.full,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: COLORS.text, fontSize: 32, fontWeight: '700' },

  statsRow: { flex: 1, flexDirection: 'row', justifyContent: 'space-around' },
  statItem: { alignItems: 'center', gap: 2 },
  statNumber: { color: COLORS.text, fontSize: 22, fontWeight: '800' },
  statLabel: { color: COLORS.textSecondary, fontSize: 12 },

  infoSection: { paddingHorizontal: SPACING.md, paddingTop: SPACING.sm, gap: 4 },
  displayName: { color: COLORS.text, fontSize: 16, fontWeight: '700' },
  bio: { color: COLORS.textSecondary, fontSize: 14, lineHeight: 20 },
  bioEmpty: { color: COLORS.textTertiary, fontSize: 14, fontStyle: 'italic' },

  actionButtons: {
    flexDirection: 'row',
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.md,
    gap: SPACING.sm,
  },
  editButton: {
    flex: 1,
    backgroundColor: COLORS.surfaceElevated,
    borderWidth: 1, borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.sm + 2,
    alignItems: 'center',
  },
  editButtonText: { color: COLORS.text, fontSize: 14, fontWeight: '600' },
  secondaryButton: {
    backgroundColor: COLORS.surfaceElevated,
    borderWidth: 1, borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm + 2,
    alignItems: 'center', justifyContent: 'center',
  },

  tabsRow: {
    flexDirection: 'row',
    marginTop: SPACING.md,
    borderBottomWidth: 0.5,
    borderBottomColor: COLORS.border,
  },
  tab: {
    flex: 1, paddingVertical: SPACING.sm + 2,
    alignItems: 'center',
  },
  activeTab: { borderBottomWidth: 2, borderBottomColor: COLORS.primary },
  tabText: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '500' },
  activeTabText: { color: COLORS.text, fontWeight: '700' },

  postsGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  gridItem: { width: '33.33%', aspectRatio: 1 },
  gridImage: { width: '100%', height: '100%' },
  gridPlaceholder: {
    width: '100%', height: '100%',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 0.5, borderColor: COLORS.border,
  },
  emptyGrid: { alignItems: 'center', paddingTop: SPACING.xxl, gap: SPACING.sm },
  emptyGridText: { color: COLORS.textTertiary, fontSize: 14 },
});
