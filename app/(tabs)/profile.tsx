import { useRouter } from 'expo-router';
import { useAudio } from '../../contexts/AudioContext';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, ActivityIndicator, Image, RefreshControl,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../../constants/theme';

type Profile = {
  id: string; username: string; display_name: string;
  bio: string | null; avatar_url: string | null; badge_tier: string; created_at: string;
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

const TABS = [
  { key: 'posts', label: 'Posts', icon: 'grid-outline' },
  { key: 'music', label: 'Music', icon: 'musical-notes-outline' },
  { key: 'videos', label: 'Videos', icon: 'videocam-outline' },
  { key: 'liked', label: 'Liked', icon: 'heart-outline' },
  { key: 'saved', label: 'Saved', icon: 'bookmark-outline' },
];

export default function ProfileScreen() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [stats, setStats] = useState<Stats>({ followers: 0, following: 0, posts: 0 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState('posts');
  const [userPosts, setUserPosts] = useState<any[]>([]);
  const [likedPosts, setLikedPosts] = useState<any[]>([]);
  const [savedPosts, setSavedPosts] = useState<any[]>([]);
  const router = useRouter();
  const { play } = useAudio();

  useEffect(() => { fetchProfile(); }, []);

  async function fetchProfile() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const [profileRes, followersRes, followingRes, postsCountRes, postsRes, likedRes, savedRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', user.id).single(),
      supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', user.id),
      supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', user.id),
      supabase.from('posts').select('*', { count: 'exact', head: true }).eq('user_id', user.id),
      supabase.from('posts').select('id, type, media_url, caption, thumbnail_url, cover_url').eq('user_id', user.id).eq('is_public', true).order('created_at', { ascending: false }),
      supabase.from('likes').select('posts(id, type, media_url, caption, thumbnail_url, cover_url)').eq('user_id', user.id).order('created_at', { ascending: false }).limit(50),
      supabase.from('saves').select('posts(id, type, media_url, caption, thumbnail_url, cover_url)').eq('user_id', user.id).order('created_at', { ascending: false }).limit(50),
    ]);

    if (profileRes.data) setProfile(profileRes.data);
    setStats({ followers: followersRes.count || 0, following: followingRes.count || 0, posts: postsCountRes.count || 0 });
    if (postsRes.data) setUserPosts(postsRes.data);
    if (likedRes.data) setLikedPosts(likedRes.data.map((l: any) => l.posts).filter(Boolean));
    if (savedRes.data) setSavedPosts(savedRes.data.map((s: any) => s.posts).filter(Boolean));
    setLoading(false);
    setRefreshing(false);
  }

  if (loading) {
    return <View style={styles.loadingContainer}><ActivityIndicator color={COLORS.primary} size="large" /></View>;
  }

  const badgeGradient = getBadgeGradient(profile?.badge_tier ?? '');

  function getGridData() {
    switch (activeTab) {
      case 'posts': return userPosts;
      case 'music': return userPosts.filter(p => p.type === 'audio');
      case 'videos': return userPosts.filter(p => p.type === 'video');
      case 'liked': return likedPosts;
      case 'saved': return savedPosts;
      default: return userPosts;
    }
  }

  const gridData = getGridData();

  return (
    <ScrollView
      style={styles.container}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchProfile(); }} tintColor={COLORS.primary} />
      }
    >
      {/* Header */}
      <View style={styles.headerBar}>
        <Text style={styles.usernameHeader}>@{profile?.username}</Text>
        <TouchableOpacity onPress={() => router.push('/settings')} style={styles.settingsBtn}>
          <Ionicons name="settings-outline" size={22} color={COLORS.textSecondary} />
        </TouchableOpacity>
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
            { label: 'Followers', val: stats.followers, onPress: () => router.push(`/followers/${profile?.id}`) },
            { label: 'Following', val: stats.following, onPress: () => router.push(`/following/${profile?.id}`) },
          ].map(({ label, val, onPress }) => (
            <TouchableOpacity key={label} style={styles.statItem} onPress={onPress} disabled={!onPress}>
              <Text style={styles.statNumber}>{val}</Text>
              <Text style={styles.statLabel}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </LinearGradient>

      {/* Name + bio */}
      <View style={styles.infoSection}>
        <Text style={styles.displayName}>{profile?.display_name}</Text>
        {profile?.bio
          ? <Text style={styles.bio}>{profile.bio}</Text>
          : <Text style={styles.bioEmpty}>No bio yet</Text>
        }
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
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsScroll}>
        <View style={styles.tabsRow}>
          {TABS.map(tab => (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tab, activeTab === tab.key && styles.activeTab]}
              onPress={() => setActiveTab(tab.key)}
            >
              <Ionicons
                name={activeTab === tab.key ? tab.icon.replace('-outline', '') as any : tab.icon as any}
                size={16}
                color={activeTab === tab.key ? COLORS.primary : COLORS.textTertiary}
              />
              <Text style={[styles.tabText, activeTab === tab.key && styles.activeTabText]}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>

      {/* Grid */}
      {gridData.length === 0 ? (
        <View style={styles.emptyGrid}>
          <Ionicons
            name={activeTab === 'liked' ? 'heart-outline' : activeTab === 'saved' ? 'bookmark-outline' : 'images-outline'}
            size={40}
            color={COLORS.textTertiary}
          />
          <Text style={styles.emptyGridText}>
            {activeTab === 'liked' ? 'No liked posts yet'
              : activeTab === 'saved' ? 'No saved posts yet'
              : `No ${activeTab} yet`}
          </Text>
        </View>
      ) : (
        <View style={styles.postsGrid}>
          {gridData.map((post: any) => (
            <TouchableOpacity
              key={post.id}
              style={styles.gridItem}
              onPress={() => post.type === 'audio'
                ? play({ id: post.id, uri: post.media_url, caption: post.caption, artist: profile?.display_name ?? '', cover: post.cover_url })
                : router.push(`/post/${post.id}`)}
            >
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
                  <Ionicons
                    name={post.type === 'audio' ? 'musical-notes' : 'videocam'}
                    size={28} color={COLORS.primary}
                  />
                </LinearGradient>
              )}
              {/* Badge for liked/saved tabs */}
              {(activeTab === 'liked' || activeTab === 'saved') && (
                <View style={styles.gridBadge}>
                  <Ionicons
                    name={activeTab === 'liked' ? 'heart' : 'bookmark'}
                    size={10} color={COLORS.text}
                  />
                </View>
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
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: SPACING.md, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.sm,
  },
  usernameHeader: { color: COLORS.text, fontSize: 17, fontWeight: '700' },
  settingsBtn: { padding: 4 },

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
  editButton: {
    flex: 1, backgroundColor: COLORS.surfaceElevated,
    borderWidth: 1, borderColor: COLORS.border,
    borderRadius: RADIUS.md, paddingVertical: SPACING.sm + 2, alignItems: 'center',
  },
  editButtonText: { color: COLORS.text, fontSize: 14, fontWeight: '600' },
  secondaryButton: {
    backgroundColor: COLORS.surfaceElevated, borderWidth: 1, borderColor: COLORS.border,
    borderRadius: RADIUS.md, paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm + 2, alignItems: 'center', justifyContent: 'center',
  },

  tabsScroll: { marginTop: SPACING.md, borderBottomWidth: 0.5, borderBottomColor: COLORS.border },
  tabsRow: { flexDirection: 'row', paddingHorizontal: SPACING.sm },
  tab: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingVertical: SPACING.sm + 2, paddingHorizontal: SPACING.sm + 4,
  },
  activeTab: { borderBottomWidth: 2, borderBottomColor: COLORS.primary },
  tabText: { color: COLORS.textTertiary, fontSize: 12, fontWeight: '500' },
  activeTabText: { color: COLORS.primary, fontWeight: '700' },

  postsGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  gridItem: { width: '33.33%', aspectRatio: 1, position: 'relative' },
  gridImage: { width: '100%', height: '100%' },
  gridPlaceholder: {
    width: '100%', height: '100%',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 0.5, borderColor: COLORS.border,
  },
  gridBadge: {
    position: 'absolute', top: 6, right: 6,
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: COLORS.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  gridPlayOverlay: {
    position: 'absolute', top: 6, left: 6,
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center',
  },
  emptyGrid: { alignItems: 'center', paddingTop: SPACING.xxl, gap: SPACING.sm },
  emptyGridText: { color: COLORS.textTertiary, fontSize: 14 },
});
