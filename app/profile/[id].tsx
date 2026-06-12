import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, ActivityIndicator, Image, RefreshControl, Linking,
} from 'react-native';
import PagerView from 'react-native-pager-view';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState, useRef } from 'react';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useAudio } from '../../contexts/AudioContext';
import { supabase } from '../../lib/supabase';
import { SPACING, RADIUS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import VideoThumb from '../../components/VideoThumb';
import ThumbStat from '../../components/ThumbStat';
import StoryAvatar from '../../components/StoryAvatar';
import BadgeEmblem from '../../components/BadgeEmblem';
import { resolveRingColors, resolveBannerColors, chosenTier, specialRingTier, rawTier } from '../../lib/badges';
import { activePublicIds, fetchFirstTrackCovers } from '../../lib/playlists';
import { formatCount } from '../../lib/format';
import { normalizeUrl, displayUrl } from '../../lib/profileOptions';
import { createNotification } from '../../lib/createNotification';
import { usePostOptions } from '../../contexts/PostOptionsContext';

type Profile = {
  id: string; username: string; display_name: string;
  bio: string | null; avatar_url: string | null; badge_tier: string;
  link?: string | null;
};
type Stats = { followers: number; following: number; posts: number };

const TABS = [
  { key: 'posts', label: 'Posts' },
  { key: 'music', label: 'Music' },
  { key: 'videos', label: 'Videos' },
  { key: 'reposts', label: 'Reposts' },
  { key: 'playlists', label: 'Playlists' },
];
const TAB_KEYS = TABS.map(t => t.key);

export default function PublicProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { playQueue } = useAudio();
  const { show: showOptions } = usePostOptions();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [stats, setStats] = useState<Stats>({ followers: 0, following: 0, posts: 0 });
  const [posts, setPosts] = useState<any[]>([]);
  const [reposts, setReposts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isFollowing, setIsFollowing] = useState(false);
  const [followsMe, setFollowsMe] = useState(false); // does this profile follow me back?
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('posts');
  const [followLoading, setFollowLoading] = useState(false);
  // This user's ACTIVE public playlists (locked over-limit ones stay hidden).
  const [publicPlaylists, setPublicPlaylists] = useState<any[]>([]);

  // Sub-tabs are pages in a native pager — swiping slides the next grid in under
  // your finger, matching the rest of the app.
  const pagerRef = useRef<PagerView>(null);
  // Per-thumbnail nodes so opening a post/reel can expand out of the tapped cell.
  const gridRefs = useRef<Record<string, any>>({});

  useEffect(() => { setup(); }, [id]);

  async function setup() {
    const { data: { user } } = await supabase.auth.getUser();
    const currentUser = user ?? null;
    if (currentUser) setCurrentUserId(currentUser.id);

    const [profileRes, followersRes, followingRes, postsCountRes, postsRes, followCheckRes, followsMeRes, repostsRes, playlistsRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', id).single(),
      supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', id),
      supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', id),
      supabase.from('posts').select('*', { count: 'exact', head: true }).eq('user_id', id),
      supabase.from('posts').select('*').eq('user_id', id).order('created_at', { ascending: false }),
      currentUser
        ? supabase.from('follows').select('*').eq('follower_id', currentUser.id).eq('following_id', id).maybeSingle()
        : Promise.resolve({ data: null }),
      currentUser
        ? supabase.from('follows').select('*').eq('follower_id', id).eq('following_id', currentUser.id).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase.from('reposts').select('created_at, posts(id, type, media_url, caption, is_public, thumbnail_url, cover_url, profiles!posts_user_id_fkey(display_name))').eq('user_id', id).order('created_at', { ascending: false }).limit(100),
      supabase.from('playlists').select('*').eq('user_id', id).eq('is_public', true).order('play_count', { ascending: false }),
    ]);

    if (profileRes.data) setProfile(profileRes.data);
    setStats({ followers: followersRes.count || 0, following: followingRes.count || 0, posts: postsCountRes.count || 0 });
    const following = !!followCheckRes.data;
    const followsMeNow = !!followsMeRes.data;
    if (postsRes.data) {
      // Private ("friends only") posts are visible to the owner and to FRIENDS
      // (mutual follows); everyone else — including one-directional followers —
      // sees public only. Archived posts (archived_at set) are hidden too.
      const isFriend = following && followsMeNow;
      const canSeePrivate = isFriend || currentUser?.id === id;
      setPosts(postsRes.data.filter((p: any) => (p.is_public || canSeePrivate) && !p.archived_at));
    }
    // Reposts are public — only surface the reposted posts that are themselves
    // public (so a private post can't leak through someone else's repost).
    setReposts((repostsRes.data ?? []).map((r: any) => r.posts).filter((p: any) => p && p.is_public));
    // Public playlists showcase: only those holding an active badge slot,
    // faced with their first track's cover. Degrades to empty pre-migration.
    try {
      const pls = playlistsRes.data ?? [];
      const active = activePublicIds(pls as any, rawTier(profileRes.data));
      const shown = pls.filter((p: any) => active.has(p.id));
      const covers = await fetchFirstTrackCovers(shown.map((p: any) => p.id));
      setPublicPlaylists(shown.map((p: any) => ({ ...p, cover: covers[p.id] ?? null })));
    } catch { setPublicPlaylists([]); }
    setIsFollowing(following);
    setFollowsMe(followsMeNow);
    setLoading(false);
    setRefreshing(false);
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
      // If they already follow me, following back makes us friends → notify as such.
      createNotification({ userId: id as string, actorId: currentUserId, type: followsMe ? 'friend' : 'follow' });
      setIsFollowing(true);
      setStats(prev => ({ ...prev, followers: prev.followers + 1 }));
    }
    setFollowLoading(false);
  }

  if (loading) {
    return <View style={styles.loadingContainer}><ActivityIndicator color={colors.primary} size="large" /></View>;
  }

  const isOwnProfile = currentUserId === id;
  const isFriend = isFollowing && followsMe;
  const followLabel = isFriend ? 'Friends' : isFollowing ? 'Following' : followsMe ? 'Follow back' : 'Follow';
  const ownerTier = chosenTier(profile);
  const ringColors = resolveRingColors(profile, ownerTier);
  const bannerColors = resolveBannerColors(ownerTier, colors.background);
  // Active tab underline + text + glow take the owner's emblem-theme color, so
  // visitors see the owner's tier color on their profile too.
  const tabAccent = ownerTier ? ringColors[0] : colors.primary;
  const activeTabDyn = {
    borderBottomColor: tabAccent,
    shadowColor: tabAccent, shadowOpacity: 0.3, shadowRadius: 2.5, shadowOffset: { width: 0, height: 1 }, elevation: 1,
  };

  function dataForTab(key: string) {
    switch (key) {
      case 'music': return posts.filter((p: any) => p.type === 'audio');
      case 'videos': return posts.filter((p: any) => p.type === 'video');
      case 'reposts': return reposts;
      default: return posts; // posts
    }
  }

  function renderPlaylists() {
    if (publicPlaylists.length === 0) {
      return (
        <View style={styles.emptyGrid}>
          <Ionicons name="albums-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyGridText}>No public playlists yet</Text>
        </View>
      );
    }
    return (
      <View style={styles.plGrid}>
        {publicPlaylists.map((pl: any) => (
          <TouchableOpacity key={pl.id} style={styles.plCard} activeOpacity={0.8} onPress={() => router.push(`/playlist/${pl.id}`)}>
            {pl.cover ? (
              <Image source={{ uri: pl.cover }} style={styles.plCover} />
            ) : (
              <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.plCover}>
                <Ionicons name="musical-notes" size={26} color={colors.primary} />
              </LinearGradient>
            )}
            <Text style={styles.plName} numberOfLines={1}>{pl.name}</Text>
            <View style={styles.plMetaRow}>
              <Ionicons name="headset" size={11} color={colors.textTertiary} />
              <Text style={styles.plMeta}>{formatCount(pl.play_count ?? 0)} {pl.play_count === 1 ? 'listen' : 'listens'}</Text>
            </View>
          </TouchableOpacity>
        ))}
      </View>
    );
  }

  function renderGrid(data: any[], tabKey: string) {
    if (data.length === 0) {
      return (
        <View style={styles.emptyGrid}>
          <Ionicons name="images-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyGridText}>No {tabKey} yet</Text>
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
            onPress={() => {
              if (post.type === 'audio') {
                const songs = data.filter((s: any) => s.type === 'audio');
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
                  <Ionicons name="copy" size={13} color={colors.text} />
                </View>
              </>
            ) : post.type === 'video' ? (
              <>
                <VideoThumb thumbnailUrl={post.thumbnail_url} mediaUrl={post.media_url} style={styles.gridImage} />
                <View style={styles.gridPlayOverlay}>
                  <Ionicons name="play" size={14} color={colors.text} />
                </View>
              </>
            ) : post.type === 'image' ? (
              <Image source={{ uri: post.media_url }} style={styles.gridImage} resizeMode="cover" />
            ) : post.type === 'audio' && post.cover_url ? (
              <>
                <Image source={{ uri: post.cover_url }} style={styles.gridImage} resizeMode="cover" />
                <View style={styles.gridPlayOverlay}>
                  <Ionicons name="musical-notes" size={13} color={colors.text} />
                </View>
              </>
            ) : (
              <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.gridPlaceholder}>
                <Ionicons name={post.type === 'audio' ? 'musical-notes' : 'videocam'} size={28} color={colors.primary} />
              </LinearGradient>
            )}
            <ThumbStat type={post.type} viewCount={post.view_count} streamCount={post.stream_count} />
          </TouchableOpacity>
        ))}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* No native back-swipe — the pager's leading dismiss page (below) + the back
          button handle going back, so nothing competes with the sub-tab swipes. */}
      <Stack.Screen options={{ gestureEnabled: false }} />

      {/* Back */}
      <View style={styles.topBar}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.primary} />
        </TouchableOpacity>
        <Text style={styles.usernameHeader}>@{profile?.username}</Text>
        {!isOwnProfile ? (
          <TouchableOpacity
            style={styles.backBtn}
            onPress={() => showOptions({
              isOwn: false,
              authorId: id as string,
              authorName: profile?.username,
              onBlocked: () => router.back(),
            })}
          >
            <Ionicons name="ellipsis-horizontal" size={22} color={colors.textSecondary} />
          </TouchableOpacity>
        ) : (
          <View style={{ width: 40 }} />
        )}
      </View>

      {/* Banner — tinted by the owner's chosen profile theme (gated by their tier) */}
      <LinearGradient colors={bannerColors} style={styles.banner}>
        <View style={styles.avatarWrap}>
          <StoryAvatar
            userId={profile?.id ?? id}
            avatarUrl={profile?.avatar_url}
            name={profile?.display_name}
            size={88}
            badgeRing={specialRingTier(ownerTier) ? ringColors : undefined}
          />
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
        <View style={styles.nameRow}>
          <Text style={styles.displayName}>{profile?.display_name}</Text>
          <BadgeEmblem profile={profile} size={17} />
        </View>
        {profile?.bio
          ? <Text style={styles.bio}>{profile.bio}</Text>
          : <Text style={styles.bioEmpty}>No bio yet</Text>
        }
        {profile?.link ? (
          <TouchableOpacity style={styles.linkRow} onPress={() => Linking.openURL(normalizeUrl(profile.link!)).catch(() => {})}>
            <Ionicons name="link-outline" size={14} color={colors.primary} />
            <Text style={styles.linkText} numberOfLines={1}>{displayUrl(profile.link)}</Text>
          </TouchableOpacity>
        ) : null}
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
              ? <ActivityIndicator color={colors.text} size="small" />
              : (
                <View style={styles.followBtnInner}>
                  {isFriend && <Ionicons name="people" size={15} color={colors.text} />}
                  <Text style={styles.followButtonText}>{followLabel}</Text>
                </View>
              )
            }
          </TouchableOpacity>
          <TouchableOpacity style={styles.messageButton} onPress={() => router.push(`/messages/${id}`)}>
            <Ionicons name="chatbubble-outline" size={18} color={colors.text} />
            <Text style={styles.messageButtonText}>Message</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Tabs — tapping drives the pager; the pager drives the active highlight */}
      <View style={styles.tabsRow}>
        {TABS.map((tab, i) => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, activeTab === tab.key && styles.activeTab, activeTab === tab.key && activeTabDyn]}
            onPress={() => pagerRef.current?.setPage(i + 1)}
          >
            <Text style={[styles.tabText, activeTab === tab.key && styles.activeTabText, activeTab === tab.key && { color: tabAccent }]}>{tab.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Pager — page 0 is the back/dismiss page (swipe right off Posts to go back);
          pages 1-3 are the sub-tabs. ONE pager, no nesting and no native gesture, so
          there's nothing to fight: it can't glitch or freeze. */}
      <PagerView
        ref={pagerRef}
        style={styles.pager}
        initialPage={1}
        onPageSelected={(e) => {
          const pos = e.nativeEvent.position;
          if (pos === 0) {
            // Swiped onto the dismiss page → go back. If there's no history to pop
            // (e.g. cold-start deep link straight to this profile), snap back to
            // Posts instead of stranding the user on the blank dismiss page.
            if (router.canGoBack()) router.back();
            else pagerRef.current?.setPageWithoutAnimation(1);
          } else {
            setActiveTab(TAB_KEYS[pos - 1]);
          }
        }}
      >
        <View key="dismiss" style={styles.dismissPage}>
          <Ionicons name="arrow-back" size={28} color={colors.textTertiary} />
        </View>
        {TABS.map(tab => (
          <View key={tab.key} style={styles.page}>
            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.pageContent}
              refreshControl={
                <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); setup(); }} tintColor={tabAccent} colors={[tabAccent]} />
              }
            >
              {tab.key === 'playlists' ? renderPlaylists() : renderGrid(dataForTab(tab.key), tab.key)}
            </ScrollView>
          </View>
        ))}
      </PagerView>
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  dismissPage: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },
  loadingContainer: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },

  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm,
    paddingTop: SPACING.xxl + SPACING.sm,
    paddingBottom: SPACING.sm,
  },
  backBtn: { padding: SPACING.sm },
  usernameHeader: { color: colors.text, fontSize: 16, fontWeight: '700' },

  banner: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.md, gap: SPACING.lg,
  },
  avatarWrap: { alignItems: 'center', justifyContent: 'center' },
  avatarRing: { width: 88, height: 88, borderRadius: RADIUS.full, padding: 3, alignItems: 'center', justifyContent: 'center' },
  avatarImage: { width: 82, height: 82, borderRadius: RADIUS.full },
  avatarPlaceholder: { width: 82, height: 82, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.text, fontSize: 32, fontWeight: '700' },

  statsRow: { flex: 1, flexDirection: 'row', justifyContent: 'space-around' },
  statItem: { alignItems: 'center', gap: 2 },
  statNumber: { color: colors.primaryLight, fontSize: 22, fontWeight: '800' },
  statLabel: { color: colors.textSecondary, fontSize: 12 },

  infoSection: { paddingHorizontal: SPACING.md, paddingTop: SPACING.sm, gap: 4 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  displayName: { color: colors.text, fontSize: 16, fontWeight: '700' },
  bio: { color: colors.textSecondary, fontSize: 14, lineHeight: 20 },
  bioEmpty: { color: colors.textTertiary, fontSize: 14, fontStyle: 'italic' },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  linkText: { color: colors.primary, fontSize: 13, fontWeight: '600' },

  actionButtons: { flexDirection: 'row', paddingHorizontal: SPACING.md, paddingTop: SPACING.md, gap: SPACING.sm },
  followButton: { flex: 1, backgroundColor: colors.primary, borderRadius: RADIUS.md, paddingVertical: SPACING.sm + 2, alignItems: 'center' },
  followingButton: { backgroundColor: colors.surfaceElevated, borderWidth: 1, borderColor: colors.border },
  followBtnInner: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  followButtonText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  messageButton: { flex: 1, backgroundColor: colors.surfaceElevated, borderWidth: 1, borderColor: colors.border, borderRadius: RADIUS.md, paddingVertical: SPACING.sm + 2, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 6 },
  messageButtonText: { color: colors.text, fontSize: 14, fontWeight: '600' },

  tabsRow: { flexDirection: 'row', marginTop: SPACING.md, borderBottomWidth: 0.5, borderBottomColor: colors.border },
  tab: { flex: 1, paddingVertical: SPACING.sm + 2, alignItems: 'center' },
  activeTab: { borderBottomWidth: 2, borderBottomColor: colors.primary },
  tabText: { color: colors.textSecondary, fontSize: 13, fontWeight: '500' },
  activeTabText: { color: colors.text, fontWeight: '700' },

  pager: { flex: 1 },
  page: { flex: 1 },
  pageContent: { paddingBottom: SPACING.xxl + 60 },

  postsGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  gridItem: { width: '33.33%', aspectRatio: 1 },
  gridImage: { width: '100%', height: '100%' },
  gridPlaceholder: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', borderWidth: 0.5, borderColor: colors.border },
  gridPlayOverlay: {
    position: 'absolute', top: 6, left: 6, width: 20, height: 20, borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center',
  },
  emptyGrid: { alignItems: 'center', paddingTop: SPACING.xxl, gap: SPACING.sm },
  emptyGridText: { color: colors.textTertiary, fontSize: 14 },

  // Public playlists tab — 2-up showcase cards (cover, name, listens).
  plGrid: {
    flexDirection: 'row', flexWrap: 'wrap',
    paddingHorizontal: SPACING.md, paddingTop: SPACING.md,
    columnGap: SPACING.md, rowGap: SPACING.lg,
  },
  plCard: { width: '47%' },
  plCover: {
    width: '100%', aspectRatio: 1, borderRadius: RADIUS.md,
    backgroundColor: colors.surfaceLight, alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden',
  },
  plName: { color: colors.text, fontSize: 14, fontWeight: '700', marginTop: 8 },
  plMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  plMeta: { color: colors.textTertiary, fontSize: 12 },
});
