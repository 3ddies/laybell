import { useRouter, useFocusEffect } from 'expo-router';
import { useNavigation } from '@react-navigation/native';
import { useAudio } from '../../contexts/AudioContext';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, ActivityIndicator, Image, RefreshControl, Linking,
} from 'react-native';
import PagerView from 'react-native-pager-view';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useState, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { usePostOptions } from '../../contexts/PostOptionsContext';
import { useProfile } from '../../contexts/ProfileContext';
import { useStories } from '../../contexts/StoriesContext';
import StoryAvatar from '../../components/StoryAvatar';
import BadgeEmblem from '../../components/BadgeEmblem';
import { resolveRingColors, resolveBannerColors, rawTier } from '../../lib/badges';
import { normalizeUrl, displayUrl } from '../../lib/profileOptions';
import { isAudioPost } from '../../lib/genres';
import VideoThumb from '../../components/VideoThumb';
import ThumbStat from '../../components/ThumbStat';
import { COLORS, SPACING, RADIUS } from '../../constants/theme';

type Profile = {
  id: string; username: string; display_name: string;
  bio: string | null; avatar_url: string | null; badge_tier: string; created_at: string;
  link?: string | null;
};
type Stats = { followers: number; following: number; posts: number };

const TABS = [
  { key: 'posts', label: 'Posts', icon: 'grid-outline' },
  { key: 'music', label: 'Music', icon: 'musical-notes-outline' },
  { key: 'videos', label: 'Videos', icon: 'videocam-outline' },
  { key: 'reposts', label: 'Reposts', icon: 'repeat-outline' },
  { key: 'liked', label: 'Liked', icon: 'heart-outline' },
  { key: 'saved', label: 'Saved', icon: 'bookmark-outline' },
];
const TAB_KEYS = TABS.map(t => t.key);

export default function ProfileScreen() {
  const { show: showOptions } = usePostOptions();
  const { profile: liveProfile } = useProfile();
  const { openCamera } = useStories();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [stats, setStats] = useState<Stats>({ followers: 0, following: 0, posts: 0 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState('posts');
  const [userPosts, setUserPosts] = useState<any[]>([]);
  const [likedPosts, setLikedPosts] = useState<any[]>([]);
  const [savedPosts, setSavedPosts] = useState<any[]>([]);
  const [repostedPosts, setRepostedPosts] = useState<any[]>([]);
  const router = useRouter();
  const navigation = useNavigation();
  const { playQueue } = useAudio();

  // Sub-tabs are a single native pager: page 0 is a "go to Music" dismiss page and
  // pages 1-5 are the sub-tabs (Posts…Saved). Swiping right off Posts lands on page 0
  // and jumps to the Music main tab — one pager, no nesting or native gesture, so it
  // can't glitch or freeze (same mechanism as other users' profiles).
  const pagerRef = useRef<PagerView>(null);
  // Per-thumbnail nodes so opening a post/reel can expand out of the tapped cell.
  const gridRefs = useRef<Record<string, any>>({});

  // Refetch on focus so a post reposted elsewhere shows up in the Reposts tab.
  useFocusEffect(useCallback(() => { fetchProfile(); }, []));

  async function fetchProfile() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const [profileRes, followersRes, followingRes, postsCountRes, postsRes, likedRes, savedRes, repostsRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', user.id).single(),
      supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', user.id),
      supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', user.id),
      supabase.from('posts').select('*', { count: 'exact', head: true }).eq('user_id', user.id),
      supabase.from('posts').select('*').eq('user_id', user.id).eq('is_public', true).order('created_at', { ascending: false }),
      supabase.from('likes').select('posts(*)').eq('user_id', user.id).order('created_at', { ascending: false }).limit(50),
      supabase.from('saves').select('posts(*)').eq('user_id', user.id).order('created_at', { ascending: false }).limit(50),
      supabase.from('reposts').select('posts(*, profiles!posts_user_id_fkey(display_name))').eq('user_id', user.id).order('created_at', { ascending: false }).limit(100),
    ]);

    if (profileRes.data) setProfile(profileRes.data);
    setStats({ followers: followersRes.count || 0, following: followingRes.count || 0, posts: postsCountRes.count || 0 });
    // Archived posts (archived_at set) are hidden from the grid but kept in the
    // Archive screen. archived_at is absent pre-migration → harmless no-op.
    if (postsRes.data) setUserPosts(postsRes.data.filter((p: any) => !p.archived_at));
    if (likedRes.data) setLikedPosts(likedRes.data.map((l: any) => l.posts).filter(Boolean));
    if (savedRes.data) setSavedPosts(savedRes.data.map((s: any) => s.posts).filter(Boolean));
    // `reposts` may not be migrated yet — degrade to an empty tab if so.
    setRepostedPosts((repostsRes.data ?? []).map((r: any) => r.posts).filter(Boolean));
    setLoading(false);
    setRefreshing(false);
  }

  if (loading) {
    return <View style={styles.loadingContainer}><ActivityIndicator color={COLORS.primary} size="large" /></View>;
  }

  // Prefer the global ProfileContext copy (live tier + avatar, kept in sync after
  // edits / badge changes); fall back to this screen's own fetch on first paint.
  const badgeProfile = liveProfile ?? profile;
  const myTier = rawTier(badgeProfile);
  const ringColors = resolveRingColors(badgeProfile, myTier);
  const bannerColors = resolveBannerColors(badgeProfile, myTier);
  const avatarUrl = liveProfile?.avatar_url ?? profile?.avatar_url;

  function dataForTab(key: string) {
    switch (key) {
      case 'music': return userPosts.filter(p => p.type === 'audio');
      case 'videos': return userPosts.filter(p => p.type === 'video');
      case 'reposts': return repostedPosts;
      case 'liked': return likedPosts;
      case 'saved': return savedPosts;
      default: return userPosts; // posts
    }
  }

  function renderGrid(data: any[], tabKey: string) {
    if (data.length === 0) {
      return (
        <View style={styles.emptyGrid}>
          <Ionicons
            name={tabKey === 'liked' ? 'heart-outline' : tabKey === 'saved' ? 'bookmark-outline' : tabKey === 'reposts' ? 'repeat-outline' : 'images-outline'}
            size={40}
            color={COLORS.textTertiary}
          />
          <Text style={styles.emptyGridText}>
            {tabKey === 'liked' ? 'No liked posts yet'
              : tabKey === 'saved' ? 'No saved posts yet'
              : tabKey === 'reposts' ? 'No reposts yet'
              : `No ${tabKey} yet`}
          </Text>
        </View>
      );
    }
    return (
      <View style={styles.postsGrid}>
        {data.map((post: any) => (
          <TouchableOpacity
            key={post.id}
            ref={(n) => { if (n) gridRefs.current[post.id] = n; }}
            style={styles.gridItem}
            // Own content (Posts / Music / Videos) — long-press for edit/delete.
            // Reposts — long-press to remove the repost (via the options sheet).
            onLongPress={
              (tabKey === 'posts' || tabKey === 'music' || tabKey === 'videos')
                ? () => showOptions({
                    postId: post.id,
                    isOwn: true,
                    mediaType: post.type,
                    onEdit: () => router.push(`/edit-post/${post.id}`),
                    onDeleted: () => {
                      setUserPosts(prev => prev.filter(p => p.id !== post.id));
                      setStats(prev => ({ ...prev, posts: Math.max(0, prev.posts - 1) }));
                    },
                    onArchived: () => {
                      setUserPosts(prev => prev.filter(p => p.id !== post.id));
                      setStats(prev => ({ ...prev, posts: Math.max(0, prev.posts - 1) }));
                    },
                  })
                : tabKey === 'reposts'
                ? () => showOptions({
                    postId: post.id,
                    isOwn: false,
                    onRepostChanged: (reposted) => {
                      if (!reposted) setRepostedPosts(prev => prev.filter(p => p.id !== post.id));
                    },
                  })
                : undefined
            }
            onPress={() => {
              if (isAudioPost(post.type)) {
                const songs = data.filter((s: any) => isAudioPost(s.type));
                const idx = songs.findIndex((s: any) => s.id === post.id);
                playQueue(
                  songs.map((s: any) => ({ id: s.id, uri: s.media_url, caption: s.caption, artist: s.profiles?.display_name ?? profile?.display_name ?? '', cover: s.cover_url })),
                  Math.max(0, idx),
                );
              } else {
                const node = gridRefs.current[post.id];
                const pathname = post.type === 'video' ? '/reel/[id]' : '/post/[id]';
                const seed = JSON.stringify(post);
                if (node?.measureInWindow) {
                  node.measureInWindow((x: number, y: number, width: number, height: number) =>
                    router.push({ pathname, params: { id: post.id, post: seed, src: JSON.stringify({ x, y, width, height }) } }));
                } else {
                  router.push({ pathname, params: { id: post.id, post: seed } });
                }
              }
            }}
          >
            {post.type === 'slideshow' ? (
              <>
                <Image source={{ uri: post.thumbnail_url || post.media_url }} style={styles.gridImage} resizeMode="cover" />
                <View style={styles.gridPlayOverlay}>
                  <Ionicons name="copy" size={13} color={COLORS.text} />
                </View>
              </>
            ) : post.type === 'video' ? (
              <>
                <VideoThumb thumbnailUrl={post.thumbnail_url} mediaUrl={post.media_url} style={styles.gridImage} />
                <View style={styles.gridPlayOverlay}>
                  <Ionicons name="play" size={14} color={COLORS.text} />
                </View>
              </>
            ) : post.type === 'image' ? (
              <Image source={{ uri: post.media_url }} style={styles.gridImage} resizeMode="cover" />
            ) : isAudioPost(post.type) && post.cover_url ? (
              <>
                <Image source={{ uri: post.cover_url }} style={styles.gridImage} resizeMode="cover" />
                <View style={styles.gridPlayOverlay}>
                  <Ionicons name="musical-notes" size={13} color={COLORS.text} />
                </View>
              </>
            ) : (
              <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.gridPlaceholder}>
                <Ionicons
                  name={isAudioPost(post.type) ? 'musical-notes' : 'videocam'}
                  size={28} color={COLORS.primary}
                />
              </LinearGradient>
            )}
            {/* Badge for liked/saved tabs */}
            {(tabKey === 'liked' || tabKey === 'saved') && (
              <View style={styles.gridBadge}>
                <Ionicons
                  name={tabKey === 'liked' ? 'heart' : 'bookmark'}
                  size={10} color={COLORS.text}
                />
              </View>
            )}
            {/* View count (video) / listen count (audio) */}
            <ThumbStat type={post.type} viewCount={post.view_count} streamCount={post.stream_count} />
          </TouchableOpacity>
        ))}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header (fixed above the swipeable sub-tabs) */}
      <View style={styles.headerBar}>
        <Text style={styles.usernameHeader}>@{profile?.username}</Text>
        <TouchableOpacity onPress={() => router.push('/settings')} style={styles.settingsBtn}>
          <Ionicons name="settings-outline" size={22} color={COLORS.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* Banner — tinted by the user's chosen profile theme (gated by tier) */}
      <LinearGradient colors={bannerColors} style={styles.banner}>
        <View style={styles.avatarWrap}>
          <StoryAvatar
            userId={profile?.id}
            avatarUrl={avatarUrl}
            name={profile?.display_name}
            size={88}
            ringColorsWhenNoStory={ringColors}
            onPressProfile={openCamera}
            showAdd
            onPressAdd={openCamera}
          />
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
        <View style={styles.nameRow}>
          <Text style={styles.displayName}>{profile?.display_name}</Text>
          <BadgeEmblem profile={badgeProfile} size={17} />
        </View>
        {profile?.bio
          ? <Text style={styles.bio}>{profile.bio}</Text>
          : <Text style={styles.bioEmpty}>No bio yet</Text>
        }
        {badgeProfile?.link ? (
          <TouchableOpacity style={styles.linkRow} onPress={() => Linking.openURL(normalizeUrl(badgeProfile.link!)).catch(() => {})}>
            <Ionicons name="link-outline" size={14} color={COLORS.primary} />
            <Text style={styles.linkText} numberOfLines={1}>{displayUrl(badgeProfile.link)}</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Action buttons */}
      <View style={styles.actionButtons}>
        <TouchableOpacity style={styles.editButton} onPress={() => router.push('/edit-profile')}>
          <Text style={styles.editButtonText}>Edit Profile</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryButton} onPress={() => router.push('/friends')}>
          <Ionicons name="people-outline" size={18} color={COLORS.text} />
        </TouchableOpacity>
      </View>

      {/* Tabs — tapping drives the pager; the pager drives the active highlight */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsScroll}>
        <View style={styles.tabsRow}>
          {TABS.map((tab, i) => (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tab, activeTab === tab.key && styles.activeTab]}
              onPress={() => pagerRef.current?.setPage(i + 1)}
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

      {/* Pager — page 0 is the "go to Music" dismiss page (swipe right off Posts);
          pages 1-5 are the sub-tabs. One pager, no nesting/native gesture, so it
          can't glitch or freeze. */}
      <PagerView
        ref={pagerRef}
        style={styles.pager}
        initialPage={1}
        onPageSelected={(e) => {
          const pos = e.nativeEvent.position;
          if (pos === 0) {
            // Swiped right off Posts → the previous main tab. Reset to Posts off-screen
            // so coming back to Profile doesn't land on the dismiss page.
            (navigation as any).navigate('music');
            pagerRef.current?.setPageWithoutAnimation(1);
          } else {
            setActiveTab(TAB_KEYS[pos - 1]);
          }
        }}
      >
        <View key="dismiss" style={styles.dismissPage}>
          <Ionicons name="arrow-back" size={28} color={COLORS.textTertiary} />
        </View>
        {TABS.map(tab => (
          <View key={tab.key} style={styles.page}>
            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.pageContent}
              refreshControl={
                <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchProfile(); }} tintColor={COLORS.primary} />
              }
            >
              {renderGrid(dataForTab(tab.key), tab.key)}
            </ScrollView>
          </View>
        ))}
      </PagerView>
    </View>
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
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  displayName: { color: COLORS.text, fontSize: 16, fontWeight: '700' },
  bio: { color: COLORS.textSecondary, fontSize: 14, lineHeight: 20 },
  bioEmpty: { color: COLORS.textTertiary, fontSize: 14, fontStyle: 'italic' },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  linkText: { color: COLORS.primary, fontSize: 13, fontWeight: '600' },

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

  tabsScroll: { marginTop: SPACING.md, borderBottomWidth: 0.5, borderBottomColor: COLORS.border, flexGrow: 0 },
  tabsRow: { flexDirection: 'row', paddingHorizontal: SPACING.sm },
  tab: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingVertical: SPACING.sm + 2, paddingHorizontal: SPACING.sm + 4,
  },
  activeTab: { borderBottomWidth: 2, borderBottomColor: COLORS.primary },
  tabText: { color: COLORS.textTertiary, fontSize: 12, fontWeight: '500' },
  activeTabText: { color: COLORS.primary, fontWeight: '700' },

  pager: { flex: 1 },
  page: { flex: 1 },
  dismissPage: { flex: 1, backgroundColor: COLORS.background, alignItems: 'center', justifyContent: 'center' },
  pageContent: { paddingBottom: SPACING.xxl + 80 },

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
