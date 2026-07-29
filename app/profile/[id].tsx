import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, ActivityIndicator, RefreshControl, PanResponder,
  Animated, Easing, Dimensions,
} from 'react-native';
// Content thumbnails use expo-image: memory+disk cached, so re-renders and
// remounts repaint instantly instead of flashing (RN's core Image flickers when
// list rows re-render with fresh source objects under the new architecture).
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState, useRef } from 'react';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { useAudio } from '../../contexts/AudioContext';
import { useAudioPlayer } from '../../hooks/useAudioPlayer';
import { supabase } from '../../lib/supabase';
import { SPACING, RADIUS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import TranslatableText from '../../components/TranslatableText';
import VideoThumb from '../../components/VideoThumb';
import ThumbStat from '../../components/ThumbStat';
import SpotlightThumbBadge from '../../components/SpotlightThumbBadge';
import TrackRow from '../../components/TrackRow';
import { applyMusicOrder, parseMusicOrder } from '../../lib/musicOrder';
import { fetchSpotlightedPostIds } from '../../lib/spotlight';
import StoryAvatar from '../../components/StoryAvatar';
import { openAvatarViewer } from '../../lib/imageViewer';
import BadgeEmblem from '../../components/BadgeEmblem';
import ProfileQRModal from '../../components/ProfileQRModal';
import { resolveRingColors, resolveBannerColors, chosenTier, specialRingTier, rawTier } from '../../lib/badges';
import { activePublicIds, fetchFirstTrackCovers } from '../../lib/playlists';
import { countLabel } from '../../lib/i18n';
import { displayUrl } from '../../lib/profileOptions';
import { useLinkGuard } from '../../contexts/LinkGuardContext';
import { useListenMode } from '../../contexts/ListenModeContext';
import { activeLayout, usedPostIds } from '../../lib/pageLayout';
import ProfileLayoutGrid from '../../components/ProfileLayoutGrid';
import { slideshowThumb } from '../../lib/slideshow';
import { createNotification } from '../../lib/createNotification';
import { hasOpenShop } from '../../lib/shop';
import { usePostOptions } from '../../contexts/PostOptionsContext';
import { ProfileSkeleton } from '../../components/Skeleton';

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
const SCREEN_W = Dimensions.get('window').width;

export default function PublicProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const linkGuard = useLinkGuard();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const isFocused = useIsFocused();
  const { playQueue, expand } = useAudio();
  const { confirmLeaveListen } = useListenMode();
  const { playingId } = useAudioPlayer();
  const { show: showOptions } = usePostOptions();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [stats, setStats] = useState<Stats>({ followers: 0, following: 0, posts: 0 });
  const [posts, setPosts] = useState<any[]>([]);
  // Post ids with a LIVE spotlight → a subtle sparkle on their grid thumbnail.
  const [spotlightIds, setSpotlightIds] = useState<Set<string>>(new Set());
  const [reposts, setReposts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [qrVisible, setQrVisible] = useState(false);
  const [isFollowing, setIsFollowing] = useState(false);
  const [followsMe, setFollowsMe] = useState(false); // does this profile follow me back?
  const [hasShop, setHasShop] = useState(false); // open shop → green Shop button
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('posts');
  const [followLoading, setFollowLoading] = useState(false);
  // This user's ACTIVE public playlists (locked over-limit ones stay hidden).
  const [publicPlaylists, setPublicPlaylists] = useState<any[]>([]);

  // Per-thumbnail nodes so opening a post/reel can expand out of the tapped cell.
  const gridRefs = useRef<Record<string, any>>({});

  // ── Sub-tab navigation: Music-page pattern, NO pager ──────────────────────
  // The sub-tabs used to live in a PagerView whose page 0 was a blank dismiss
  // page — which made exiting a visible two-part motion. The pager is GONE:
  // one fling PanResponder on the page ROOT steps the sub-tabs (with the same
  // slide-in animation as the Music pills), and a right-fling on Posts goes
  // straight back — there is no page 0 to reveal. Taps and vertical scrolls
  // are untouched (decisive horizontal moves only).
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

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

  // One step per gesture — armed on grant, spent the moment a step fires.
  const swipeFiredRef = useRef(false);

  // Step the sub-tab (or exit) for a decisive horizontal gesture. The EXIT
  // (popping the screen) only ever runs on release — navigating away under a
  // live finger is glitch-prone — so mid-gesture calls pass allowExit=false.
  const stepForGesture = (dx: number, allowExit: boolean) => {
    const idx = TAB_KEYS.indexOf(activeTabRef.current);
    if (dx < 0) {
      if (idx < TAB_KEYS.length - 1) { swipeFiredRef.current = true; setActiveTab(TAB_KEYS[idx + 1]); }
    } else if (idx === 0) {
      if (allowExit && router.canGoBack()) { swipeFiredRef.current = true; router.back(); }
    } else {
      swipeFiredRef.current = true; setActiveTab(TAB_KEYS[idx - 1]);
    }
  };

  const pageSwipePan = useRef(PanResponder.create({
    // Forgiving dominance bar (1.25×) so slightly diagonal side-swipes register.
    onMoveShouldSetPanResponder: (_e, g) =>
      Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.25,
    onPanResponderGrant: () => { swipeFiredRef.current = false; },
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
      if (swipeFiredRef.current) return;
      if (Math.abs(g.dx) < 40 && Math.abs(g.vx) < 0.3) return;
      stepForGesture(g.dx, true);
    },
  })).current;

  useEffect(() => { setup().catch(() => { setLoading(false); setRefreshing(false); }); }, [id]);

  // Shop button gate: RLS only exposes shops that are open (or your own).
  useEffect(() => {
    if (!id) return;
    let active = true;
    hasOpenShop(String(id)).then((v) => { if (active) setHasShop(v); }).catch(() => {});
    return () => { active = false; };
  }, [id]);

  async function setup() {
    const { data: { user } } = await supabase.auth.getUser();
    const currentUser = user ?? null;
    if (currentUser) setCurrentUserId(currentUser.id);

    const [profileRes, followersRes, followingRes, postsCountRes, postsRes, followCheckRes, followsMeRes, repostsRes, playlistsRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', id).single(),
      supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', id),
      supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', id),
      // Exclude archived posts so the count matches the grid (which filters them too).
      supabase.from('posts').select('*', { count: 'exact', head: true }).eq('user_id', id).is('archived_at', null),
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
      const visible = postsRes.data.filter((p: any) => (p.is_public || canSeePrivate) && !p.archived_at);
      setPosts(visible);
      fetchSpotlightedPostIds(visible.map((p: any) => p.id)).then(setSpotlightIds);
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
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <ProfileSkeleton />
      </View>
    );
  }

  // Hidden accounts are invisible to everyone but themselves (their content is
  // already gone from feeds via the restrictive policies — this blocks the
  // profile page itself).
  if ((profile as any)?.hidden && currentUserId !== id) {
    return (
      <View style={[styles.loadingContainer, { gap: SPACING.sm, padding: SPACING.xl }]}>
        <Ionicons name="eye-off-outline" size={44} color={colors.textTertiary} />
        <Text style={{ color: colors.text, fontSize: 17, fontWeight: '700' }}>{t('profile.unavailable')}</Text>
        <TouchableOpacity onPress={() => router.back()} style={{ padding: SPACING.sm }}>
          <Text style={{ color: colors.primary, fontSize: 15, fontWeight: '600' }}>{t('profile.goBack')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const isOwnProfile = currentUserId === id;
  const isFriend = isFollowing && followsMe;
  const followLabel = isFriend ? t('profile.friends') : isFollowing ? t('profile.followingBtn') : followsMe ? t('profile.followBack') : t('profile.follow');
  const ownerTier = chosenTier(profile);
  const ringColors = resolveRingColors(profile, ownerTier);
  const bannerColors = resolveBannerColors(ownerTier, colors.background);
  // Active tab underline + text + glow take the owner's emblem-theme color, so
  // visitors see the owner's tier color on their profile too.
  const tabAccent = ownerTier ? ringColors[0] : colors.primary;
  // The owner's custom Posts-grid layout, if they have one and still qualify for
  // its tier (activeLayout re-checks their earned tier + resolves blocks).
  const pageLayout = activeLayout(profile, posts);
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

  // Posts tab ordering: float live-spotlighted posts to the TOP (newest-first
  // among them), everyone else newest-first. Expired spotlights drop out of
  // spotlightIds → revert to default. Skipped if the user runs a custom page
  // layout — then their own arrangement wins.
  function orderPostsForGrid(data: any[]) {
    if (pageLayout) return data;
    return [...data].sort((a, b) => {
      const sa = spotlightIds.has(a.id) ? 1 : 0;
      const sb = spotlightIds.has(b.id) ? 1 : 0;
      if (sa !== sb) return sb - sa;
      return String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
    });
  }

  function renderPlaylists() {
    if (publicPlaylists.length === 0) {
      return (
        <View style={styles.emptyGrid}>
          <Ionicons name="albums-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyGridText}>{t('profile.noPlaylists')}</Text>
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
              <Text style={styles.plMeta}>{countLabel('listen', pl.play_count ?? 0)}</Text>
            </View>
          </TouchableOpacity>
        ))}
      </View>
    );
  }

  // Music tab: scrollable spotify-style sound cards, newest first — not the
  // picture-thumbnail grid. The main Posts grid still renders audio as thumbnails.
  function renderMusicList(data: any[]) {
    if (data.length === 0) {
      return (
        <View style={styles.emptyGrid}>
          <Ionicons name="musical-notes-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyGridText}>{t('profile.noMusic')}</Text>
        </View>
      );
    }
    // A saved custom order (the owner's Premium arrangement) WINS; otherwise
    // live-spotlighted tracks float to the TOP (newest-first among them), the rest
    // most-recent → least-recent.
    const order = parseMusicOrder((profile as any)?.music_order);
    const tracks = order.length
      ? applyMusicOrder([...data], order)
      : [...data].sort((a, b) => {
          const sa = spotlightIds.has(a.id) ? 1 : 0;
          const sb = spotlightIds.has(b.id) ? 1 : 0;
          if (sa !== sb) return sb - sa;
          return String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
        });
    const queue = tracks.map((t) => ({
      id: t.id, uri: t.media_url, caption: t.caption,
      artist: t.profiles?.display_name ?? profile?.display_name ?? '', cover: t.cover_url,
    }));
    return (
      <View style={styles.musicList}>
        {tracks.map((track, i) => (
          <TrackRow
            key={track.id}
            caption={track.caption}
            artist={track.profiles?.display_name ?? profile?.display_name ?? ''}
            username={track.profiles?.username ?? profile?.username ?? ''}
            duration={track.duration_seconds}
            streams={track.stream_count ?? 0}
            cover={track.cover_url}
            badgeProfile={profile}
            badgeOwnerId={id}
            spotlighted={spotlightIds.has(track.id)}
            isPlaying={playingId === track.id}
            onPlay={() => playQueue(queue, i)}
            onCoverPress={() => { playQueue(queue, i); expand(); }}
          />
        ))}
      </View>
    );
  }

  // Open an image/slideshow post or a reel, expanding out of the tapped cell
  // (shared by the normal grid and the custom layout blocks).
  function openVisual(post: any, node?: any) {
    const pathname = post.type === 'video' ? '/reel/[id]' : '/post/[id]';
    const seed = JSON.stringify(post);
    const go = () => {
      if (node?.measureInWindow) {
        node.measureInWindow((x: number, y: number, width: number, height: number) =>
          router.push({ pathname, params: { id: post.id, post: seed, src: JSON.stringify({ x, y, width, height }) } }));
      } else {
        router.push({ pathname, params: { id: post.id, post: seed } });
      }
    };
    // A reel is an immersive full-screen player with no docked mini-player, so it
    // can't run inside a listen session — confirm the Listen-mode exit first (a
    // no-op prompt-wise when Listen mode is off). Image/slideshow posts keep the
    // side-chip mini-player and coexist fine, so they open straight away.
    if (post.type === 'video') confirmLeaveListen(go);
    else go();
  }

  // The Posts tab: the owner's custom feature layout (when active) above the
  // normal grid of any leftover posts, or just the normal grid.
  function renderPostsTab() {
    const data = dataForTab('posts');
    if (!pageLayout) return renderGrid(orderPostsForGrid(data), 'posts');
    const used = usedPostIds(pageLayout.blocks);
    const leftovers = data.filter(p => !used.has(p.id));
    return (
      <>
        <ProfileLayoutGrid
          layout={pageLayout}
          posts={posts}
          ownerTier={rawTier(profile)}
          spotlightIds={spotlightIds}
          playingId={playingId}
          artistName={profile?.display_name}
          // Pause the looping hero when this sub-tab is hidden or the profile is
          // off-screen — a detached VideoView that plays to its end stalls black.
          active={activeTab === 'posts' && isFocused}
          onOpenVisual={openVisual}
          onPlaySongs={(queue, idx) => playQueue(queue, idx)}
        />
        {leftovers.length > 0 && renderGrid(leftovers, 'posts')}
      </>
    );
  }

  function renderGrid(data: any[], tabKey: string) {
    if (data.length === 0) {
      return (
        <View style={styles.emptyGrid}>
          <Ionicons name="images-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyGridText}>{t(`profile.empty.${tabKey}`)}</Text>
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
                // Same path as the layout blocks — openVisual measures the cell
                // for the expand animation AND gates reels behind the Listen-mode
                // exit confirmation.
                openVisual(post, gridRefs.current[post.id]);
              }
            }}
          >
            {post.type === 'slideshow' ? (
              <>
                {/* Slide 1's screenshot (video) or slide 1 itself (image) */}
                <Image source={{ uri: slideshowThumb(post) ?? undefined }} style={styles.gridImage} contentFit="cover" />
                <View style={styles.gridPlayOverlay}>
                  <Ionicons name="copy" size={13} color="#fff" />
                </View>
              </>
            ) : post.type === 'video' ? (
              <>
                <VideoThumb thumbnailUrl={post.thumbnail_url} mediaUrl={post.media_url} style={styles.gridImage} />
                <View style={styles.gridPlayOverlay}>
                  <Ionicons name="play" size={14} color="#fff" />
                </View>
              </>
            ) : post.type === 'image' ? (
              <Image source={{ uri: post.media_url }} style={styles.gridImage} contentFit="cover" />
            ) : post.type === 'audio' && post.cover_url ? (
              <>
                <Image source={{ uri: post.cover_url }} style={styles.gridImage} contentFit="cover" />
                <View style={styles.gridPlayOverlay}>
                  <Ionicons name="musical-notes" size={13} color="#fff" />
                </View>
              </>
            ) : (
              <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.gridPlaceholder}>
                <Ionicons name={post.type === 'audio' ? 'musical-notes' : 'videocam'} size={28} color={colors.primary} />
              </LinearGradient>
            )}
            {/* Subtle yellow sparkle when this post has a live spotlight. */}
            {spotlightIds.has(post.id) && <SpotlightThumbBadge />}
            <ThumbStat type={post.type} viewCount={post.view_count} streamCount={post.stream_count} />
          </TouchableOpacity>
        ))}
      </View>
    );
  }

  return (
    // pageSwipePan lives on the ROOT: flings anywhere — header, grid, empty
    // space — step the sub-tabs; a right-fling on Posts goes straight back.
    <View style={styles.container} {...pageSwipePan.panHandlers}>
      {/* No native back-swipe — the root fling responder + the back button
          handle going back, so nothing competes with the sub-tab swipes. */}
      <Stack.Screen options={{ gestureEnabled: false }} />

      <View>
      {/* Back */}
      <View style={styles.topBar}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.usernameHeader}>@{profile?.username}</Text>
        {!isOwnProfile ? (
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.moreOptions')}
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
          <TouchableOpacity
            style={styles.backBtn}
            onPress={() => setQrVisible(true)}
            accessibilityRole="button"
            accessibilityLabel={t('qr.a11y')}
          >
            <Ionicons name="qr-code-outline" size={22} color={colors.textSecondary} />
          </TouchableOpacity>
        )}
      </View>

      {isOwnProfile && !!profile?.id && (
        <ProfileQRModal
          visible={qrVisible}
          onClose={() => setQrVisible(false)}
          userId={profile.id}
          username={profile.username}
          displayName={profile.display_name}
          avatarUrl={profile.avatar_url}
        />
      )}

      {/* Banner — tinted by the owner's chosen profile theme (gated by their tier) */}
      <LinearGradient colors={bannerColors} style={styles.banner}>
        <View style={styles.avatarWrap}>
          <StoryAvatar
            userId={profile?.id ?? id}
            avatarUrl={profile?.avatar_url}
            name={profile?.display_name}
            size={88}
            badgeRing={specialRingTier(ownerTier) ? ringColors : undefined}
            // With an active story, tapping opens it (StoryAvatar's default).
            // Otherwise tap expands the profile picture as a large circle — only
            // when there's a real avatar (a placeholder initial isn't worth
            // expanding).
            onPressProfile={profile?.avatar_url ? () => openAvatarViewer(profile.avatar_url!) : undefined}
          />
        </View>

        <View style={styles.statsRow}>
          {[
            { label: t('profile.tab.posts'), val: stats.posts, onPress: undefined },
            { label: t('profile.followers'), val: stats.followers, onPress: () => router.push(`/followers/${id}`) },
            { label: t('profile.following'), val: stats.following, onPress: () => router.push(`/following/${id}`) },
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
          ? <TranslatableText text={profile.bio} style={styles.bio} />
          : <Text style={styles.bioEmpty}>{t('profile.noBio')}</Text>
        }
        {profile?.link ? (
          <TouchableOpacity style={styles.linkRow} onPress={() => linkGuard.open(profile.link!, { context: 'bio' })}>
            <Ionicons name="link-outline" size={14} color={colors.primary} />
            <Text style={styles.linkText} numberOfLines={1}>{displayUrl(profile.link)}</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Shop (only when this user has an open shop) — above Follow / Message */}
      {!isOwnProfile && hasShop && (
        <View style={styles.shopButtonRow}>
          <TouchableOpacity style={styles.shopButton} onPress={() => router.push(`/shop/${id}`)} activeOpacity={0.85}>
            <Ionicons name="storefront" size={17} color="#fff" />
            <Text style={styles.shopButtonText}>{t('shop.title')}</Text>
          </TouchableOpacity>
        </View>
      )}

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
            <Text style={styles.messageButtonText}>{t('profile.message')}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Tabs — tap or swipe anywhere on the page to switch */}
      <View style={styles.tabsRow}>
        {TABS.map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, activeTab === tab.key && styles.activeTab, activeTab === tab.key && activeTabDyn]}
            onPress={() => setActiveTab(tab.key)}
          >
            <Text style={[styles.tabText, activeTab === tab.key && styles.activeTabText, activeTab === tab.key && { color: tabAccent }]}>{t(`profile.tab.${tab.key}`)}</Text>
          </TouchableOpacity>
        ))}
      </View>
      </View>

      {/* Sub-tab pages — ALL stay mounted; switching just flips visibility, so
          a step never pays a grid-mount cost mid-swipe. The visible page slides
          in from the travel direction (same pattern as the Music pills). */}
      <Animated.View style={[styles.pager, { transform: [{ translateX: tabAnimX }] }]}>
        {TAB_KEYS.map((key) => (
          <View key={key} style={key === activeTab ? styles.pager : styles.pageHidden}>
            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.pageContent}
              refreshControl={
                <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); setup().catch(() => { setLoading(false); setRefreshing(false); }); }} tintColor={tabAccent} colors={[tabAccent]} />
              }
            >
              {key === 'playlists' ? renderPlaylists() : key === 'music' ? renderMusicList(dataForTab('music')) : key === 'posts' ? renderPostsTab() : renderGrid(dataForTab(key), key)}
            </ScrollView>
          </View>
        ))}
      </Animated.View>
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

  // A dark translucent pill (matching the own-profile stats) so the counts and
  // labels stay crisp and readable on ANY tier banner — they used to blend into
  // the bronze/gold/default banner with no container behind them.
  statsRow: {
    flex: 1, flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.28)', borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', paddingVertical: SPACING.sm,
  },
  statItem: { flex: 1, alignItems: 'center', gap: 3 },
  statNumber: { color: '#FFFFFF', fontSize: 21, fontWeight: '800', letterSpacing: -0.3 },
  statLabel: { color: 'rgba(245,245,245,0.7)', fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 },

  infoSection: { paddingHorizontal: SPACING.md, paddingTop: SPACING.sm, gap: 4 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  displayName: { color: colors.text, fontSize: 16, fontWeight: '700' },
  bio: { color: colors.textSecondary, fontSize: 14, lineHeight: 20 },
  bioEmpty: { color: colors.textTertiary, fontSize: 14, fontStyle: 'italic' },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  linkText: { color: colors.primary, fontSize: 13, fontWeight: '600' },

  // Green marketplace entry, full-width above Follow/Message.
  shopButtonRow: { paddingHorizontal: SPACING.md, paddingTop: SPACING.md },
  shopButton: { backgroundColor: colors.success, borderRadius: RADIUS.md, paddingVertical: SPACING.sm + 2, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 6 },
  shopButtonText: { color: '#fff', fontSize: 14, fontWeight: '700' },
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
  // Off-tab pages stay MOUNTED but invisible — flipping display is what makes
  // a sub-tab step instant (no grid mount mid-swipe).
  pageHidden: { display: 'none' },
  pageContent: { paddingBottom: SPACING.xxl + 60 },

  // 2px gutters between cells (gap needs pixel-sized items — thirds would overflow the row).
  postsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 2 },
  musicList: { paddingHorizontal: SPACING.md, paddingTop: SPACING.sm, gap: SPACING.sm },
  gridItem: { width: (SCREEN_W - 4) / 3, aspectRatio: 1 },
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
