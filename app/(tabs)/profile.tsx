import { useRouter, useFocusEffect } from 'expo-router';
import { useNavigation } from '@react-navigation/native';
import { useAudio } from '../../contexts/AudioContext';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, ActivityIndicator, Image, RefreshControl, Linking, PanResponder,
  Animated, Easing, Dimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useState, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { usePostOptions } from '../../contexts/PostOptionsContext';
import { useTabSwipeControl } from '../../contexts/PagerContext';
import { useProfile } from '../../contexts/ProfileContext';
import { useStories } from '../../contexts/StoriesContext';
import StoryAvatar from '../../components/StoryAvatar';
import BadgeEmblem from '../../components/BadgeEmblem';
import { resolveRingColors, resolveBannerColors, chosenTier, specialRingTier, rawTier } from '../../lib/badges';
import { activePublicIds, fetchFirstTrackCovers } from '../../lib/playlists';
import { formatCount } from '../../lib/format';
import { normalizeUrl, displayUrl } from '../../lib/profileOptions';
import { isAudioPost } from '../../lib/genres';
import { slideshowThumb } from '../../lib/slideshow';
import VideoThumb from '../../components/VideoThumb';
import ThumbStat from '../../components/ThumbStat';
import { SPACING, RADIUS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';

type Profile = {
  id: string; username: string; display_name: string;
  bio: string | null; avatar_url: string | null; badge_tier: string; created_at: string;
  link?: string | null;
};
type Stats = { followers: number; following: number; posts: number };

// Liked/Saved deliberately have no profile tabs anymore — they live in the
// Music page's pills. Playlists showcases the user's PUBLIC playlists.
const TABS = [
  { key: 'posts', label: 'Posts', icon: 'grid-outline' },
  { key: 'music', label: 'Music', icon: 'musical-notes-outline' },
  { key: 'videos', label: 'Videos', icon: 'videocam-outline' },
  { key: 'reposts', label: 'Reposts', icon: 'repeat-outline' },
  { key: 'playlists', label: 'Playlists', icon: 'albums-outline' },
];
const TAB_KEYS = TABS.map(t => t.key);
const SCREEN_W = Dimensions.get('window').width;

export default function ProfileScreen() {
  const { show: showOptions } = usePostOptions();
  const { profile: liveProfile } = useProfile();
  const { openCamera } = useStories();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [stats, setStats] = useState<Stats>({ followers: 0, following: 0, posts: 0 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState('posts');
  const [userPosts, setUserPosts] = useState<any[]>([]);
  const [repostedPosts, setRepostedPosts] = useState<any[]>([]);
  // Active public playlists (over-limit "locked" ones stay hidden, same as in
  // public discovery), faced with their first track's cover.
  const [publicPlaylists, setPublicPlaylists] = useState<any[]>([]);
  const router = useRouter();
  const navigation = useNavigation();
  const { playQueue } = useAudio();

  // Per-thumbnail nodes so opening a post/reel can expand out of the tapped cell.
  const gridRefs = useRef<Record<string, any>>({});

  // ── Sub-tab navigation: Music-page pattern, NO pager ──────────────────────
  // One fling PanResponder on the page ROOT steps the sub-tabs (with the same
  // slide-in animation as the Music pills). Taps and vertical scrolls are
  // untouched (decisive horizontal moves only).
  //
  // EXIT (Posts → Music tab): while the Posts sub-tab is active, the OUTER tab
  // pager is enabled, so a rightward swipe is the real app-pager drag — live
  // finger tracking, drag-and-hold, exactly like swiping between main tabs.
  // The fling responder deliberately ignores rightward moves on Posts (the
  // pager owns them) and keeps owning leftward steps + both directions on the
  // other sub-tabs (pager off there, so nothing fights).
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const setTabSwipe = useTabSwipeControl();
  // True while a fling gesture owns the touch — the activeTab effect below must
  // NOT re-enable the pager mid-gesture (stepping INTO Posts would let it grab
  // the rest of the same touch); release/terminate restore it instead.
  const gestureActiveRef = useRef(false);
  useFocusEffect(useCallback(() => {
    setTabSwipe(activeTabRef.current === 'posts');
    return () => setTabSwipe(true); // leaving Profile — other tabs manage their own
  }, [setTabSwipe]));
  useEffect(() => {
    if (!gestureActiveRef.current) setTabSwipe(activeTab === 'posts');
  }, [activeTab, setTabSwipe]);

  // Slide the incoming sub-tab in from the travel direction (Music-pill style).
  const tabAnimX = useRef(new Animated.Value(0)).current;
  const prevTabIdxRef = useRef(0);
  useEffect(() => {
    const idx = TAB_KEYS.indexOf(activeTab);
    if (idx !== prevTabIdxRef.current) {
      const dir = idx > prevTabIdxRef.current ? 1 : -1;
      tabAnimX.setValue(dir * SCREEN_W);
      Animated.timing(tabAnimX, { toValue: 0, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    }
    prevTabIdxRef.current = idx;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // While a finger is on the tabs PILL ROW, the page responder stands down so
  // the row scrolls (traversal) instead of stepping the sub-tab.
  const tabsRowTouchRef = useRef(false);
  // One step per gesture — armed on grant, spent the moment a step fires.
  const swipeFiredRef = useRef(false);

  // Step the sub-tab for a decisive horizontal gesture. On Posts, rightward
  // moves never reach here (the outer pager owns the live exit drag); the
  // navigate('music') branch is only a release-time safety net.
  const stepForGesture = (dx: number, allowExit: boolean) => {
    const idx = TAB_KEYS.indexOf(activeTabRef.current);
    if (dx < 0) {
      if (idx < TAB_KEYS.length - 1) { swipeFiredRef.current = true; setActiveTab(TAB_KEYS[idx + 1]); }
    } else if (idx === 0) {
      if (allowExit) { swipeFiredRef.current = true; (navigation as any).navigate('music'); }
    } else {
      swipeFiredRef.current = true; setActiveTab(TAB_KEYS[idx - 1]);
    }
  };

  const pageSwipePan = useRef(PanResponder.create({
    // Forgiving dominance bar (1.25×) so slightly diagonal side-swipes register.
    // On Posts, rightward moves are left to the OUTER pager (the live exit
    // drag) — claiming them here would kill its finger tracking.
    onMoveShouldSetPanResponder: (_e, g) =>
      !tabsRowTouchRef.current &&
      !(activeTabRef.current === 'posts' && g.dx > 0) &&
      Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.25,
    // A LEFTWARD step claimed on Posts must shut the outer pager off for the
    // rest of the gesture (same in-touch toggle the Music rails use), so it
    // can't also start dragging; restored on release/terminate.
    onPanResponderGrant: () => {
      swipeFiredRef.current = false;
      gestureActiveRef.current = true;
      if (activeTabRef.current === 'posts') setTabSwipe(false);
    },
    // Once claimed, never surrender mid-gesture — a child stealing the responder
    // meant the release handler never ran and the swipe silently vanished.
    onPanResponderTerminationRequest: () => false,
    // Fire the step the moment the gesture is DECISIVE (distance or flick) —
    // not on finger lift — so the switch starts with no perceptible delay.
    onPanResponderMove: (_e, g) => {
      if (swipeFiredRef.current) return;
      if (Math.abs(g.dx) < 40 && Math.abs(g.vx) < 0.3) return;
      stepForGesture(g.dx, false);
    },
    onPanResponderRelease: (_e, g) => {
      gestureActiveRef.current = false;
      if (swipeFiredRef.current === false && (Math.abs(g.dx) >= 40 || Math.abs(g.vx) >= 0.3)) {
        stepForGesture(g.dx, true);
      }
      // Gesture over — hand the outer pager back if we ended up on Posts.
      setTabSwipe(activeTabRef.current === 'posts');
    },
    onPanResponderTerminate: () => {
      gestureActiveRef.current = false;
      setTabSwipe(activeTabRef.current === 'posts');
    },
  })).current;

  // Refetch on focus so a post reposted elsewhere shows up in the Reposts tab.
  useFocusEffect(useCallback(() => { fetchProfile(); }, []));

  async function fetchProfile() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const [profileRes, followersRes, followingRes, postsCountRes, postsRes, repostsRes, playlistsRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', user.id).single(),
      supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', user.id),
      supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', user.id),
      // Exclude archived posts so the count matches the grid (which filters them too).
      supabase.from('posts').select('*', { count: 'exact', head: true }).eq('user_id', user.id).is('archived_at', null),
      supabase.from('posts').select('*').eq('user_id', user.id).eq('is_public', true).order('created_at', { ascending: false }),
      supabase.from('reposts').select('posts(*, profiles!posts_user_id_fkey(display_name))').eq('user_id', user.id).order('created_at', { ascending: false }).limit(100),
      supabase.from('playlists').select('*').eq('user_id', user.id).eq('is_public', true).order('play_count', { ascending: false }),
    ]);

    if (profileRes.data) setProfile(profileRes.data);
    setStats({ followers: followersRes.count || 0, following: followingRes.count || 0, posts: postsCountRes.count || 0 });
    // Archived posts (archived_at set) are hidden from the grid but kept in the
    // Archive screen. archived_at is absent pre-migration → harmless no-op.
    if (postsRes.data) setUserPosts(postsRes.data.filter((p: any) => !p.archived_at));
    // `reposts` may not be migrated yet — degrade to an empty tab if so.
    setRepostedPosts((repostsRes.data ?? []).map((r: any) => r.posts).filter(Boolean));
    // Public playlists tab: only the ones holding an active badge slot, faced
    // with their first track's cover. Degrades to empty pre-migration.
    try {
      const pls = playlistsRes.data ?? [];
      const active = activePublicIds(pls as any, rawTier(profileRes.data));
      const shown = pls.filter((p: any) => active.has(p.id));
      const covers = await fetchFirstTrackCovers(shown.map((p: any) => p.id));
      setPublicPlaylists(shown.map((p: any) => ({ ...p, cover: covers[p.id] ?? null })));
    } catch { setPublicPlaylists([]); }
    setLoading(false);
    setRefreshing(false);
  }

  if (loading) {
    return <View style={styles.loadingContainer}><ActivityIndicator color={colors.primary} size="large" /></View>;
  }

  // Prefer the global ProfileContext copy (live tier + avatar, kept in sync after
  // edits / badge changes); fall back to this screen's own fetch on first paint.
  const badgeProfile = liveProfile ?? profile;
  const myTier = chosenTier(badgeProfile);
  const ringColors = resolveRingColors(badgeProfile, myTier);
  const bannerColors = resolveBannerColors(myTier, colors.background);
  const avatarUrl = liveProfile?.avatar_url ?? profile?.avatar_url;
  // Active sub-tab pill + glow take the user's emblem-theme color (orange default
  // when they have no badge). Visible on public profiles too (owner's tier).
  const tabAccent = myTier ? ringColors[0] : colors.primary;
  const activeTabDyn = {
    backgroundColor: tabAccent + '1F', borderColor: tabAccent + '4D',
    shadowColor: tabAccent, shadowOpacity: 0.28, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 2,
  };

  function dataForTab(key: string) {
    switch (key) {
      case 'music': return userPosts.filter(p => p.type === 'audio');
      case 'videos': return userPosts.filter(p => p.type === 'video');
      case 'reposts': return repostedPosts;
      default: return userPosts; // posts
    }
  }

  // Public playlists as showcase cards: cover art, name, listen count.
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
          <Ionicons
            name={tabKey === 'reposts' ? 'repeat-outline' : 'images-outline'}
            size={40}
            color={colors.textTertiary}
          />
          <Text style={styles.emptyGridText}>
            {tabKey === 'reposts' ? 'No reposts yet' : `No ${tabKey} yet`}
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
                {/* Slide 1's screenshot (video) or slide 1 itself (image) */}
                <Image source={{ uri: slideshowThumb(post) ?? undefined }} style={styles.gridImage} resizeMode="cover" />
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
            ) : isAudioPost(post.type) && post.cover_url ? (
              <>
                <Image source={{ uri: post.cover_url }} style={styles.gridImage} resizeMode="cover" />
                <View style={styles.gridPlayOverlay}>
                  <Ionicons name="musical-notes" size={13} color={colors.text} />
                </View>
              </>
            ) : (
              <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.gridPlaceholder}>
                <Ionicons
                  name={isAudioPost(post.type) ? 'musical-notes' : 'videocam'}
                  size={28} color={colors.primary}
                />
              </LinearGradient>
            )}
            {/* View count (video) / listen count (audio) */}
            <ThumbStat type={post.type} viewCount={post.view_count} streamCount={post.stream_count} />
          </TouchableOpacity>
        ))}
      </View>
    );
  }

  return (
    // pageSwipePan lives on the ROOT: flings anywhere — header, grid, empty
    // space — step the sub-tabs; a right-fling on Posts exits to Music.
    <View style={styles.container} {...pageSwipePan.panHandlers}>
      <View>
      <View style={styles.headerBar}>
        <Text style={styles.usernameHeader}>@{profile?.username}</Text>
        <TouchableOpacity onPress={() => router.push('/settings')} style={styles.settingsBtn}>
          <Ionicons name="settings-outline" size={22} color={colors.textSecondary} />
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
            badgeRing={specialRingTier(myTier) ? ringColors : undefined}
            onPressProfile={openCamera}
            showAdd
            addColors={myTier ? ringColors : undefined}
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

      {/* Name + bio — with the Spotlight shortcut on the right */}
      <View style={styles.infoSection}>
        <View style={styles.infoRow}>
          <View style={styles.infoLeft}>
            <View style={styles.nameRow}>
              <Text style={styles.displayName}>{profile?.display_name}</Text>
              {myTier ? (
                <BadgeEmblem profile={badgeProfile} size={17} />
              ) : (
                // No badge chosen (Default theme) → a tappable outline placeholder that
                // only YOU see (visitors see nothing), linking to the Badges page.
                <TouchableOpacity
                  style={styles.badgeOutline}
                  activeOpacity={0.7}
                  hitSlop={8}
                  onPress={() => router.push('/badges')}
                >
                  <Ionicons name="add" size={12} color={colors.textTertiary} />
                </TouchableOpacity>
              )}
            </View>
            {profile?.bio
              ? <Text style={styles.bio}>{profile.bio}</Text>
              : <Text style={styles.bioEmpty}>No bio yet</Text>
            }
            {badgeProfile?.link ? (
              <TouchableOpacity style={styles.linkRow} onPress={() => Linking.openURL(normalizeUrl(badgeProfile.link!)).catch(() => {})}>
                <Ionicons name="link-outline" size={14} color={colors.primary} />
                <Text style={styles.linkText} numberOfLines={1}>{displayUrl(badgeProfile.link)}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          <TouchableOpacity
            style={styles.spotlightBtn}
            activeOpacity={0.8}
            onPress={() => router.push('/spotlight')}
          >
            <Ionicons name="sparkles" size={15} color="#fff" />
            <Text style={styles.spotlightBtnText}>Spotlight</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Action buttons */}
      <View style={styles.actionButtons}>
        <TouchableOpacity style={styles.editButton} onPress={() => router.push('/edit-profile')}>
          <Text style={styles.editButtonText}>Edit Profile</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryButton} onPress={() => router.push('/friends')}>
          <Ionicons name="people-outline" size={18} color={colors.text} />
        </TouchableOpacity>
      </View>

      {/* Tabs — tap to switch; swiping ON this row scrolls the pills
          (traversal) rather than stepping the sub-tab. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tabsScroll}
        onTouchStart={() => { tabsRowTouchRef.current = true; }}
        onTouchEnd={() => { tabsRowTouchRef.current = false; }}
        onTouchCancel={() => { tabsRowTouchRef.current = false; }}
      >
        <View style={styles.tabsRow}>
          {TABS.map((tab) => (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tab, activeTab === tab.key && activeTabDyn]}
              onPress={() => setActiveTab(tab.key)}
            >
              <Ionicons
                name={activeTab === tab.key ? tab.icon.replace('-outline', '') as any : tab.icon as any}
                size={16}
                color={activeTab === tab.key ? tabAccent : colors.textTertiary}
              />
              <Text style={[styles.tabText, activeTab === tab.key && { color: tabAccent, fontWeight: '700' }]}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
      </View>

      {/* Sub-tab pages — ALL stay mounted; switching just flips visibility, so
          a step never pays a grid-mount cost mid-swipe (that mount was what
          made non-Posts swipes feel slow). The visible page slides in from the
          travel direction (same pattern as the Music pills). */}
      <Animated.View style={[styles.pager, { transform: [{ translateX: tabAnimX }] }]}>
        {TAB_KEYS.map((key) => (
          <View key={key} style={key === activeTab ? styles.pager : styles.pageHidden}>
            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.pageContent}
              refreshControl={
                <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchProfile(); }} tintColor={tabAccent} colors={[tabAccent]} />
              }
            >
              {key === 'playlists' ? renderPlaylists() : renderGrid(dataForTab(key), key)}
            </ScrollView>
          </View>
        ))}
      </Animated.View>
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  loadingContainer: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },

  headerBar: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: SPACING.md, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.sm,
  },
  usernameHeader: { color: colors.text, fontSize: 24, fontWeight: '900' },
  settingsBtn: { padding: 4 },

  banner: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: SPACING.md, paddingTop: SPACING.md, paddingBottom: SPACING.lg, gap: SPACING.lg,
    borderBottomLeftRadius: RADIUS.xl, borderBottomRightRadius: RADIUS.xl,
  },
  avatarWrap: { alignItems: 'center', justifyContent: 'center' },
  avatarRing: { width: 88, height: 88, borderRadius: RADIUS.full, padding: 3, alignItems: 'center', justifyContent: 'center' },
  avatarImage: { width: 82, height: 82, borderRadius: RADIUS.full },
  avatarPlaceholder: { width: 82, height: 82, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.text, fontSize: 32, fontWeight: '700' },

  statsRow: {
    flex: 1, flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.22)', borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', paddingVertical: SPACING.sm,
  },
  statItem: { flex: 1, alignItems: 'center', gap: 2 },
  statNumber: { color: colors.primaryLight, fontSize: 21, fontWeight: '800', letterSpacing: -0.3 },
  statLabel: { color: 'rgba(245,245,245,0.65)', fontSize: 10, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },

  infoSection: { paddingHorizontal: SPACING.md, paddingTop: SPACING.md },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  infoLeft: { flex: 1, gap: 4 },
  // Solid orange button with white text/icon (profile page only).
  spotlightBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: colors.primary,
    borderRadius: RADIUS.full,
    paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md,
  },
  spotlightBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  displayName: { color: colors.text, fontSize: 17, fontWeight: '800', letterSpacing: -0.2 },
  badgeOutline: {
    width: 19, height: 19, borderRadius: RADIUS.full,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)', borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center',
  },
  bio: { color: colors.textSecondary, fontSize: 14, lineHeight: 20 },
  bioEmpty: { color: colors.textTertiary, fontSize: 14, fontStyle: 'italic' },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  linkText: { color: colors.primary, fontSize: 13, fontWeight: '600' },

  actionButtons: { flexDirection: 'row', paddingHorizontal: SPACING.md, paddingTop: SPACING.md, gap: SPACING.sm },
  editButton: {
    flex: 1, backgroundColor: colors.surfaceElevated,
    borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.full, paddingVertical: SPACING.sm + 2, alignItems: 'center',
  },
  editButtonText: { color: colors.text, fontSize: 14, fontWeight: '700', letterSpacing: 0.2 },
  secondaryButton: {
    backgroundColor: colors.surfaceElevated, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.full, paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm + 2, alignItems: 'center', justifyContent: 'center',
  },

  tabsScroll: { marginTop: SPACING.md, borderBottomWidth: 0.5, borderBottomColor: colors.border, flexGrow: 0 },
  tabsRow: { flexDirection: 'row', paddingHorizontal: SPACING.sm, paddingVertical: SPACING.sm, gap: 4 },
  tab: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.full, borderWidth: 1, borderColor: 'transparent',
  },
  activeTab: { backgroundColor: colors.primary + '18', borderColor: colors.primary + '3A' },
  tabText: { color: colors.textTertiary, fontSize: 12, fontWeight: '600' },
  activeTabText: { color: colors.primary, fontWeight: '700' },

  pager: { flex: 1 },
  // Off-tab pages stay MOUNTED but invisible — flipping display is what makes
  // a sub-tab step instant (no grid mount mid-swipe).
  pageHidden: { display: 'none' },
  pageContent: { paddingBottom: SPACING.xxl + 80 },

  postsGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  gridItem: { width: '33.33%', aspectRatio: 1, position: 'relative' },
  gridImage: { width: '100%', height: '100%' },
  gridPlaceholder: {
    width: '100%', height: '100%',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 0.5, borderColor: colors.border,
  },
  // (kept for reposts overlay parity if needed later)
  gridBadge: {
    position: 'absolute', top: 6, right: 6,
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  gridPlayOverlay: {
    position: 'absolute', top: 6, left: 6,
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center',
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
