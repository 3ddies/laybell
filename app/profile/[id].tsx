import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, ActivityIndicator, Image,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../../constants/theme';
import { createNotification } from '../../lib/createNotification';

type Profile = {
  id: string; username: string; display_name: string;
  bio: string | null; avatar_url: string | null; badge_tier: string;
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

export default function PublicProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [stats, setStats] = useState<Stats>({ followers: 0, following: 0, posts: 0 });
  const [posts, setPosts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isFollowing, setIsFollowing] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('posts');
  const [followLoading, setFollowLoading] = useState(false);

  useEffect(() => { setup(); }, [id]);

  async function setup() {
    const { data: { user } } = await supabase.auth.getUser();
    const currentUser = user ?? null;
    if (currentUser) setCurrentUserId(currentUser.id);

    const [profileRes, followersRes, followingRes, postsCountRes, postsRes, followCheckRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', id).single(),
      supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', id),
      supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', id),
      supabase.from('posts').select('*', { count: 'exact', head: true }).eq('user_id', id),
      supabase.from('posts').select('id, type, media_url, caption, is_public, thumbnail_url, cover_url').eq('user_id', id).order('created_at', { ascending: false }),
      currentUser
        ? supabase.from('follows').select('*').eq('follower_id', currentUser.id).eq('following_id', id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    if (profileRes.data) setProfile(profileRes.data);
    setStats({ followers: followersRes.count || 0, following: followingRes.count || 0, posts: postsCountRes.count || 0 });
    const following = !!followCheckRes.data;
    if (postsRes.data) {
      // Followers-only posts are visible to the owner and to followers; everyone else sees public only
      const canSeePrivate = following || currentUser?.id === id;
      setPosts(postsRes.data.filter((p: any) => p.is_public || canSeePrivate));
    }
    setIsFollowing(following);
    setLoading(false);
  }

  async function handleFollow() {
    if (!currentUserId || followLoading) return;
    setFollowLoading(true);

    if (isFollowing) {
      await supabase.from('follows').delete().eq('follower_id', currentUserId).eq('following_id', id);
      setIsFollowing(false);
      setStats(prev => ({ ...prev, followers: prev.followers - 1 }));
    } else {
      await supabase.from('follows').insert({ follower_id: currentUserId, following_id: id });
      createNotification({ userId: id as string, actorId: currentUserId, type: 'follow' });
      setIsFollowing(true);
      setStats(prev => ({ ...prev, followers: prev.followers + 1 }));
    }
    setFollowLoading(false);
  }

  if (loading) {
    return <View style={styles.loadingContainer}><ActivityIndicator color={COLORS.primary} size="large" /></View>;
  }

  const isOwnProfile = currentUserId === id;
  const badgeGradient = getBadgeGradient(profile?.badge_tier ?? '');
  const tabs = ['Posts', 'Music', 'Videos'];
  const filtered = posts.filter(p =>
    activeTab === 'posts' ? true :
    activeTab === 'music' ? p.type === 'audio' :
    p.type === 'video'
  );

  return (
    <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
      {/* Back */}
      <View style={styles.topBar}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={COLORS.primary} />
        </TouchableOpacity>
        <Text style={styles.usernameHeader}>@{profile?.username}</Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Banner */}
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
          {[
            { label: 'Posts', val: stats.posts, onPress: undefined },
            { label: 'Followers', val: stats.followers, onPress: () => router.push(`/followers/${id}`) },
            { label: 'Following', val: stats.following, onPress: () => router.push(`/following/${id}`) },
          ].map(({ label, val, onPress }) => (
            <TouchableOpacity key={label} style={styles.statItem} onPress={onPress} disabled={!onPress}>
              <Text style={styles.statNumber}>{val}</Text>
              <Text style={styles.statLabel}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </LinearGradient>

      {/* Info */}
      <View style={styles.infoSection}>
        <Text style={styles.displayName}>{profile?.display_name}</Text>
        {profile?.bio
          ? <Text style={styles.bio}>{profile.bio}</Text>
          : <Text style={styles.bioEmpty}>No bio yet</Text>
        }
      </View>

      {/* Follow / Message */}
      {!isOwnProfile && (
        <View style={styles.actionButtons}>
          <TouchableOpacity
            style={[styles.followButton, isFollowing && styles.followingButton]}
            onPress={handleFollow}
            disabled={followLoading}
          >
            {followLoading
              ? <ActivityIndicator color={COLORS.text} size="small" />
              : <Text style={styles.followButtonText}>{isFollowing ? 'Following' : 'Follow'}</Text>
            }
          </TouchableOpacity>
          <TouchableOpacity style={styles.messageButton} onPress={() => router.push(`/messages/${id}`)}>
            <Ionicons name="chatbubble-outline" size={18} color={COLORS.text} />
            <Text style={styles.messageButtonText}>Message</Text>
          </TouchableOpacity>
        </View>
      )}

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
              {post.type === 'image' || (post.type === 'video' && post.thumbnail_url) || (post.type === 'audio' && post.cover_url) ? (
                <>
                  <Image
                    source={{ uri: post.type === 'image' ? post.media_url : post.type === 'video' ? post.thumbnail_url : post.cover_url }}
                    style={styles.gridImage}
                    resizeMode="cover"
                  />
                  {post.type === 'video' && (
                    <View style={styles.gridPlayOverlay}>
                      <Ionicons name="play" size={14} color={COLORS.text} />
                    </View>
                  )}
                  {post.type === 'audio' && (
                    <View style={styles.gridPlayOverlay}>
                      <Ionicons name="musical-notes" size={13} color={COLORS.text} />
                    </View>
                  )}
                </>
              ) : (
                <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.gridPlaceholder}>
                  <Ionicons name={post.type === 'audio' ? 'musical-notes' : 'videocam'} size={28} color={COLORS.primary} />
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

  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm,
    paddingTop: SPACING.xxl + SPACING.sm,
    paddingBottom: SPACING.sm,
  },
  backBtn: { padding: SPACING.sm },
  usernameHeader: { color: COLORS.text, fontSize: 16, fontWeight: '700' },

  banner: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.md, gap: SPACING.lg,
  },
  avatarWrap: { alignItems: 'center', justifyContent: 'center' },
  avatarRing: { width: 88, height: 88, borderRadius: RADIUS.full, padding: 3, alignItems: 'center', justifyContent: 'center' },
  avatarImage: { width: 82, height: 82, borderRadius: RADIUS.full },
  avatarPlaceholder: { width: 82, height: 82, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: COLORS.text, fontSize: 32, fontWeight: '700' },

  statsRow: { flex: 1, flexDirection: 'row', justifyContent: 'space-around' },
  statItem: { alignItems: 'center', gap: 2 },
  statNumber: { color: COLORS.primaryLight, fontSize: 22, fontWeight: '800' },
  statLabel: { color: COLORS.textSecondary, fontSize: 12 },

  infoSection: { paddingHorizontal: SPACING.md, paddingTop: SPACING.sm, gap: 4 },
  displayName: { color: COLORS.text, fontSize: 16, fontWeight: '700' },
  bio: { color: COLORS.textSecondary, fontSize: 14, lineHeight: 20 },
  bioEmpty: { color: COLORS.textTertiary, fontSize: 14, fontStyle: 'italic' },

  actionButtons: { flexDirection: 'row', paddingHorizontal: SPACING.md, paddingTop: SPACING.md, gap: SPACING.sm },
  followButton: { flex: 1, backgroundColor: COLORS.primary, borderRadius: RADIUS.md, paddingVertical: SPACING.sm + 2, alignItems: 'center' },
  followingButton: { backgroundColor: COLORS.surfaceElevated, borderWidth: 1, borderColor: COLORS.border },
  followButtonText: { color: COLORS.text, fontSize: 14, fontWeight: '700' },
  messageButton: { flex: 1, backgroundColor: COLORS.surfaceElevated, borderWidth: 1, borderColor: COLORS.border, borderRadius: RADIUS.md, paddingVertical: SPACING.sm + 2, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 6 },
  messageButtonText: { color: COLORS.text, fontSize: 14, fontWeight: '600' },

  tabsRow: { flexDirection: 'row', marginTop: SPACING.md, borderBottomWidth: 0.5, borderBottomColor: COLORS.border },
  tab: { flex: 1, paddingVertical: SPACING.sm + 2, alignItems: 'center' },
  activeTab: { borderBottomWidth: 2, borderBottomColor: COLORS.primary },
  tabText: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '500' },
  activeTabText: { color: COLORS.text, fontWeight: '700' },

  postsGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  gridItem: { width: '33.33%', aspectRatio: 1 },
  gridImage: { width: '100%', height: '100%' },
  gridPlaceholder: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', borderWidth: 0.5, borderColor: COLORS.border },
  gridPlayOverlay: {
    position: 'absolute', top: 6, left: 6, width: 20, height: 20, borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center',
  },
  emptyGrid: { alignItems: 'center', paddingTop: SPACING.xxl, gap: SPACING.sm },
  emptyGridText: { color: COLORS.textTertiary, fontSize: 14 },
});
