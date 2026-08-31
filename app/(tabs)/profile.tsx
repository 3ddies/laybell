import { useRouter, useFocusEffect } from 'expo-router';
import { useNavigation, useIsFocused } from '@react-navigation/native';
import { useAudio } from '../../contexts/AudioContext';
import { useAudioPlayer } from '../../hooks/useAudioPlayer';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, RefreshControl, PanResponder,
  Animated, Easing, Dimensions, Platform,
} from 'react-native';
// Content thumbnails use expo-image: memory+disk cached, so re-renders and
// remounts repaint instantly instead of flashing (RN's core Image flickers when
// list rows re-render with fresh source objects under the new architecture).
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { orderProfileTabs, tabContent } from '../../lib/profileTabOrder';
import { supabase } from '../../lib/supabase';
import { tabTick } from '../../lib/haptics';
import { usePostOptions } from '../../contexts/PostOptionsContext';
import { useTabSwipeControl } from '../../contexts/PagerContext';
import { useProfile } from '../../contexts/ProfileContext';
import { usePremium } from '../../contexts/PremiumContext';
import { type FeaturedItem, resolveFeatured } from '../../lib/musicFeatured';
import FeaturedRotator from '../../components/FeaturedRotator';
import { useStories } from '../../contexts/StoriesContext';
import StoryAvatar from '../../components/StoryAvatar';
import BadgeEmblem from '../../components/BadgeEmblem';
import ProfileQRModal from '../../components/ProfileQRModal';
import { resolveRingColors, resolveBannerColors, chosenTier, specialRingTier, rawTier } from '../../lib/badges';
import { activePublicIds, fetchFirstTrackCovers } from '../../lib/playlists';
import { type Album, albumCover, fetchAlbums } from '../../lib/albums';
import { countLabel } from '../../lib/i18n';
import { displayUrl } from '../../lib/profileOptions';
import { useLinkGuard } from '../../contexts/LinkGuardContext';
import { activeLayout, usedPostIds } from '../../lib/pageLayout';
import ProfileLayoutGrid from '../../components/ProfileLayoutGrid';
import { isAudioPost } from '../../lib/genres';
import { slideshowThumb, isSlideshow } from '../../lib/slideshow';
import VideoThumb from '../../components/VideoThumb';
import ThumbStat from '../../components/ThumbStat';
import SpotlightThumbBadge from '../../components/SpotlightThumbBadge';
import TrackRow from '../../components/TrackRow';
import SpotlightButton from '../../components/SpotlightButton';
import { fetchSpotlightedPostIds } from '../../lib/spotlight';
import { SPACING, RADIUS, quietText, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { unseenShopActivityCount } from '../../lib/shop';
import TranslatableText from '../../components/TranslatableText';
import { ProfileSkeleton } from '../../components/Skeleton';

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
  { key: 'playlists', label: 'Playlists', icon: 'albums-outline' },
  { key: 'reposts', label: 'Reposts', icon: 'repeat-outline' },
];
const TAB_KEYS = TABS.map(t => t.key);
const SCREEN_W = Dimensions.get('window').width;

// Black or white, whichever reads on a given background — so a SOLID accent pill
// (light-mode active tab) stays legible whether the badge color is a light metal
// (gold/silver → dark text) or a saturated hue (→ white text).
function readableOn(hex: string): string {
  const h = hex.replace('#', '');
  if (h.length < 6) return '#FFFFFF';
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? '#16161A' : '#FFFFFF';
}

export default function ProfileScreen() {
  const { show: showOptions } = usePostOptions();
  const { profile: liveProfile } = useProfile();
  const { isPremium } = usePremium();
  const { openCamera } = useStories();
  const { colors, mode } = useTheme();
  // Inactive category tabs used textTertiary, which reads too faint on white
  // next to the badge-tinted active-tab pill. In light mode step them up to the
  // stronger secondary gray so the tab row looks balanced; dark/grey stay put.
  const inactiveTabTint = mode === 'light' ? colors.textSecondary : colors.textTertiary;
  const { t } = useTranslation();
  const linkGuard = useLinkGuard();
  const styles = useThemedStyles(makeStyles);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [stats, setStats] = useState<Stats>({ followers: 0, following: 0, posts: 0 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [qrVisible, setQrVisible] = useState(false);
  const [activeTab, setActiveTab] = useState('posts');
  const [userPosts, setUserPosts] = useState<any[]>([]);
  // Post ids with a LIVE spotlight → a subtle sparkle on their grid thumbnail.
  const [spotlightIds, setSpotlightIds] = useState<Set<string>>(new Set());
  const [repostedPosts, setRepostedPosts] = useState<any[]>([]);
  // Active public playlists (over-limit "locked" ones stay hidden, same as in
  // public discovery), faced with their first track's cover.
  const [publicPlaylists, setPublicPlaylists] = useState<any[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const router = useRouter();
  const navigation = useNavigation();
  const isFocused = useIsFocused();
  const { playQueue, expand } = useAudio();
  const { playingId } = useAudioPlayer();

  // Unaddressed/unseen shop activity (pending sale requests, freshly delivered
  // or declined orders) → red alert dot on the Shop button, refreshed whenever
  // the profile regains focus (e.g. returning from the shop hub clears it).
  const [shopAlertCount, setShopAlertCount] = useState(0);
  useFocusEffect(useCallback(() => {
    unseenShopActivityCount().then(setShopAlertCount).catch(() => {});
  }, []));

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
  // OWNER DECISION (Android): like Music's pill stepper, the profile sub-tab
  // fling stepper is iOS-only — on Android its PanResponder loses to the
  // grids' native interception often enough to feel broken, and the armed
  // state also turns the outer pager off. Android keeps the pager on for every
  // sub-tab (main-tab swipes always work) and sub-tabs are navigated by taps.
  useFocusEffect(useCallback(() => {
    setTabSwipe(Platform.OS === 'android' || activeTabRef.current === 'posts');
    return () => setTabSwipe(true); // leaving Profile — other tabs manage their own
  }, [setTabSwipe]));
  useEffect(() => {
    if (!gestureActiveRef.current) setTabSwipe(Platform.OS === 'android' || activeTab === 'posts');
  }, [activeTab, setTabSwipe]);

  // Sub-tab ORDER follows what this profile actually has: Posts pinned first,
  // the rest ranked by content (see lib/profileTabOrder). Derived from rows
  // already loaded — no extra queries. The PAGES below are deliberately NOT
  // reordered: inactive ones are display:none so they occupy no layout, which
  // makes their DOM order invisible; reordering them would churn mounted
  // grids for zero visual gain.
  const orderedKeys = useMemo(() => orderProfileTabs(
    TAB_KEYS,
    {
      music: tabContent(userPosts.filter((p: any) => p.type === 'audio')),
      videos: tabContent(userPosts.filter((p: any) => p.type === 'video')),
      reposts: tabContent(repostedPosts),
      playlists: tabContent(publicPlaylists),
    },
    userPosts.length > 0,
    // Same rule as the visited profile: a showcase with nothing in it is a
    // labelled dead end. Neither tab creates anything — playlists are made and
    // managed on the Music tab — so losing an empty one strands nobody.
    ['playlists', 'reposts'],
  ), [userPosts, repostedPosts, publicPlaylists]);
  // The gesture handler is created once and reads refs, so the order it steps
  // through has to be a ref too.
  const orderedKeysRef = useRef(orderedKeys);
  orderedKeysRef.current = orderedKeys;
  const orderedTabs = useMemo(
    () => orderedKeys.map((k) => TABS.find((tb) => tb.key === k)).filter(Boolean) as typeof TABS,
    [orderedKeys],
  );
  // A tab can now VANISH under the owner — un-reposting the last repost, or
  // making their only public playlist private, both while standing on that very
  // tab. Left pointing at a key no longer in the strip, activeTab selects
  // nothing and the page renders blank with no tab lit.
  useEffect(() => {
    if (!orderedKeys.includes(activeTab)) setActiveTab('posts');
  }, [orderedKeys, activeTab]);
  // Measured rather than counted: whether the pills fit depends on the language
  // as much as the number of them ("Playlists" is "Wiedergabelisten" in German),
  // so counting tabs would be right in English and wrong everywhere else.
  const [tabsViewportW, setTabsViewportW] = useState(0);
  const [tabsContentW, setTabsContentW] = useState(0);
  const tabsFit = tabsViewportW > 0 && tabsContentW > 0 && tabsContentW <= tabsViewportW;

  // Slide the incoming sub-tab in from the travel direction (Music-pill style).
  const tabAnimX = useRef(new Animated.Value(0)).current;
  // Tracked by KEY, not index: the order can change under us when content
  // loads, and an index-based check would read that as a tab switch and fire a
  // spurious slide on a tab the user never touched.
  const prevTabKeyRef = useRef(activeTab);
  const pendingSlideRef = useRef(false);
  // The start offset is seeded DURING RENDER (repo convention, same as the
  // FlashList recycling guards), not in an effect. Hidden pages use
  // display:none, so Yoga never lays out their subtree — flipping one visible
  // lays it out fresh. Seeding in an effect meant the commit that revealed the
  // page painted it AT REST (translateX still 0 from the previous slide) with
  // its grid mid-layout, and only the NEXT frame jumped it off-screen to begin
  // the slide: the brief flash of a half-built grid. Seeding here puts the page
  // off-screen in the very same frame it becomes visible, so the fresh layout
  // happens out of sight and the slide reveals a settled page.
  if (prevTabKeyRef.current !== activeTab) {
    const prevIdx = orderedKeys.indexOf(prevTabKeyRef.current);
    const dir = prevIdx < 0 || orderedKeys.indexOf(activeTab) > prevIdx ? 1 : -1;
    prevTabKeyRef.current = activeTab;
    // A slide already in flight drives toward 0 on its own clock; stop it or it
    // fights the new seed and lands early.
    tabAnimX.stopAnimation();
    tabAnimX.setValue(dir * SCREEN_W);
    pendingSlideRef.current = true;
  }
  useEffect(() => {
    if (!pendingSlideRef.current) return;
    pendingSlideRef.current = false;
    Animated.timing(tabAnimX, { toValue: 0, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // While a finger is on ANY horizontal rail inside the page — the tabs pill
  // row, the albums shelf — the page responder stands down so the rail scrolls
  // instead of stepping the sub-tab.
  //
  // This is the same-axis problem: a horizontal scroller inside a horizontal
  // gesture owner. Crossed axes sort themselves out; same-axis competitors never
  // do, and no threshold separates them because the two gestures ARE the same
  // gesture. The only fix is for one to declare itself out, which is what this
  // ref does. It started life guarding the tabs row alone and is named for the
  // category now, because the albums shelf was the second rail and will not be
  // the last: any future horizontal rail wires the same three handlers.
  //
  // Set on touch start, cleared on end AND cancel. Cancel is the load-bearing
  // one: when a rail loses the touch to something else it gets a cancel, not an
  // end, and clearing on end alone would leave the flag stuck true and silently
  // kill sub-tab swiping for the rest of the screen's life. A root-level reset
  // would make that unwedgeable, but React Native has no capture-phase touch
  // handler (onTouchStartCapture is a DOM prop and does not typecheck here), and
  // routing it through onStartShouldSetPanResponderCapture would depend on
  // responder capture running before a child's onTouchStart - true in the
  // classic event plugin order, not something worth betting the gesture on
  // under Fabric without a device to prove it. This is the same set/clear the
  // tabs row has shipped with.
  const hRailTouchRef = useRef(false);
  // One step per gesture — armed on grant, spent the moment a step fires.
  const swipeFiredRef = useRef(false);

  // Step the sub-tab for a decisive horizontal gesture. On Posts, rightward
  // moves never reach here (the outer pager owns the live exit drag); the
  // navigate('music') branch is only a release-time safety net.
  const stepForGesture = (dx: number, allowExit: boolean) => {
    const keys = orderedKeysRef.current;
    const idx = keys.indexOf(activeTabRef.current);
    if (dx < 0) {
      if (idx < keys.length - 1) { swipeFiredRef.current = true; setActiveTab(keys[idx + 1]); }
    } else if (idx === 0) {
      // Swipe-driven exit to the Music tab (release-time fallback when the outer
      // pager didn't claim the drag) — tick like any swipe landing on a new tab.
      if (allowExit) { swipeFiredRef.current = true; tabTick(); (navigation as any).navigate('music'); }
    } else {
      swipeFiredRef.current = true; setActiveTab(keys[idx - 1]);
    }
  };

  const pageSwipePan = useRef(PanResponder.create({
    // Forgiving dominance bar (1.25×) so slightly diagonal side-swipes register.
    // On Posts, rightward moves are left to the OUTER pager (the live exit
    // drag) — claiming them here would kill its finger tracking.
    onMoveShouldSetPanResponder: (_e, g) =>
      Platform.OS !== 'android' && // Android: stepper never claims — pager owns swipes, sub-tabs are taps
      !hRailTouchRef.current &&
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
  useFocusEffect(useCallback(() => { fetchProfile().catch(() => { setLoading(false); setRefreshing(false); }); }, []));

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
    if (postsRes.data) {
      const visible = postsRes.data.filter((p: any) => !p.archived_at);
      setUserPosts(visible);
      // Flag which of these are currently spotlighted (one batched query).
      fetchSpotlightedPostIds(visible.map((p: any) => p.id)).then(setSpotlightIds);
    }
    // Albums, same as the visited profile draws them — the point of this tab is
    // to be what a visitor sees. Swallowed failure: on a database without
    // albums.sql the shelf is simply absent rather than taking the profile down.
    if (user?.id) fetchAlbums(user.id).then(setAlbums).catch(() => setAlbums([]));
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
    return <View style={[styles.loadingContainer, { justifyContent: 'flex-start' }]}><ProfileSkeleton /></View>;
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
  // The custom Posts-grid layout, if the user has one AND still qualifies for its
  // tier (activeLayout re-checks earned tier + resolves blocks against live posts).
  const pageLayout = activeLayout(badgeProfile, userPosts);
  // Light mode: a SOLID accent pill so the active tab clearly separates from the
  // white background (a faint tint let light/metallic badge colors blend in).
  // Dark/grey keep the softer tinted pill (they already read fine).
  const solidActive = mode === 'light';
  const activeTabDyn = solidActive
    ? {
        backgroundColor: tabAccent, borderColor: tabAccent,
        shadowColor: tabAccent, shadowOpacity: 0.32, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 3,
      }
    : {
        backgroundColor: tabAccent + '1F', borderColor: tabAccent + '4D',
        shadowColor: tabAccent, shadowOpacity: 0.28, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 2,
      };
  // On the solid pill, text/icon flip to black/white for contrast; otherwise the
  // accent color on the tinted pill (unchanged).
  const activeContent = solidActive ? readableOn(tabAccent) : tabAccent;

  function dataForTab(key: string) {
    switch (key) {
      case 'music': return userPosts.filter(p => p.type === 'audio');
      case 'videos': return userPosts.filter(p => p.type === 'video');
      case 'reposts': return repostedPosts;
      // The GRID, and only the grid, honours hide_from_grid — the whole point is
      // that the post is still there on its own tab. This is also why the owner
      // sees it hidden here too: the tab is meant to be what a visitor sees, and
      // a preview that quietly shows more than the public gets is not one.
      default: return userPosts.filter(p => !p.hide_from_grid); // posts
    }
  }
  // Hiding is offered only while a picture is left to fill the grid. Slideshows
  // count — they are pictures — and archived posts do not, since they are
  // already off the profile.
  const hasGridPicture = userPosts.some((p: any) => p.type === 'image' || isSlideshow(p.type));
  // A post PLACED IN THE TEMPLATE cannot be hidden from the grid. The template
  // is an arrangement of specific posts into specific slots; hiding one would
  // punch a hole in a layout its owner built deliberately, and the fix for that
  // ("why is my page broken?") is nowhere near the menu that caused it. Taking
  // it out of the template first is the honest order of operations.
  //
  // A PLAIN computation, not useMemo. Everything from here down runs after the
  // `if (loading) return <ProfileSkeleton/>` above, so a hook placed here is
  // called on loaded renders and skipped on loading ones — "rendered more hooks
  // than during the previous render", which is exactly what it did. pageLayout
  // and hasGridPicture beside it are plain for the same reason, and this costs
  // one loop over a handful of layout blocks.
  const layoutUsedIds = pageLayout ? usedPostIds(pageLayout.blocks) : new Set<string>();
  const canHide = (postId: string) => hasGridPicture && !layoutUsedIds.has(postId);

  // Posts tab ordering: float live-spotlighted posts to the TOP (newest-first
  // among them), everyone else newest-first. When a spotlight expires the post
  // drops out of spotlightIds → it returns to default placement. Skipped entirely
  // if the user runs a custom page layout — then their own arrangement wins.
  function orderPostsForGrid(data: any[]) {
    if (pageLayout) return data;
    return [...data].sort((a, b) => {
      const sa = spotlightIds.has(a.id) ? 1 : 0;
      const sb = spotlightIds.has(b.id) ? 1 : 0;
      if (sa !== sb) return sb - sa;
      return String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
    });
  }

  // Public playlists as showcase cards: cover art, name, listen count.
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

  // Music tab: a scrollable list of "sound cards" (spotify-style TrackRows),
  // newest at the top — NOT the picture-thumbnail grid the other tabs use. The
  // main Posts grid still shows audio posts as thumbnails (renderGrid, default).
  // Deliberately a copy of the visited profile's shelf, down to the sizes. This
  // tab exists so the owner can see what a visitor sees; a shelf that is subtly
  // different here would be showing them something nobody else gets.
  function renderAlbumShelf() {
    if (albums.length === 0) return null;
    return (
      <View style={styles.albumShelf}>
        <Text style={styles.albumShelfLabel}>{t('album.shelf')}</Text>
        {/* Same stand-down as the tabs row: without it, flicking along the
            albums also steps to the next sub-tab, because the page responder
            and this shelf are competing for the identical gesture. */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.albumShelfRow}
          onTouchStart={() => { hRailTouchRef.current = true; }}
          onTouchEnd={() => { hRailTouchRef.current = false; }}
          onTouchCancel={() => { hRailTouchRef.current = false; }}
        >
          {albums.map((a) => {
            const cover = albumCover(a);
            return (
              <TouchableOpacity key={a.id} style={styles.albumCard} onPress={() => router.push(`/album/${a.id}`)} activeOpacity={0.85}>
                {cover ? (
                  <Image source={{ uri: cover }} style={styles.albumCardCover} contentFit="cover" cachePolicy="memory-disk" />
                ) : (
                  <View style={[styles.albumCardCover, styles.albumCardCoverEmpty]}>
                    <Ionicons name="disc" size={26} color={colors.textTertiary} />
                  </View>
                )}
                <Text style={styles.albumCardTitle} numberOfLines={1}>{a.title}</Text>
                <Text style={styles.albumCardMeta} numberOfLines={1}>{countLabel('track', a.track_count ?? 0)}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>
    );
  }

  // Opening a pick: a song plays and raises the player, an album opens its
  // screen. The rotator itself is shared with the visited profile.
  function openFeatured(item: FeaturedItem) {
    if (item.kind === 'album') { router.push(`/album/${item.id}`); return; }
    if (!item.uri) return;
    playQueue([{ id: item.id, uri: item.uri, caption: item.title, artist: profile?.display_name ?? '', cover: item.cover }], 0);
    expand();
  }

  function renderFeatured(list: FeaturedItem[], onEdit?: () => void) {
    if (list.length === 0 && !onEdit) return null;
    return (
      <View style={styles.featuredWrap}>
        <View style={styles.shelfHead}>
          <Text style={styles.sectionLabel}>{t('featured.shelf')}</Text>
          {!!onEdit && (
            <TouchableOpacity onPress={onEdit} hitSlop={8}>
              <Text style={styles.shelfAction}>{list.length ? t('common.edit') : t('featured.choose')}</Text>
            </TouchableOpacity>
          )}
        </View>
        <FeaturedRotator items={list} artist={profile?.display_name ?? ''} onPress={openFeatured} />
      </View>
    );
  }

  function renderMusicList(data: any[]) {
    // A song that belongs to an album is shown IN that album and not again in
    // the list below it. The albums shelf is not a summary of the music — it is
    // where that music now lives, which is what makes "Singles" underneath mean
    // something rather than being a heading over the same songs again.
    const inAlbum = new Set<string>();
    albums.forEach((a) => (a.tracks ?? []).forEach((tr) => inAlbum.add(tr.post_id)));
    const featured = resolveFeatured((profile as any)?.music_featured, data, albums);
    // Live-spotlighted tracks float to the top (newest-first among them), the
    // rest most-recent → least-recent.
    const singles = data.filter((p) => !inAlbum.has(p.id)).sort((a, b) => {
      const sa = spotlightIds.has(a.id) ? 1 : 0;
      const sb = spotlightIds.has(b.id) ? 1 : 0;
      if (sa !== sb) return sb - sa;
      return String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
    });
    const canFeature = isPremium && data.length > 0;

    // Empty only when there is genuinely nothing — an album with every song
    // archived out of it still counts as something to show.
    if (albums.length === 0 && singles.length === 0 && featured.length === 0) {
      return (
        <View>
          {canFeature && <View style={styles.musicList}>{renderFeatured([], () => router.push('/music-featured'))}</View>}
          <View style={styles.emptyGrid}>
            <Ionicons name="musical-notes-outline" size={40} color={colors.textTertiary} />
            <Text style={styles.emptyGridText}>{t('profile.noMusic')}</Text>
          </View>
        </View>
      );
    }

    const queue = singles.map((t) => ({
      id: t.id, uri: t.media_url, caption: t.caption,
      artist: t.profiles?.display_name ?? profile?.display_name ?? '', cover: t.cover_url,
    }));
    return (
      <View style={styles.musicList}>
        {/* Featured, then albums, then singles — the same order a visitor gets.
            The only owner-only thing here is the small Edit beside the Featured
            label, which sits inside that section rather than above everything so
            the public-looking part of the tab stays contiguous. */}
        {renderFeatured(featured, canFeature ? () => router.push('/music-featured') : undefined)}
        {renderAlbumShelf()}
        {singles.length > 0 && albums.length > 0 && (
          <Text style={styles.sectionLabel}>{t('music.singles')}</Text>
        )}
        {singles.map((track, i) => (
          <TrackRow
            hidePlayButton
            key={track.id}
            caption={track.caption}
            artist={track.profiles?.display_name ?? profile?.display_name ?? ''}
            username={track.profiles?.username ?? profile?.username ?? ''}
            duration={track.duration_seconds}
            streams={track.stream_count ?? 0}
            cover={track.cover_url}
            badgeProfile={badgeProfile}
            badgeOwnerId={profile?.id}
            spotlighted={spotlightIds.has(track.id)}
            isPlaying={playingId === track.id}
            trackId={track.id}
            onPlay={() => playQueue(queue, i)}
            onCoverPress={() => { playQueue(queue, i); expand(); }}
            onOptions={() => showOptions({
              postId: track.id,
              isOwn: true,
              mediaType: track.type,
              // Reachable from HERE as well as the grid, and that matters: once
              // a song is hidden the grid is exactly where it no longer is, so
              // the Music tab has to be the way back.
              hideFromGrid: !!track.hide_from_grid,
              canHideFromGrid: canHide(track.id),
              onGridVisibilityChanged: (hidden) => setUserPosts(prev =>
                prev.map(p => (p.id === track.id ? { ...p, hide_from_grid: hidden } : p))),
              onEdit: () => router.push(`/edit-post/${track.id}`),
              onDeleted: () => {
                setUserPosts(prev => prev.filter(p => p.id !== track.id));
                setStats(prev => ({ ...prev, posts: Math.max(0, prev.posts - 1) }));
              },
              onArchived: () => {
                setUserPosts(prev => prev.filter(p => p.id !== track.id));
                setStats(prev => ({ ...prev, posts: Math.max(0, prev.posts - 1) }));
              },
            })}
          />
        ))}
      </View>
    );
  }

  // Open an image post, or a reel, expanding out of the tapped cell (shared by
  // the normal grid and the custom layout blocks).
  //
  // A SLIDESHOW goes to reels here, the same as it does from the home feed and
  // from another user's profile: tapping the same content in three places
  // should not land in three different viewers. (No Listen-mode confirm on this
  // screen — unlike the visited-profile copy, it never had one.)
  function openVisual(post: any, node?: any) {
    const immersive = post.type === 'video' || isSlideshow(post.type);
    const pathname = immersive ? '/reel/[id]' : '/post/[id]';
    const seed = JSON.stringify(post);
    if (node?.measureInWindow) {
      node.measureInWindow((x: number, y: number, width: number, height: number) =>
        router.push({ pathname, params: { id: post.id, post: seed, src: JSON.stringify({ x, y, width, height }) } }));
    } else {
      router.push({ pathname, params: { id: post.id, post: seed } });
    }
  }

  // Own-post options sheet (edit / delete / archive) — used by long-press in both
  // the normal grid and the custom layout blocks.
  function showPostOptions(post: any) {
    showOptions({
      postId: post.id,
      isOwn: true,
      mediaType: post.type,
      aspect: post.aspect_ratio,
      caption: post.caption,
      thumbnail: post.thumbnail_url,
      hideFromGrid: !!post.hide_from_grid,
      canHideFromGrid: canHide(post.id),
      // Written through the local list rather than refetched: the post is only
      // leaving one grid, and reloading the whole profile to move one square
      // would lose the scroll position it was tapped from.
      onGridVisibilityChanged: (hidden) => setUserPosts(prev =>
        prev.map(p => (p.id === post.id ? { ...p, hide_from_grid: hidden } : p))),
      onEdit: () => router.push(`/edit-post/${post.id}`),
      onDeleted: () => { setUserPosts(prev => prev.filter(p => p.id !== post.id)); setStats(prev => ({ ...prev, posts: Math.max(0, prev.posts - 1) })); },
      onArchived: () => { setUserPosts(prev => prev.filter(p => p.id !== post.id)); setStats(prev => ({ ...prev, posts: Math.max(0, prev.posts - 1) })); },
    });
  }

  // The Posts tab: a custom feature layout (when active) above the normal grid of
  // any leftover posts, or just the normal grid.
  function renderPostsTab() {
    const data = dataForTab('posts');
    if (!pageLayout) return renderGrid(orderPostsForGrid(data), 'posts');
    const used = usedPostIds(pageLayout.blocks);
    const leftovers = data.filter(p => !used.has(p.id));
    return (
      <>
        <ProfileLayoutGrid
          layout={pageLayout}
          posts={userPosts}
          ownerTier={rawTier(badgeProfile)}
          spotlightIds={spotlightIds}
          playingId={playingId}
          artistName={profile?.display_name}
          // Pause the looping hero when this sub-tab is hidden or the profile is
          // off-screen — a detached VideoView that plays to its end stalls black.
          active={activeTab === 'posts' && isFocused}
          onOpenVisual={openVisual}
          onPlaySongs={(queue, idx) => playQueue(queue, idx)}
          onLongPressPost={showPostOptions}
        />
        {leftovers.length > 0 && renderGrid(leftovers, 'posts')}
      </>
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
            {t(`profile.empty.${tabKey}`)}
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
                    aspect: post.aspect_ratio,
                    caption: post.caption,
                    thumbnail: post.thumbnail_url,
                    hideFromGrid: !!post.hide_from_grid,
                    canHideFromGrid: canHide(post.id),
                    onGridVisibilityChanged: (hidden) => setUserPosts(prev =>
                      prev.map(p => (p.id === post.id ? { ...p, hide_from_grid: hidden } : p))),
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
                const immersive = post.type === 'video' || isSlideshow(post.type);
                const pathname = immersive ? '/reel/[id]' : '/post/[id]';
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
            ) : isAudioPost(post.type) && post.cover_url ? (
              <>
                <Image source={{ uri: post.cover_url }} style={styles.gridImage} contentFit="cover" />
                <View style={styles.gridPlayOverlay}>
                  <Ionicons name="musical-notes" size={13} color="#fff" />
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
            {/* Subtle yellow sparkle when this post has a live spotlight. */}
            {spotlightIds.has(post.id) && <SpotlightThumbBadge />}
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
        <View style={styles.headerActions}>
          <TouchableOpacity
            onPress={() => setQrVisible(true)}
            style={styles.settingsBtn}
            accessibilityRole="button"
            accessibilityLabel={t('qr.a11y')}
            disabled={!profile?.id}
          >
            <Ionicons name="qr-code-outline" size={22} color={colors.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.settings')} onPress={() => router.push('/settings')} style={styles.settingsBtn}>
            <Ionicons name="settings-outline" size={22} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      </View>

      {!!profile?.id && (
        <ProfileQRModal
          visible={qrVisible}
          onClose={() => setQrVisible(false)}
          userId={profile.id}
          username={profile.username}
          displayName={profile.display_name}
          avatarUrl={avatarUrl}
        />
      )}

      {/* Banner — tinted by the user's chosen profile theme (gated by tier) */}
      <LinearGradient colors={bannerColors} style={styles.banner}>
        <View style={styles.avatarWrap}>
          <StoryAvatar
            userId={profile?.id}
            avatarUrl={avatarUrl}
            name={profile?.display_name}
            size={88}
            badgeRing={specialRingTier(myTier) ? ringColors : undefined}
            onPressProfile={() => router.push('/edit-profile')}
            showAdd
            addColors={myTier ? ringColors : undefined}
            onPressAdd={openCamera}
          />
        </View>
        <View style={styles.statsRow}>
          {[
            { label: t('profile.tab.posts'), val: stats.posts, onPress: undefined },
            { label: t('profile.followers'), val: stats.followers, onPress: () => router.push(`/followers/${profile?.id}`) },
            { label: t('profile.following'), val: stats.following, onPress: () => router.push(`/following/${profile?.id}`) },
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
                <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.add')}
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
              ? <TranslatableText text={profile.bio} style={styles.bio} />
              : <Text style={styles.bioEmpty}>{t('profile.noBio')}</Text>
            }
            {badgeProfile?.link ? (
              <TouchableOpacity style={styles.linkRow} onPress={() => linkGuard.open(badgeProfile.link!, { context: 'bio' })}>
                <Ionicons name="link-outline" size={14} color={colors.text} />
                <Text style={styles.linkText} numberOfLines={1}>{displayUrl(badgeProfile.link)}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          <View style={styles.sideBtns}>
            <TouchableOpacity
              style={styles.shopBtn}
              activeOpacity={0.8}
              // With pending activity the tap lands straight on the Orders tab
              // (the thing the red dot is about); otherwise My Shop as usual.
              onPress={() => router.push(shopAlertCount > 0 ? '/shop?tab=orders' : '/shop?tab=mine')}
            >
              {/* Word only. On your OWN profile this sits beside Spotlight in a
                  row of word buttons, so a lone glyph made it the odd one out.
                  Someone else's profile keeps its storefront icon — there the
                  button has to announce that this person HAS a shop, rather than
                  just label a place you already know is yours. */}
              <Text style={styles.shopBtnText}>{t('shop.title')}</Text>
              {/* Unaddressed/unseen shop activity (new sale request, delivered
                  file, declined offer) — same red alert treatment as the
                  notification/message bells, anchored top-left per design. */}
              {shopAlertCount > 0 && (
                <View style={styles.shopAlertDot}>
                  <Text style={styles.shopAlertText}>{shopAlertCount > 9 ? '9+' : shopAlertCount}</Text>
                </View>
              )}
            </TouchableOpacity>
            {/* Galaxy-purple pill with a twinkling star field, matching the
                Spotlight card in Settings — see components/SpotlightButton. */}
            <SpotlightButton label="Spotlight" onPress={() => router.push('/spotlight')} />
          </View>
        </View>
      </View>

      {/* Action buttons */}
      <View style={styles.actionButtons}>
        <TouchableOpacity style={styles.editButton} onPress={() => router.push('/edit-profile')}>
          <Text style={styles.editButtonText}>{t('profile.editProfile')}</Text>
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.people')} style={styles.secondaryButton} onPress={() => router.push('/friends')}>
          <Ionicons name="people-outline" size={18} color={colors.text} />
        </TouchableOpacity>
      </View>

      {/* Tabs — tap to switch; swiping ON this row scrolls the pills
          (traversal) rather than stepping the sub-tab.

          The pills SHARE the row whenever they fit in it, so three of them span
          the same width five did. This strip was drawn for five and filled the
          screen; now that empty showcases are dropped it can be three, and both
          of the obvious answers look broken — left-aligned leaves a third of the
          screen blank beside them, centred leaves a sixth on either side.

          Conditional on fitting, because five tabs genuinely do overflow a phone
          and an overflowing row has to stay scrollable and start at its first
          item. It settles rather than oscillating: the pills cannot shrink, so a
          row too wide for the viewport still measures too wide and keeps
          scrolling. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tabsScroll}
        onLayout={(e) => setTabsViewportW(e.nativeEvent.layout.width)}
        onContentSizeChange={(w) => setTabsContentW(w)}
        contentContainerStyle={tabsFit ? styles.tabsContentFit : undefined}
        onTouchStart={() => { hRailTouchRef.current = true; }}
        onTouchEnd={() => { hRailTouchRef.current = false; }}
        onTouchCancel={() => { hRailTouchRef.current = false; }}
      >
        <View style={[styles.tabsRow, tabsFit && styles.tabsRowFit]}>
          {orderedTabs.map((tab) => (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tab, tabsFit && styles.tabFit, activeTab === tab.key && activeTabDyn]}
              onPress={() => setActiveTab(tab.key)}
            >
              <Ionicons
                name={activeTab === tab.key ? tab.icon.replace('-outline', '') as any : tab.icon as any}
                size={16}
                color={activeTab === tab.key ? activeContent : inactiveTabTint}
              />
              <Text style={[
                styles.tabText,
                activeTab === tab.key ? { color: activeContent, fontWeight: '700' } : { color: inactiveTabTint },
              ]}>
                {t(`profile.tab.${tab.key}`)}
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
                <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchProfile().catch(() => { setLoading(false); setRefreshing(false); }); }} tintColor={tabAccent} colors={[tabAccent]} />
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
  loadingContainer: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },

  headerBar: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: SPACING.md, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.sm,
  },
  usernameHeader: { color: colors.text, fontSize: 24, fontWeight: '900' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
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
    backgroundColor: 'rgba(0,0,0,0.28)', borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', paddingVertical: SPACING.sm,
  },
  statItem: { flex: 1, alignItems: 'center', gap: 3 },
  statNumber: { color: '#FFFFFF', fontSize: 21, fontWeight: '800', letterSpacing: -0.3 },
  statLabel: { color: 'rgba(245,245,245,0.7)', fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 },

  infoSection: { paddingHorizontal: SPACING.md, paddingTop: SPACING.md },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  infoLeft: { flex: 1, gap: 4 },
  // Shop (green) stacked above Spotlight (orange) — both solid with white text.
  sideBtns: { gap: SPACING.sm, alignItems: 'stretch' },
  // No gap: the label is the only child in flow now (the alert dot is
  // absolutely positioned), so there is nothing left to space.
  shopBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.success,
    borderRadius: RADIUS.full,
    paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md,
  },
  shopBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  // Red alert circle (top-left of the Shop button) for unaddressed/unseen shop
  // activity — same recipe as the home header's notification badge, with a
  // background ring so it pops off the green pill.
  shopAlertDot: {
    position: 'absolute', top: -5, left: -5,
    minWidth: 17, height: 17, borderRadius: 8.5,
    backgroundColor: colors.error, paddingHorizontal: 3,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: colors.background,
  },
  shopAlertText: { color: '#fff', fontSize: 9, fontWeight: '800' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  displayName: { color: colors.text, fontSize: 17, fontWeight: '800', letterSpacing: -0.2 },
  badgeOutline: {
    width: 19, height: 19, borderRadius: RADIUS.full,
    borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center',
  },
  bio: { color: colors.textSecondary, fontSize: 14, lineHeight: 20 },
  bioEmpty: { color: colors.textTertiary, fontSize: 14, fontStyle: 'italic' },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  // Palette, not literal #fff — white would disappear on the light theme's
  // off-white paper. Mirrors app/profile/[id].tsx.
  linkText: { color: colors.text, fontSize: 13, fontWeight: '600' },

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
  // While the pills fit, the row SPANS the width and they share it — rather than
  // bunching left (dead space beside them) or centred (dead space either side).
  // Both of those read as a strip with something missing from it.
  tabsContentFit: { flexGrow: 1 },
  tabsRowFit: { flexGrow: 1 },
  // flexGrow with flexShrink 0 and a natural basis, deliberately, not flexBasis 0.
  //
  // Equal widths would be prettier by a hair and would truncate "Playlists" the
  // moment a fourth pill appears — and worse, it would break the fit measurement
  // this depends on: pills that can shrink always report content exactly the
  // width of the viewport, so the row would never admit to overflowing and would
  // squeeze five tabs into a phone instead of letting them scroll. Growing from
  // a natural basis fills the row, keeps every label whole, and still overflows
  // honestly when there are too many.
  tabFit: { flexGrow: 1, flexShrink: 0, justifyContent: 'center' },
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

  // 2px gutters between cells (gap needs pixel-sized items — thirds would overflow the row).
  postsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 2 },
  // ── Album shelf ─────────────────────────────────────────────────────────────
  // Identical to the visited profile's, on purpose — see renderAlbumShelf.
  // Section headings inside musicList, which already supplies the horizontal
  // padding — so this one must NOT add its own. albumShelfLabel does, because
  // the shelf bleeds past that padding to run its rail to the screen edge, and
  // reusing it here indented Singles further than every other line on the tab.
  sectionLabel: {
    color: quietText(colors), fontSize: 12, fontWeight: '800',
    letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: SPACING.xs,
  },
  featuredWrap: { marginBottom: SPACING.md },
  albumShelf: { marginHorizontal: -SPACING.md, marginBottom: SPACING.md },
  albumShelfLabel: {
    color: quietText(colors), fontSize: 12, fontWeight: '800',
    letterSpacing: 0.6, textTransform: 'uppercase',
    paddingHorizontal: SPACING.md, marginBottom: SPACING.sm,
  },
  albumShelfRow: { paddingHorizontal: SPACING.md, gap: SPACING.md },
  // Label and its owner-only action on one line, so the action reads as part of
  // the section rather than a control floating above the tab.
  shelfHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  shelfAction: { color: colors.primaryLight, fontSize: 13, fontWeight: '700', marginBottom: SPACING.xs },
  albumCard: { width: 124 },
  albumCardCover: { width: 124, height: 124, borderRadius: RADIUS.md, backgroundColor: colors.surfaceLight },
  albumCardCoverEmpty: { alignItems: 'center', justifyContent: 'center' },
  albumCardTitle: { color: colors.text, fontSize: 13.5, fontWeight: '700', marginTop: 7 },
  albumCardMeta: { color: quietText(colors), fontSize: 12, marginTop: 1 },

  musicList: { paddingHorizontal: SPACING.md, paddingTop: SPACING.sm, gap: SPACING.sm },
  gridItem: { width: (SCREEN_W - 4) / 3, aspectRatio: 1, position: 'relative' },
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
