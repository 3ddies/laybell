import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Image,
} from 'react-native';
import { useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { COLORS, SPACING, RADIUS } from '../../constants/theme';

type Profile = {
  id: string;
  username: string;
  display_name: string;
  bio: string | null;
  avatar_url: string | null;
  badge_tier: string;
};

type Stats = {
  followers: number;
  following: number;
  posts: number;
};

export default function PublicProfileScreen() {
  const { id } = useLocalSearchParams();
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [stats, setStats] = useState<Stats>({ followers: 0, following: 0, posts: 0 });
  const [posts, setPosts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isFollowing, setIsFollowing] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('posts');
  const [followLoading, setFollowLoading] = useState(false);

  useEffect(() => {
    setup();
  }, [id]);

  async function setup() {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) setCurrentUserId(user.id);

    const { data: profileData } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', id)
      .single();

    if (profileData) setProfile(profileData);

    const { count: followersCount } = await supabase
      .from('follows')
      .select('*', { count: 'exact', head: true })
      .eq('following_id', id);

    const { count: followingCount } = await supabase
      .from('follows')
      .select('*', { count: 'exact', head: true })
      .eq('follower_id', id);

    const { count: postsCount } = await supabase
      .from('posts')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', id);

    setStats({
      followers: followersCount || 0,
      following: followingCount || 0,
      posts: postsCount || 0,
    });

    const { data: postsData } = await supabase
      .from('posts')
      .select('id, type, media_url, caption')
      .eq('user_id', id)
      .eq('is_public', true)
      .order('created_at', { ascending: false });

    if (postsData) setPosts(postsData);

    if (user) {
      const { data: followData } = await supabase
        .from('follows')
        .select('*')
        .eq('follower_id', user.id)
        .eq('following_id', id)
        .single();

      setIsFollowing(!!followData);
    }

    setLoading(false);
  }

  async function handleFollow() {
    if (!currentUserId || followLoading) return;
    setFollowLoading(true);

    if (isFollowing) {
      await supabase
        .from('follows')
        .delete()
        .eq('follower_id', currentUserId)
        .eq('following_id', id);

      setIsFollowing(false);
      setStats(prev => ({ ...prev, followers: prev.followers - 1 }));
    } else {
      await supabase
        .from('follows')
        .insert({
          follower_id: currentUserId,
          following_id: id,
        });

      setIsFollowing(true);
      setStats(prev => ({ ...prev, followers: prev.followers + 1 }));
    }

    setFollowLoading(false);
  }

  function getBadgeColor() {
    switch (profile?.badge_tier) {
      case 'gold': return COLORS.gold;
      case 'silver': return COLORS.silver;
      case 'bronze': return COLORS.bronze;
      case 'diamond': return '#A5F3FC';
      default: return COLORS.border;
    }
  }

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color={COLORS.primary} />
      </View>
    );
  }

  const isOwnProfile = currentUserId === id;
  const tabs = ['Posts', 'Music', 'Videos'];

  return (
    <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>

      {/* Back Button */}
      <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
        <Text style={styles.backBtnText}>‹ Back</Text>
      </TouchableOpacity>

      {/* Header */}
      <View style={styles.headerBar}>
        <Text style={styles.username}>{'@'}{profile?.username}</Text>
      </View>

      {/* Avatar + Stats */}
      <View style={[styles.banner, { backgroundColor: getBadgeColor() + '22' }]}>
        <View style={styles.avatarPlaceholder}>
          <Text style={styles.avatarText}>
            {profile?.display_name?.charAt(0).toUpperCase()}
          </Text>
        </View>
        <View style={styles.statsRow}>
          <View style={styles.statItem}>
            <Text style={styles.statNumber}>{stats.followers}</Text>
            <Text style={styles.statLabel}>Followers</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={styles.statNumber}>{stats.following}</Text>
            <Text style={styles.statLabel}>Following</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={styles.statNumber}>{stats.posts}</Text>
            <Text style={styles.statLabel}>Posts</Text>
          </View>
        </View>
      </View>

      {/* Name + Bio */}
      <View style={styles.infoSection}>
        <Text style={styles.displayName}>{profile?.display_name}</Text>
        {profile?.bio ? (
          <Text style={styles.bio}>{profile.bio}</Text>
        ) : (
          <Text style={styles.bioEmpty}>No bio yet</Text>
        )}
      </View>

      {/* Follow Button */}
      {!isOwnProfile && (
        <View style={styles.actionButtons}>
          <TouchableOpacity
            style={[
              styles.followButton,
              isFollowing && styles.followingButton,
            ]}
            onPress={handleFollow}
            disabled={followLoading}
          >
            {followLoading ? (
              <ActivityIndicator color={COLORS.text} size="small" />
            ) : (
              <Text style={styles.followButtonText}>
                {isFollowing ? 'Following' : 'Follow'}
              </Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
  style={styles.messageButton}
  onPress={() => router.push(`/messages/${id}`)}
>
  <Text style={styles.messageButtonText}>Message</Text>
</TouchableOpacity>
        </View>
      )}

      {/* Tabs */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tabsContainer}
      >
        {tabs.map((tab) => (
          <TouchableOpacity
            key={tab}
            style={[
              styles.tab,
              activeTab === tab.toLowerCase() && styles.activeTab,
            ]}
            onPress={() => setActiveTab(tab.toLowerCase())}
          >
            <Text style={[
              styles.tabText,
              activeTab === tab.toLowerCase() && styles.activeTabText,
            ]}>
              {tab}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Posts Grid */}
      <View style={styles.tabContent}>
        {posts.length === 0 ? (
          <Text style={styles.emptyText}>No posts yet</Text>
        ) : (
          <View style={styles.postsGrid}>
            {posts
              .filter(post =>
                activeTab === 'posts' ? true :
                activeTab === 'music' ? post.type === 'audio' :
                post.type === 'video'
              )
              .map((post) => (
                <View key={post.id} style={styles.gridItem}>
                  {post.type === 'image' ? (
                    <Image
                      source={{ uri: post.media_url }}
                      style={styles.gridImage}
                      resizeMode="cover"
                    />
                  ) : (
                    <View style={styles.gridPlaceholder}>
                      <Text style={styles.gridIcon}>
                        {post.type === 'audio' ? '🎵' : '🎬'}
                      </Text>
                    </View>
                  )}
                </View>
              ))}
          </View>
        )}
      </View>

    </ScrollView>
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
  backBtn: {
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.xxl,
    paddingBottom: SPACING.sm,
  },
  backBtnText: {
    color: COLORS.primary,
    fontSize: 16,
    fontWeight: '600',
  },
  headerBar: {
    paddingHorizontal: SPACING.md,
    paddingBottom: SPACING.sm,
  },
  username: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '700',
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
    gap: SPACING.lg,
  },
  avatarPlaceholder: {
    width: 80,
    height: 80,
    borderRadius: RADIUS.full,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: COLORS.text,
    fontSize: 32,
    fontWeight: 'bold',
  },
  statsRow: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  statItem: {
    alignItems: 'center',
  },
  statNumber: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: 'bold',
  },
  statLabel: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  infoSection: {
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.sm,
    gap: SPACING.xs,
  },
  displayName: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '700',
  },
  bio: {
    color: COLORS.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  bioEmpty: {
    color: COLORS.textTertiary,
    fontSize: 14,
    fontStyle: 'italic',
  },
  actionButtons: {
    flexDirection: 'row',
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.md,
    gap: SPACING.sm,
  },
  followButton: {
    flex: 1,
    backgroundColor: COLORS.primary,
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.sm,
    alignItems: 'center',
  },
  followingButton: {
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  followButtonText: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '600',
  },
  messageButton: {
    flex: 1,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.sm,
    alignItems: 'center',
  },
  messageButtonText: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '600',
  },
  tabsContainer: {
    paddingHorizontal: SPACING.md,
    marginTop: SPACING.md,
    borderBottomWidth: 0.5,
    borderBottomColor: COLORS.border,
  },
  tab: {
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    marginRight: SPACING.sm,
  },
  activeTab: {
    borderBottomWidth: 2,
    borderBottomColor: COLORS.primary,
  },
  tabText: {
    color: COLORS.textSecondary,
    fontSize: 14,
    fontWeight: '500',
  },
  activeTabText: {
    color: COLORS.text,
    fontWeight: '700',
  },
  tabContent: {
    padding: SPACING.md,
  },
  postsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 2,
  },
  gridItem: {
    width: '32%',
    aspectRatio: 1,
  },
  gridImage: {
    width: '100%',
    height: '100%',
  },
  gridPlaceholder: {
    width: '100%',
    height: '100%',
    backgroundColor: COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gridIcon: {
    fontSize: 28,
  },
  emptyText: {
    color: COLORS.textTertiary,
    fontSize: 14,
    textAlign: 'center',
    marginTop: SPACING.xl,
  },
});