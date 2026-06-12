import {
  View, Text, StyleSheet, FlatList, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert, TextInput, Modal, Image, Dimensions, RefreshControl, Keyboard,
  KeyboardAvoidingView, Platform, TouchableWithoutFeedback, PanResponder, Animated, Easing,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { useAudioPlayer } from '../../hooks/useAudioPlayer';
import { useAudio } from '../../contexts/AudioContext';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import AddToPlaylistModal from '../../components/AddToPlaylistModal';
import PlaylistEditor from '../../components/PlaylistEditor';
import TrackRow from '../../components/TrackRow';
import { usePostOptions } from '../../contexts/PostOptionsContext';
import { useTabSwipeControl } from '../../contexts/PagerContext';
import { useListenMode } from '../../contexts/ListenModeContext';
import { useProfile } from '../../contexts/ProfileContext';
import { fetchBlockedIds } from '../../lib/blocks';
import { formatCount } from '../../lib/format';
import { rawTier, publicPlaylistLimit, tierLabel, tierRank } from '../../lib/badges';
import { activePublicIds, fetchFirstTrackCovers } from '../../lib/playlists';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { GENRES, CONTENT_TAGS, isAudioPost } from '../../lib/genres';
import { postMatchTier, profileMatchTier } from '../../lib/searchRank';
import StoryAvatar from '../../components/StoryAvatar';
import FollowButton from '../../components/FollowButton';
import {
  buildAffinityProfile, loadSeenPostIds, scorePost,
  sortRailByAffinity, EMPTY_PROFILE, type UserAffinityProfile,
} from '../../lib/feedScorer';

const SCREEN_W           = Dimensions.get('window').width;
const FOR_YOU_W          = Math.floor((SCREEN_W - SPACING.md * 2 - SPACING.md) / 2.3);
const TODAYS_PICK_KEY    = 'todays_pick_v2';
// Listen mode is STRICTLY music: these genres never enter the curated mix
// (podcasts/audiobooks are separate post types, excluded by type='audio').
const NON_MUSIC_GENRES   = new Set(['meme', 'life']);
// Listen-mix recommendation sweet spot: full songs (1:30–3:00) outrank
// snippets and overlong tracks.
const LISTEN_SWEET_MIN_S = 90;
const LISTEN_SWEET_MAX_S = 180;
const LISTEN_SWEET_BOOST = 1.3;
const TODAYS_PICK_TTL_MS = 18 * 60 * 60 * 1000; // 18 hours
// Discover content refreshes on a 4-day cadence. A manual pull-to-refresh only
// triggers an actual refetch once this window has elapsed; within it, pulling
// is a no-op (the curated content intentionally stays put).
const DISCOVER_TS_KEY    = 'discover_refreshed_at';
const DISCOVER_TTL_MS    = 4 * 24 * 60 * 60 * 1000; // 4 days

type ContentType = 'music' | 'podcast' | 'audiobook';

// A horizontal rail that suppresses the outer page swipes ONLY while it can
// actually scroll (content wider than its frame). A rail with one or two cards
// — or empty trailing space across the whole row — lets tab/pill swipes pass
// straight through instead of dead-zoning the row.
function GuardedRail({ onGuardStart, onGuardEnd, ...props }: any) {
  const frameW = useRef(0);
  const contentW = useRef(0);
  const guarding = useRef(false);
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      {...props}
      onLayout={(e: any) => { frameW.current = e.nativeEvent.layout.width; props.onLayout?.(e); }}
      onContentSizeChange={(w: number, h: number) => { contentW.current = w; props.onContentSizeChange?.(w, h); }}
      onTouchStart={(e: any) => {
        if (contentW.current > frameW.current + 1) { guarding.current = true; onGuardStart(); }
        props.onTouchStart?.(e);
      }}
      onTouchEnd={(e: any) => {
        if (guarding.current) { guarding.current = false; onGuardEnd(); }
        props.onTouchEnd?.(e);
      }}
      onTouchCancel={(e: any) => {
        if (guarding.current) { guarding.current = false; onGuardEnd(); }
        props.onTouchCancel?.(e);
      }}
    />
  );
}

type Playlist = { id: string; name: string; is_public: boolean; created_at: string; play_count?: number; cover?: string | null };
type Track = {
  post_id: string; position: number;
  posts: {
    id: string; media_url: string; caption: string; user_id: string;
    stream_count?: number; cover_url?: string | null;
    profiles: { id: string; username: string; display_name: string; avatar_url: string | null };
  };
};

export default function MusicScreen() {
  const { show: showOptions } = usePostOptions();
  const { listenMode, setListenMode } = useListenMode();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [tracksLoading, setTracksLoading] = useState(false);
  // Edit mode inside one of the user's own playlists: multi-select removal +
  // drag-to-reorder (positions persisted on drop).
  const [editingPlaylist, setEditingPlaylist] = useState(false);
  const [showNewPlaylist, setShowNewPlaylist] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [newPlaylistPublic, setNewPlaylistPublic] = useState(false);
  const { playingId, play } = useAudioPlayer();
  const { playQueue, expand, currentTrack } = useAudio();
  const [savedTracks, setSavedTracks] = useState<any[]>([]);
  const [playlistModalPostId, setPlaylistModalPostId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<'discover' | 'playlists' | 'saved' | 'liked' | 'community'>('discover');
  const [likedTracks, setLikedTracks] = useState<any[]>([]);
  const [savedRefreshing, setSavedRefreshing] = useState(false);
  const [likedRefreshing, setLikedRefreshing] = useState(false);
  // Everyone's public playlists, ranked by listens — feeds the Discover
  // Popular/Upcoming rails; tapping a card opens the community detail view.
  const [communityPlaylists, setCommunityPlaylists] = useState<any[]>([]);
  const [selectedCommunity, setSelectedCommunity] = useState<any | null>(null);
  // Playlists already counted as "listened to" this session — one bump each.
  const bumpedPlaylistsRef = useRef<Set<string>>(new Set());
  const { profile } = useProfile();
  // Public-playlist creation is gated by the user's EARNED badge tier
  // (none 0 / bronze 1 / silver 2 / gold 3 / diamond 6); deleting frees a slot.
  const myPublicCount = playlists.filter(p => p.is_public).length;
  const myPublicLimit = publicPlaylistLimit(rawTier(profile));
  // Public playlists past the tier limit (after a demotion) are LOCKED: kept
  // and owner-playable, greyed out + hidden from discovery. Most-listened keep
  // their slots; the user can rearrange by toggling playlists private/public.
  const myActivePublicIds = activePublicIds(playlists, rawTier(profile));

  // ── Dwell-swipe rule ────────────────────────────────────────────────────────
  // After 4 consecutive seconds on the Music page, horizontal swipes stop
  // changing APP tabs and instead step through the view pills
  // (Discover → Playlists → Liked → Saved). At the edges they fall through to
  // the app pager again: swiping back past Discover goes to the previous app
  // page, swiping forward past Saved goes to the next. Implemented with the
  // app's proven mechanisms (TabSwipeContext + a fling PanResponder) — NOT a
  // nested pager, which is a known freeze trap in this codebase.
  const navigation = useNavigation<any>();
  const setTabSwipe = useTabSwipeControl();
  const innerSwipeRef = useRef(false);
  const activeViewRef = useRef(activeView);
  activeViewRef.current = activeView;

  useFocusEffect(useCallback(() => {
    const t = setTimeout(() => {
      innerSwipeRef.current = true;
      setTabSwipe(false); // outer pager off — swipes now belong to the pills
    }, 4000);
    return () => {
      clearTimeout(t);
      innerSwipeRef.current = false;
      setTabSwipe(true); // leaving Music resets the dwell rule
    };
  }, [setTabSwipe]));

  const VIEW_ORDER = ['discover', 'playlists', 'liked', 'saved'] as const;

  // Simple swipe transition between the pill views: the incoming view slides
  // in from the direction of travel (left when moving forward, right when
  // moving back) — fired by both pill taps and the dwell-swipe gesture.
  const viewAnimX = useRef(new Animated.Value(0)).current;
  const prevViewIdxRef = useRef(0);
  useEffect(() => {
    const idx = VIEW_ORDER.indexOf(activeView as any);
    if (idx < 0) return; // community detail — not part of the pill carousel
    if (idx !== prevViewIdxRef.current) {
      const dir = idx > prevViewIdxRef.current ? 1 : -1;
      viewAnimX.setValue(dir * SCREEN_W);
      Animated.timing(viewAnimX, {
        toValue: 0, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: true,
      }).start();
    }
    prevViewIdxRef.current = idx;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView]);
  // Horizontal rails (genres, playlist cards, artists, view pills): while a
  // finger is on one AND the rail can actually scroll, BOTH outer horizontal
  // gestures must stand down — the app tab pager (pre-dwell it would drag the
  // whole page mid-scroll) and the dwell-swipe pill stepper below. GuardedRail
  // measures content vs frame and only fires these when scrolling is real, so
  // sparse/empty rows still page-swipe. Restoring respects the dwell rule:
  // once armed, the outer pager stays off anyway.
  const railTouchRef = useRef(false);
  const railGuardStart = () => { railTouchRef.current = true; setTabSwipe(false); };
  const railGuardEnd = () => { railTouchRef.current = false; setTabSwipe(!innerSwipeRef.current); };

  const viewSwipePan = useRef(PanResponder.create({
    // Claim horizontal moves once the rule is armed — horizontal rails win the
    // gesture while the finger is on them (railTouchRef), and vertical lists
    // keep their scrolls (dx must dominate dy). The dominance bar is deliberately
    // forgiving (1.25×) so slightly diagonal side-swipes still count.
    onMoveShouldSetPanResponder: (_e, g) =>
      innerSwipeRef.current && !railTouchRef.current && Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.25,
    // Capture DECISIVE horizontal moves before a child list can lock them away —
    // without this, a swipe that grazes the vertical Discover scroll gets eaten.
    onMoveShouldSetPanResponderCapture: (_e, g) =>
      innerSwipeRef.current && !railTouchRef.current && Math.abs(g.dx) > 20 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    // Once claimed, NEVER surrender mid-gesture — a child stealing the responder
    // meant the release handler never ran and the swipe silently vanished.
    onPanResponderTerminationRequest: () => false,
    onPanResponderRelease: (_e, g) => {
      // Register on distance OR a quick flick — short fast side-swipes count.
      if (Math.abs(g.dx) < 40 && Math.abs(g.vx) < 0.3) return;
      const idx = VIEW_ORDER.indexOf(activeViewRef.current as any);
      if (idx < 0) return; // community detail etc. — leave swipes alone
      if (g.dx < 0) {
        // Finger moved left → forward. Past Saved → next app page.
        if (idx === VIEW_ORDER.length - 1) navigation.navigate('profile');
        else { setActiveView(VIEW_ORDER[idx + 1]); setSelectedPlaylist(null); setSelectedCommunity(null); }
      } else {
        // Finger moved right → back. Past Discover → previous app page.
        if (idx === 0) navigation.navigate('post');
        else { setActiveView(VIEW_ORDER[idx - 1]); setSelectedPlaylist(null); setSelectedCommunity(null); }
      }
    },
  })).current;
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const router = useRouter();

  // ─── Search state ──────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searchProfiles, setSearchProfiles] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);

  // ─── Discover tab state ────────────────────────────────────────────────────
  const [discoverGenre, setDiscoverGenre]       = useState('All');
  // Music genres + content-type tags, ordered by affinity (most-engaged first).
  const [orderedGenreList, setOrderedGenreList] = useState<string[]>([...GENRES, ...CONTENT_TAGS]);
  const [trendingTracks, setTrendingTracks]     = useState<any[]>([]);
  const [trendingLoading, setTrendingLoading]   = useState(false);
  const [trendingExpanded, setTrendingExpanded] = useState(false);
  // Top 20 most-streamed songs app-wide (pure stream_count chart, no affinity).
  const [top20Tracks, setTop20Tracks]           = useState<any[]>([]);
  const [top20Expanded, setTop20Expanded]       = useState(false);
  const [forYouTracks, setForYouTracks]         = useState<any[]>([]);
  const [todaysPick, setTodaysPick]             = useState<any | null>(null);
  const [discoverLoading, setDiscoverLoading]   = useState(true);
  const [discoverRefreshing, setDiscoverRefreshing] = useState(false);
  const affinityProfile = useRef<UserAffinityProfile>(EMPTY_PROFILE);
  const followingSetRef = useRef<Set<string>>(new Set());
  const seenRef         = useRef<Set<string>>(new Set());
  const blockedIdsRef   = useRef<Set<string>>(new Set()); // hide blocked artists from discover/search
  const discoverRefreshedAt = useRef(0); // epoch ms of the last 4-day refresh cycle

  useEffect(() => { setup(); }, []);

  // Debounced song search — matches song names (captions), usernames and display
  // names, ranked by relevancy like the explore page.
  useEffect(() => {
    if (searchQuery.trim().length === 0) { setSearchResults([]); setSearchProfiles([]); setSearching(false); return; }
    setSearching(true); // show immediately so "No songs found" doesn't flash during the debounce
    const t = setTimeout(() => runSearch(), 400);
    return () => clearTimeout(t);
  }, [searchQuery]);

  async function runSearch() {
    const term = searchQuery.trim();
    if (!term) return;
    setSearching(true);
    const ql = term.toLowerCase();

    // Profiles whose name/handle matches — used to pull in their songs AND, when
    // the match is strong (name starts with / equals the query), surfaced as
    // tappable profile results above the songs.
    const { data: rawProfiles } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, badge_tier, hidden')
      .or(`username.ilike.%${term}%,display_name.ilike.%${term}%`).limit(15);
    // Hidden accounts never appear in search.
    const matchedProfiles = (rawProfiles ?? []).filter((p: any) => !p.hidden);
    const authorIds = (matchedProfiles ?? []).map((p: any) => p.id);
    setSearchProfiles(
      (matchedProfiles ?? [])
        .filter((p: any) => p.id !== currentUserId && !blockedIdsRef.current.has(p.id) && profileMatchTier(p, ql) >= 2)
        .sort((a: any, b: any) => profileMatchTier(b, ql) - profileMatchTier(a, ql))
        .slice(0, 4),
    );

    let query = supabase
      .from('posts')
      .select('*, profiles!posts_user_id_fkey (username, display_name, avatar_url)')
      .eq('is_public', true)
      .in('type', ['audio', 'podcast', 'audiobook'])
      .limit(40);
    query = authorIds.length > 0
      ? query.or(`caption.ilike.%${term}%,user_id.in.(${authorIds.join(',')})`)
      : query.ilike('caption', `%${term}%`);

    const { data } = await query;
    if (data) {
      // Relevancy: closeness of match first, then the song's algorithm score.
      const now = Date.now();
      const ranked = [...data]
        .filter((p: any) => !blockedIdsRef.current.has(p.user_id))
        .sort((a: any, b: any) => {
          const ta = postMatchTier(a, ql), tb = postMatchTier(b, ql);
          if (tb !== ta) return tb - ta;
          return scorePost(b, affinityProfile.current, followingSetRef.current, new Set(), now) -
                 scorePost(a, affinityProfile.current, followingSetRef.current, new Set(), now);
        });
      setSearchResults(ranked);
    }
    setSearching(false);
  }

  // Keep saved songs and playlists fresh when returning to this tab
  // (e.g. after saving a track from the feed).
  useFocusEffect(
    useCallback(() => {
      if (currentUserId) {
        fetchSavedTracks(currentUserId);
        fetchLikedTracks(currentUserId);
        fetchPlaylists(currentUserId);
        // Refresh blocks so unblocking restores artists in search/discover.
        fetchBlockedIds().then(ids => { blockedIdsRef.current = ids; });
      }
    }, [currentUserId])
  );

  async function setup() {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      setCurrentUserId(user.id);
      // Load blocks early so search (which can fire before discover finishes) and
      // the discover sections both hide blocked artists.
      fetchBlockedIds().then(ids => { blockedIdsRef.current = ids; });
      await Promise.all([fetchPlaylists(user.id), fetchSavedTracks(user.id), fetchLikedTracks(user.id)]);
      fetchDiscoverData(user.id); // runs in background with its own loading state
    }
    setLoading(false);
  }

  async function fetchPlaylists(userId: string) {
    const { data } = await supabase.from('playlists').select('*').eq('user_id', userId).order('created_at', { ascending: false });
    if (!data) return;
    // Every playlist is faced with its first track's cover (public squares AND
    // private rows).
    const covers = await fetchFirstTrackCovers(data.map((p: any) => p.id));
    setPlaylists(data.map((p: any) => ({ ...p, cover: covers[p.id] ?? null })));
  }

  async function fetchSavedTracks(userId: string) {
    const { data } = await supabase
      .from('saves')
      .select('id, posts(id,media_url,caption,type,duration_seconds,stream_count,cover_url,user_id,profiles!posts_user_id_fkey(id,username,display_name,avatar_url))')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (data) setSavedTracks(data.filter((s: any) => isAudioPost(s.posts?.type)));
  }

  async function fetchLikedTracks(userId: string) {
    const { data } = await supabase
      .from('likes')
      .select('post_id, posts(id,media_url,caption,type,duration_seconds,stream_count,cover_url,user_id,profiles!posts_user_id_fkey(id,username,display_name,avatar_url))')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (data) setLikedTracks(data.filter((l: any) => isAudioPost(l.posts?.type)));
  }

  async function fetchPlaylistTracks(playlistId: string) {
    setTracksLoading(true);
    const { data } = await supabase
      .from('playlist_tracks')
      .select('post_id,position,posts(id,media_url,caption,stream_count,cover_url,user_id,profiles!posts_user_id_fkey(id,username,display_name,avatar_url))')
      .eq('playlist_id', playlistId)
      .order('position', { ascending: true });
    if (data) setTracks(data as any);
    setTracksLoading(false);
  }

  // Public playlists for the "User Playlists" tab, most-listened first. Each is
  // faced with the cover of its FIRST track (lowest position), joined with its
  // creator's profile; playlists from blocked users are dropped.
  async function fetchCommunityPlaylists() {
    try {
      // select('*') on purpose — tolerates updated_at not existing yet (the
      // Upcoming scoring just falls back to created_at).
      const [plsRes, blocked] = await Promise.all([
        supabase.from('playlists')
          .select('*')
          .eq('is_public', true)
          .order('play_count', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(60),
        fetchBlockedIds(),
      ]);
      const list = (plsRes.data ?? []).filter((p: any) => !blocked.has(p.user_id));
      if (!list.length) { setCommunityPlaylists([]); return; }

      const [tracksRes, profsRes] = await Promise.all([
        supabase.from('playlist_tracks')
          .select('playlist_id, position, posts(cover_url, thumbnail_url)')
          .in('playlist_id', list.map((p: any) => p.id))
          .order('position', { ascending: true }),
        supabase.from('profiles')
          .select('id, username, display_name, avatar_url, badge_tier, badge_show, profile_theme')
          .in('id', [...new Set(list.map((p: any) => p.user_id))]),
      ]);
      const profMap = Object.fromEntries((profsRes.data ?? []).map((p: any) => [p.id, p]));
      const coverOf: Record<string, string | null> = {};
      const countOf: Record<string, number> = {};
      for (const t of (tracksRes.data ?? []) as any[]) {
        countOf[t.playlist_id] = (countOf[t.playlist_id] || 0) + 1;
        if (!(t.playlist_id in coverOf)) {
          coverOf[t.playlist_id] = t.posts?.cover_url ?? t.posts?.thumbnail_url ?? null;
        }
      }
      // Enforce tier slots per creator: a demoted creator's over-limit
      // playlists are locked (greyed in their own lists) and hidden here.
      const byCreator: Record<string, any[]> = {};
      for (const p of list) (byCreator[p.user_id] ||= []).push(p);
      const activeIds = new Set<string>();
      for (const uid of Object.keys(byCreator)) {
        for (const id of activePublicIds(byCreator[uid], rawTier(profMap[uid]))) activeIds.add(id);
      }
      setCommunityPlaylists(list.filter((p: any) => activeIds.has(p.id)).map((p: any) => ({
        ...p,
        creator: profMap[p.user_id] ?? null,
        cover: coverOf[p.id] ?? null,
        trackCount: countOf[p.id] ?? 0,
      })));
    } catch {
      // Schema not applied yet / offline — the rails just stay hidden.
    }
  }

  // "Upcoming" momentum score: fresh activity dominates, early traction helps
  // (log-scaled so the big established playlists don't drown new ones), and the
  // creator's earned badge gives a small trust boost.
  function upcomingScore(p: any): number {
    const days = Math.max(0, (Date.now() - new Date(p.updated_at ?? p.created_at).getTime()) / 86400000);
    const recency = Math.exp(-days / 7);                      // ~halves each week
    const traction = Math.log10(1 + (p.play_count ?? 0));     // diminishing listens
    const badge = tierRank(rawTier(p.creator)) / 4;           // 0..1
    return recency * 3 + traction * 2 + badge;
  }

  // Split the community list into the two sections. The most-listened few are
  // "established" and stay in Popular no matter their momentum; everything else
  // competes for the Upcoming rail by score, and the rest fills Popular (which
  // keeps its most-listened ordering) — each playlist in exactly one section.
  // SMALL-ECOSYSTEM FALLBACK: while there are too few public playlists for the
  // split (everything is "protected"), both sections still render — Upcoming
  // scores ALL of them by momentum so the rail exists from day one.
  const POPULAR_PROTECT = 5;
  const protectedIds = new Set(communityPlaylists.slice(0, POPULAR_PROTECT).map((p: any) => p.id));
  const nonProtected = communityPlaylists.filter((p: any) => !protectedIds.has(p.id));
  const upcomingPool = nonProtected.length > 0 ? nonProtected : communityPlaylists;
  const upcomingPlaylists = upcomingPool
    .map((p: any) => ({ p, s: upcomingScore(p) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 10)
    .map(x => x.p);
  const upcomingIds = new Set(upcomingPlaylists.map((p: any) => p.id));
  const popularPlaylists = nonProtected.length > 0
    ? communityPlaylists.filter((p: any) => !upcomingIds.has(p.id))
    : communityPlaylists;

  // Start playback from a community playlist and count the listen — once per
  // playlist per session, never for the creator (the RPC re-checks both
  // public-ness and ownership server-side).
  function playCommunityTrack(index: number) {
    playQueue(playlistQueue(), index);
    const pl = selectedCommunity;
    if (!pl || pl.user_id === currentUserId || bumpedPlaylistsRef.current.has(pl.id)) return;
    bumpedPlaylistsRef.current.add(pl.id);
    supabase.rpc('bump_playlist_play', { p_playlist_id: pl.id }).then(undefined, () => {});
  }

  async function createPlaylist() {
    if (!newPlaylistName.trim() || !currentUserId) return;
    // Tier gate (checked at creation time): public slots come from the earned
    // badge tier. Private playlists are unlimited.
    if (newPlaylistPublic && myPublicCount >= myPublicLimit) {
      Alert.alert(
        'Public playlist limit',
        myPublicLimit === 0
          ? 'Public playlists need a badge. Earn Bronze for 1 slot, Silver for 2, Gold for 3, Diamond for 6 — you can still make private playlists anytime.'
          : `Your ${tierLabel(rawTier(profile))} badge allows ${myPublicLimit} public ${myPublicLimit === 1 ? 'playlist' : 'playlists'}. Delete one or earn a higher badge to add more.`,
      );
      return;
    }
    const { data, error } = await supabase.from('playlists')
      .insert({ user_id: currentUserId, name: newPlaylistName.trim(), is_public: newPlaylistPublic })
      .select().single();
    if (error) { Alert.alert('Error', error.message); return; }
    if (data) {
      setPlaylists(prev => [data, ...prev]);
      setNewPlaylistName('');
      setNewPlaylistPublic(false);
      setShowNewPlaylist(false);
    }
  }

  // Flip a playlist public/private. Going public needs a free tier slot —
  // the user frees one by making an active public playlist private (or by
  // earning a higher badge). Going private always works.
  async function setPlaylistVisibility(pl: Playlist, makePublic: boolean) {
    if (makePublic && myPublicCount >= myPublicLimit) {
      Alert.alert(
        'No free public slots',
        myPublicLimit === 0
          ? 'Public playlists need a badge. Earn Bronze for 1 slot, Silver for 2, Gold for 3, Diamond for 6.'
          : `Your ${tierLabel(rawTier(profile))} badge allows ${myPublicLimit} public ${myPublicLimit === 1 ? 'playlist' : 'playlists'}. Make one private first to free a slot.`,
      );
      return;
    }
    const { error } = await supabase.from('playlists').update({ is_public: makePublic }).eq('id', pl.id);
    if (error) { Alert.alert('Error', error.message); return; }
    if (currentUserId) fetchPlaylists(currentUserId);
  }

  // Persist a new track order: positions are rewritten 1..n. Covers refresh
  // because the first track is the playlist's face.
  async function persistTrackOrder(next: any[]) {
    setTracks(next);
    if (!selectedPlaylist) return;
    await Promise.all(next.map((t: any, i: number) =>
      supabase.from('playlist_tracks')
        .update({ position: i + 1 })
        .eq('playlist_id', selectedPlaylist.id)
        .eq('post_id', t.post_id)));
    if (currentUserId) fetchPlaylists(currentUserId);
  }

  // Bulk-remove from the playlist editor: delete the selected rows, then
  // renumber what's left.
  async function removeTracksBulk(postIds: string[], next: any[]) {
    if (!selectedPlaylist) return;
    const { error } = await supabase
      .from('playlist_tracks').delete()
      .eq('playlist_id', selectedPlaylist.id)
      .in('post_id', postIds);
    if (error) { Alert.alert('Error', error.message); return; }
    await persistTrackOrder(next);
  }

  // Long-press a song inside one of your playlists → "Remove from playlist"
  // (the options sheet swaps it in for "Add to playlist").
  async function removeTrackFromPlaylist(playlistId: string, postId: string) {
    const { error } = await supabase
      .from('playlist_tracks').delete()
      .eq('playlist_id', playlistId).eq('post_id', postId);
    if (error) { Alert.alert('Error', error.message); return; }
    setTracks(prev => prev.filter((t: any) => t.post_id !== postId));
    // The playlist's face is its first track — refresh covers in case it changed.
    if (currentUserId) fetchPlaylists(currentUserId);
  }

  // Long-press menu for one of the user's own playlists.
  function playlistOptions(pl: Playlist) {
    Alert.alert(pl.name, pl.is_public ? 'Public playlist' : 'Private playlist', [
      { text: pl.is_public ? 'Make Private' : 'Make Public', onPress: () => setPlaylistVisibility(pl, !pl.is_public) },
      { text: 'Delete Playlist', style: 'destructive', onPress: () => deletePlaylist(pl.id) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  async function deletePlaylist(playlistId: string) {
    Alert.alert('Delete Playlist', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        await supabase.from('playlists').delete().eq('id', playlistId);
        setPlaylists(prev => prev.filter(p => p.id !== playlistId));
        if (selectedPlaylist?.id === playlistId) setSelectedPlaylist(null);
      }},
    ]);
  }

  // ─── Discover helpers ─────────────────────────────────────────────────────

  async function fetchDiscoverData(userId: string) {
    setDiscoverLoading(true);
    const [profile, followingResult, seen] = await Promise.all([
      buildAffinityProfile(userId),
      supabase.from('follows').select('following_id').eq('follower_id', userId),
      loadSeenPostIds(),
    ]);
    affinityProfile.current = profile;
    followingSetRef.current = new Set(
      (followingResult.data ?? []).map((f: any) => f.following_id),
    );
    seenRef.current = seen;

    // Establish / advance the 4-day discover refresh timestamp. First-ever load
    // (or a load ≥4 days after the last) counts as a fresh cycle and resets the
    // clock; within the window we keep the stored time so the manual-pull gate
    // measures against the real last-refresh.
    try {
      const tsRaw    = await AsyncStorage.getItem(`${DISCOVER_TS_KEY}_${userId}`);
      const storedTs = tsRaw ? parseInt(tsRaw, 10) : 0;
      const now      = Date.now();
      if (!storedTs || now - storedTs >= DISCOVER_TTL_MS) {
        discoverRefreshedAt.current = now;
        await AsyncStorage.setItem(`${DISCOVER_TS_KEY}_${userId}`, String(now));
      } else {
        discoverRefreshedAt.current = storedTs;
      }
    } catch {
      discoverRefreshedAt.current = Date.now();
    }

    setOrderedGenreList(sortRailByAffinity([...GENRES, ...CONTENT_TAGS], profile));

    // The genre tab always lands on "All genres" on a fresh start; the pill
    // ordering above still reflects the user's affinity, but the active
    // selection is not auto-jumped to their top genre.
    setDiscoverGenre('All');

    await Promise.all([
      fetchTrendingByGenre('All'),
      fetchForYouTracks(),
      fetchTodaysPick(userId),
      fetchCommunityPlaylists(), // feeds the Upcoming/Popular Playlists rails
      fetchTop20(),
    ]);
    setDiscoverLoading(false);
  }

  // Manual pull-to-refresh for Discover. Performs an actual refetch ONLY once the
  // 4-day window has elapsed since the last refresh; within the window it is a
  // deliberate no-op so the curated content stays put (per product spec).
  async function onDiscoverRefresh() {
    setDiscoverRefreshing(true);
    const now = Date.now();
    if (currentUserId && now - discoverRefreshedAt.current >= DISCOVER_TTL_MS) {
      discoverRefreshedAt.current = now;
      try { await AsyncStorage.setItem(`${DISCOVER_TS_KEY}_${currentUserId}`, String(now)); } catch {}
      // Rebuild the affinity profile (force-bypass cache) so newly developed
      // tastes are reflected, then refetch every Discover section.
      const profile = await buildAffinityProfile(currentUserId, true);
      affinityProfile.current = profile;
      setOrderedGenreList(sortRailByAffinity([...GENRES, ...CONTENT_TAGS], profile));
      await Promise.all([
        fetchTrendingByGenre(discoverGenre),
        fetchForYouTracks(),
        fetchTodaysPick(currentUserId),
        fetchCommunityPlaylists(),
        fetchTop20(),
      ]);
    }
    setDiscoverRefreshing(false);
  }

  // Fetches 30 popular tracks for the selected pill — which may be a music genre,
  // "All", or a content-type tag (Podcasts / Audiobooks) — then re-ranks
  // client-side using scorePost so personalisation layers on top of popularity.
  async function fetchTrendingByGenre(genre: string) {
    const ct: ContentType =
      genre === 'Podcasts' ? 'podcast' : genre === 'Audiobooks' ? 'audiobook' : 'music';
    let q = supabase
      .from('posts')
      .select('*, profiles!posts_user_id_fkey (id, username, display_name, avatar_url), likes(count), comments(count)')
      .eq('is_public', true)
      .order('stream_count', { ascending: false })
      .limit(30);

    if (ct === 'podcast') {
      q = q.eq('type', 'podcast');
    } else if (ct === 'audiobook') {
      q = q.eq('type', 'audiobook');
    } else {
      q = q.eq('type', 'audio');
      if (genre !== 'All') q = q.eq('genre', genre.toLowerCase());
    }

    const { data } = await q;
    if (data) {
      const now = Date.now();
      const scored = [...data]
        .filter((p: any) => !blockedIdsRef.current.has(p.user_id))
        .map(p => ({ p, score: scorePost(p, affinityProfile.current, followingSetRef.current, seenRef.current, now) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
        .map(x => x.p);
      setTrendingTracks(scored);
    }
  }

  // The Top 20 chart: most-streamed songs on Laybell, app-wide. Unlike
  // Trending this is NOT affinity-scored — it's the same chart for everyone.
  async function fetchTop20() {
    const { data } = await supabase
      .from('posts')
      .select('*, profiles!posts_user_id_fkey (id, username, display_name, avatar_url)')
      .eq('is_public', true)
      .eq('type', 'audio')
      .order('stream_count', { ascending: false })
      .limit(20);
    if (data) setTop20Tracks(data.filter((p: any) => !blockedIdsRef.current.has(p.user_id)));
  }

  // ── Listen-mode curated mix ──────────────────────────────────────────────
  // Entering Listen mode with nothing playing starts a Laybell-curated queue,
  // unique to this user: a wide popularity pool re-ranked by their affinity
  // profile (creators/genres they like + save), strictly music — no memes, life
  // audio, podcasts or audiobooks — with full-song lengths (1:30–3:00) boosted.
  // If a track is already selected, the user's choice is respected and nothing
  // is interrupted. Auto-advance through the queue is AudioContext's default.
  const prevListenRef = useRef(false);
  useEffect(() => {
    if (listenMode && !prevListenRef.current && !currentTrack) startListenMix();
    prevListenRef.current = listenMode;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listenMode]);

  async function startListenMix() {
    try {
      const { data } = await supabase
        .from('posts')
        .select('*, profiles!posts_user_id_fkey (id, username, display_name, avatar_url), likes(count), comments(count)')
        .eq('is_public', true)
        .eq('type', 'audio')
        .order('stream_count', { ascending: false })
        .limit(120);
      if (!data) return;
      const now = Date.now();
      const mix = [...data]
        .filter((p: any) => !blockedIdsRef.current.has(p.user_id))
        .filter((p: any) => !NON_MUSIC_GENRES.has((p.genre ?? '').toLowerCase()))
        .map((p: any) => {
          let score = scorePost(p, affinityProfile.current, followingSetRef.current, seenRef.current, now);
          const dur = p.duration_seconds ?? 0;
          if (dur >= LISTEN_SWEET_MIN_S && dur <= LISTEN_SWEET_MAX_S) score *= LISTEN_SWEET_BOOST;
          return { p, score };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 40)
        .map(x => x.p);
      if (!mix.length) return;
      playQueue(
        mix.map((t: any) => ({
          id: t.id, uri: t.media_url, caption: t.caption,
          artist: t.profiles?.display_name ?? '', cover: t.cover_url,
        })),
        0,
      );
    } catch {}
  }

  async function fetchForYouTracks() {
    const { data } = await supabase
      .from('posts')
      .select('*, profiles!posts_user_id_fkey (id, username, display_name, avatar_url), likes(count), comments(count)')
      .eq('is_public', true)
      .eq('type', 'audio')
      .order('created_at', { ascending: false })
      .limit(80);
    if (data) {
      const now = Date.now();
      const sorted = [...data]
        .filter((p: any) => !blockedIdsRef.current.has(p.user_id))
        .map(p => ({ p, score: scorePost(p, affinityProfile.current, followingSetRef.current, seenRef.current, now) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map(x => x.p);
      setForYouTracks(sorted);
    }
  }

  // Today's Pick rotates every 18 hours. The pick is cached in AsyncStorage
  // so the same track stays "pick of the day" across sessions within that
  // window. When refreshing, unheard/uninteracted tracks are preferred so
  // the feature actually surfaces new music.
  async function fetchTodaysPick(userId: string) {
    const cacheKey = `${TODAYS_PICK_KEY}_${userId}`;

    // Return the cached pick if it is still within the 18-hour window.
    try {
      const raw = await AsyncStorage.getItem(cacheKey);
      if (raw) {
        const { postData, pickedAt } = JSON.parse(raw);
        if (Date.now() - pickedAt < TODAYS_PICK_TTL_MS) {
          setTodaysPick(postData);
          return;
        }
      }
    } catch {}

    // Get the user's liked + saved + seen IDs to prefer unheard tracks.
    const [{ data: likedIds }, { data: savedIds }] = await Promise.all([
      supabase.from('likes').select('post_id').eq('user_id', userId).limit(200),
      supabase.from('saves').select('post_id').eq('user_id', userId).limit(200),
    ]);
    const interacted = new Set<string>([
      ...(likedIds  ?? []).map((r: any) => r.post_id as string),
      ...(savedIds  ?? []).map((r: any) => r.post_id as string),
      ...seenRef.current,
    ]);

    // Candidate pool: last 7 days, fallback to all-time top.
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: pool } = await supabase
      .from('posts')
      .select('*, profiles!posts_user_id_fkey (id, username, display_name, avatar_url), likes(count), comments(count)')
      .eq('is_public', true).eq('type', 'audio')
      .gte('created_at', weekAgo)
      .order('stream_count', { ascending: false })
      .limit(30);

    const candidates = (pool && pool.length > 0) ? pool : await (async () => {
      const { data: fb } = await supabase
        .from('posts')
        .select('*, profiles!posts_user_id_fkey (id, username, display_name, avatar_url), likes(count), comments(count)')
        .eq('is_public', true).eq('type', 'audio')
        .order('stream_count', { ascending: false })
        .limit(30);
      return fb ?? [];
    })();

    if (!candidates.length) return;

    // Don't pick a blocked artist's track.
    const visibleCandidates = candidates.filter((p: any) => !blockedIdsRef.current.has(p.user_id));
    if (!visibleCandidates.length) return;

    const now = Date.now();
    const scored = [...visibleCandidates]
      .map(p => ({ p, score: scorePost(p, affinityProfile.current, followingSetRef.current, seenRef.current, now) }))
      .sort((a, b) => b.score - a.score);

    // Prefer a track the user hasn't heard or interacted with.
    const unheard = scored.filter(({ p }) => !interacted.has(p.id));
    const best    = (unheard.length > 0 ? unheard : scored)[0].p;

    setTodaysPick(best);
    try {
      await AsyncStorage.setItem(cacheKey, JSON.stringify({ postData: best, pickedAt: Date.now() }));
    } catch {}
  }

  async function onGenreChange(genre: string) {
    if (genre === discoverGenre) {
      setTrendingExpanded(prev => !prev);
      return;
    }
    setTrendingExpanded(false);
    setDiscoverGenre(genre);
    setTrendingLoading(true);
    await fetchTrendingByGenre(genre);
    setTrendingLoading(false);
  }

  // ──────────────────────────────────────────────────────────────────────────

  const playlistQueue = () => tracks.map(t => ({
    id: t.post_id, uri: t.posts.media_url, caption: t.posts.caption,
    artist: t.posts.profiles?.display_name ?? '', cover: t.posts.cover_url,
  }));
  const likedQueue = () => likedTracks.map((t: any) => ({
    id: t.posts?.id, uri: t.posts?.media_url, caption: t.posts?.caption,
    artist: t.posts?.profiles?.display_name ?? '', cover: t.posts?.cover_url,
  }));
  // Trending plays as a queue (like a playlist) so it autoplays through the
  // section for the selected genre with working prev/next, then stops after the
  // last track. Built from the full trendingTracks list, not the visible slice.
  const trendingQueue = () => trendingTracks.map((t: any) => ({
    id: t.id, uri: t.media_url, caption: t.caption,
    artist: t.profiles?.display_name ?? '', cover: t.cover_url,
  }));
  const top20Queue = () => top20Tracks.map((t: any) => ({
    id: t.id, uri: t.media_url, caption: t.caption,
    artist: t.profiles?.display_name ?? '', cover: t.cover_url,
  }));
  const openNowPlaying = () => expand();

  // Shared empty state for the library views (Playlists / Saved / Liked): a
  // soft tinted halo around an outline icon, short conversational copy, and
  // one clear pill action — themed, so it sits right in light mode too.
  const renderEmpty = (
    icon: keyof typeof Ionicons.glyphMap,
    title: string,
    subtitle: string,
    action?: { label: string; onPress: () => void },
  ) => (
    <View style={styles.emptyContainer}>
      <View style={styles.emptyHalo}>
        <View style={styles.emptyIconCircle}>
          <Ionicons name={icon} size={30} color={colors.primary} />
        </View>
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptySubtitle}>{subtitle}</Text>
      {action && (
        <TouchableOpacity onPress={action.onPress} activeOpacity={0.85}>
          <LinearGradient
            colors={GRADIENTS.primary as any}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.emptyCta}
          >
            <Text style={styles.emptyCtaText}>{action.label}</Text>
          </LinearGradient>
        </TouchableOpacity>
      )}
    </View>
  );

  // Cover-square card for a public playlist — used by the Discover rails and
  // the User Playlists tab. Tapping jumps to the playlist's detail in the
  // User Playlists view (no-op view switch when already there).
  const renderPlaylistCard = (p: any) => (
    <TouchableOpacity
      key={p.id}
      style={styles.pubCard}
      activeOpacity={0.8}
      onPress={() => { setActiveView('community'); setSelectedCommunity(p); fetchPlaylistTracks(p.id); }}
    >
      <View style={styles.pubCoverWrap}>
        {p.cover ? (
          <Image source={{ uri: p.cover }} style={styles.pubCover} />
        ) : (
          <LinearGradient colors={GRADIENTS.primarySoft as any} style={styles.pubCover}>
            <Ionicons name="musical-notes" size={26} color={colors.primary} />
          </LinearGradient>
        )}
      </View>
      <Text style={styles.pubName} numberOfLines={1}>{p.name}</Text>
      <Text style={styles.pubMeta} numberOfLines={1}>
        @{p.creator?.username ?? 'unknown'} · {formatCount(p.play_count ?? 0)} {p.play_count === 1 ? 'listen' : 'listens'}
      </Text>
    </TouchableOpacity>
  );

  if (loading) {
    return <View style={styles.loadingContainer}><ActivityIndicator color={colors.primary} size="large" /></View>;
  }

  // Podcasts / Audiobooks pills show their own trending list and hide the
  // music-only "More of what you like" / "Today's Pick" sections.
  const isContentTag = (CONTENT_TAGS as readonly string[]).includes(discoverGenre);
  const isSearching = searchQuery.trim().length > 0;
  // Only the very top search result is highlighted (consistent with explore).
  const searchTopId = searchResults.length ? searchResults[0].id : null;

  // Relevant artists for the "More of what you like" rail — distinct creators
  // pulled from the user's affinity-scored pools (for-you first, then trending),
  // skipping the current user and de-duping by profile id.
  const relevantArtists = (() => {
    const seen = new Set<string>();
    const out: { id: string; display_name?: string; username?: string; avatar_url: string | null }[] = [];
    for (const t of [...forYouTracks, ...trendingTracks]) {
      const p = t.profiles;
      const id = p?.id ?? t.user_id;
      if (!id || id === currentUserId || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, display_name: p?.display_name, username: p?.username, avatar_url: p?.avatar_url ?? null });
      if (out.length >= 12) break;
    }
    return out;
  })();

  return (
    // Dwell-swipe detector lives on the root: after 4s on this page,
    // horizontal flings step through the view pills (see viewSwipePan).
    <View style={styles.container} {...viewSwipePan.panHandlers}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Music</Text>
        <View style={styles.headerActions}>
          {activeView === 'playlists' && (
            <TouchableOpacity style={styles.newBtn} onPress={() => setShowNewPlaylist(true)}>
              <Ionicons name="add" size={18} color={colors.text} />
              <Text style={styles.newBtnText}>Playlist</Text>
            </TouchableOpacity>
          )}
          {/* Listen mode — logo-gradient pill. Fades the tab bar away, locks tab
              swiping and silences notifications for distraction-free listening;
              tap again to bring everything back. */}
          <TouchableOpacity onPress={() => setListenMode(!listenMode)} activeOpacity={0.85}>
            <LinearGradient
              colors={['#FAB525', '#F5921F']}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
              style={[styles.listenBtn, listenMode && styles.listenBtnActive]}
            >
              <Ionicons name={listenMode ? 'close' : 'headset'} size={16} color="#fff" />
              <Text style={styles.listenBtnText}>{listenMode ? 'Exit' : 'Listen'}</Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </View>

      {/* Search bar — find songs by name, username, or display name */}
      <View style={styles.searchRow}>
        <View style={styles.searchBar}>
          <Ionicons name="search-outline" size={18} color={colors.textTertiary} style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search songs, artists..."
            placeholderTextColor={colors.textTertiary}
            value={searchQuery}
            onChangeText={setSearchQuery}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
          />
          {(searchQuery.length > 0 || searchFocused) && (
            <TouchableOpacity
              onPress={() => { setSearchQuery(''); Keyboard.dismiss(); }}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              style={styles.searchClear}
            >
              <Ionicons name="close-circle" size={20} color={colors.textTertiary} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {isSearching ? (
        <FlatList
          data={searchResults}
          keyExtractor={item => item.id}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={styles.searchListContent}
          ListHeaderComponent={
            searchProfiles.length > 0 ? (
              <View style={styles.searchProfiles}>
                {searchProfiles.map((p: any) => (
                  <TouchableOpacity
                    key={p.id}
                    style={styles.profileRow}
                    activeOpacity={0.8}
                    onPress={() => router.push(`/profile/${p.id}`)}
                  >
                    <StoryAvatar userId={p.id} avatarUrl={p.avatar_url} name={p.display_name || p.username} size={46} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.profileRowName} numberOfLines={1}>{p.display_name || p.username}</Text>
                      <Text style={styles.profileRowHandle} numberOfLines={1}>@{p.username}</Text>
                    </View>
                    <FollowButton userId={p.id} />
                  </TouchableOpacity>
                ))}
              </View>
            ) : null
          }
          ListEmptyComponent={searching || searchProfiles.length > 0 ? null : <Text style={styles.searchEmpty}>No results found</Text>}
          renderItem={({ item }) => (
            <TrackRow
              caption={item.caption}
              artist={item.profiles?.display_name}
              username={item.profiles?.username}
              streams={item.stream_count}
              cover={item.cover_url}
              avatarUrl={item.profiles?.avatar_url}
              highlightQuery={item.id === searchTopId ? searchQuery : undefined}
              isPlaying={playingId === item.id}
              onPlay={() => play(item.id, item.media_url, item.caption, item.profiles?.display_name, item.cover_url)}
              onCoverPress={() => { play(item.id, item.media_url, item.caption, item.profiles?.display_name, item.cover_url); openNowPlaying(); }}
              onAvatarPress={() => router.push(`/profile/${item.user_id}`)}
              onOptions={() => showOptions({
                postId: item.id,
                isOwn: item.user_id === currentUserId,
                authorId: item.user_id,
                authorName: item.profiles?.username,
                mediaType: item.type ?? 'audio',
                onEdit: () => router.push(`/edit-post/${item.id}`),
                onDeleted: () => setSearchResults(prev => prev.filter(p => p.id !== item.id)),
                onArchived: () => setSearchResults(prev => prev.filter(p => p.id !== item.id)),
                onBlocked: () => setSearchResults(prev => prev.filter(p => p.user_id !== item.user_id)),
              })}
            />
          )}
        />
      ) : (
      <>

      {/* Toggle — horizontally scrollable so all 5 pills keep readable labels */}
      <GuardedRail
        onGuardStart={railGuardStart}
        onGuardEnd={railGuardEnd}
        style={styles.toggleRow}
        contentContainerStyle={styles.toggleRowContent}
      >
        {(['discover', 'playlists', 'liked', 'saved'] as const).map(view => {
          const icons: Record<typeof view, [string, string]> = {
            discover: ['compass', 'compass-outline'],
            playlists: ['list', 'list-outline'],
            saved: ['bookmark', 'bookmark-outline'],
            liked: ['heart', 'heart-outline'],
          };
          const labels: Record<typeof view, string> = {
            discover: 'Discover', playlists: 'Playlists', saved: 'Saved', liked: 'Liked',
          };
          const on = activeView === view;
          return (
            <TouchableOpacity
              key={view}
              style={[styles.toggleBtn, on && styles.toggleBtnActive]}
              activeOpacity={0.8}
              onPress={() => { setActiveView(view); setSelectedPlaylist(null); setSelectedCommunity(null); }}
            >
              {on && (
                <LinearGradient
                  colors={GRADIENTS.primary as any}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={[StyleSheet.absoluteFill, { borderRadius: RADIUS.full }]}
                />
              )}
              <Ionicons name={(on ? icons[view][0] : icons[view][1]) as any} size={15} color={on ? colors.text : colors.textSecondary} />
              <Text style={[styles.toggleText, on && styles.toggleTextActive]} numberOfLines={1}>{labels[view]}</Text>
            </TouchableOpacity>
          );
        })}
      </GuardedRail>

      {/* All pill views share this wrapper so switching slides the incoming
          view in from the travel direction */}
      <Animated.View style={[styles.viewsWrap, { transform: [{ translateX: viewAnimX }] }]}>

      {/* ─── Discover ──────────────────────────────────────────────────────── */}
      {activeView === 'discover' && (
        discoverLoading ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={colors.primary} size="large" />
          </View>
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.discoverContent}
            refreshControl={
              <RefreshControl
                refreshing={discoverRefreshing}
                onRefresh={onDiscoverRefresh}
                tintColor={colors.primary}
              />
            }
          >

            {/* — Genres label (the major genre tabs live directly below) — */}
            <Text style={styles.discoverSectionTitleLg}>Genres</Text>

            {/* — Genre + content-type pills (All · genres · Podcasts · Audiobooks) — */}
            <GuardedRail onGuardStart={railGuardStart} onGuardEnd={railGuardEnd} contentContainerStyle={styles.genrePills}>
              {(['All', ...orderedGenreList]).map(genre => {
                const active = discoverGenre === genre;
                const label  = genre === 'All' ? 'All genres' : genre;
                return (
                  <TouchableOpacity
                    key={genre}
                    style={[styles.genrePill, active && styles.genrePillActive]}
                    onPress={() => onGenreChange(genre)}
                  >
                    {active ? (
                      <LinearGradient colors={GRADIENTS.primary as any} style={styles.genrePillInner}>
                        <Text style={[styles.genrePillText, styles.genrePillTextActive]}>{label}</Text>
                      </LinearGradient>
                    ) : (
                      <View style={styles.genrePillInner}>
                        <Text style={styles.genrePillText}>{label}</Text>
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
            </GuardedRail>

            {/* — Trending: top songs for the selected genre — */}
            <Text style={styles.discoverSectionTitle}>
              {discoverGenre === 'Podcasts'
                ? 'Trending podcasts'
                : discoverGenre === 'Audiobooks'
                ? 'Top audiobooks'
                : 'Trending'}
            </Text>

            {trendingLoading ? (
              <ActivityIndicator color={colors.primary} style={{ marginVertical: SPACING.md }} />
            ) : trendingTracks.length === 0 ? (
              <Text style={[styles.discoverEmpty, { paddingHorizontal: SPACING.md }]}>
                {discoverGenre === 'Podcasts'
                  ? 'No podcasts yet'
                  : discoverGenre === 'Audiobooks'
                  ? 'No audiobooks yet'
                  : 'No tracks in this genre yet'}
              </Text>
            ) : (
              <View style={styles.trendingList}>
                {trendingTracks.slice(0, trendingExpanded ? 8 : 4).map((track, i) => (
                  <TrackRow
                    key={track.id}
                    caption={track.caption}
                    artist={track.profiles?.display_name}
                    username={track.profiles?.username}
                    streams={track.stream_count}
                    cover={track.cover_url}
                    avatarUrl={track.profiles?.avatar_url}
                    isPlaying={playingId === track.id}
                    onPlay={() => playQueue(trendingQueue(), i)}
                    onCoverPress={() => { playQueue(trendingQueue(), i); openNowPlaying(); }}
                    onAvatarPress={() => router.push(`/profile/${track.user_id}`)}
                    onOptions={() => showOptions({
                      postId: track.id,
                      isOwn: track.user_id === currentUserId,
                      authorId: track.user_id,
                      authorName: track.profiles?.username,
                      mediaType: track.type ?? 'audio',
                      onEdit: () => router.push(`/edit-post/${track.id}`),
                      onDeleted: () => {
                        setTrendingTracks(prev => prev.filter(t => t.id !== track.id));
                        setForYouTracks(prev => prev.filter(t => t.id !== track.id));
                      },
                      onArchived: () => {
                        setTrendingTracks(prev => prev.filter(t => t.id !== track.id));
                        setForYouTracks(prev => prev.filter(t => t.id !== track.id));
                      },
                      onBlocked: () => {
                        setTrendingTracks(prev => prev.filter(t => t.user_id !== track.user_id));
                        setForYouTracks(prev => prev.filter(t => t.user_id !== track.user_id));
                      },
                    })}
                  />
                ))}
                {trendingTracks.length > 4 && (
                  <TouchableOpacity
                    style={styles.showMoreBtn}
                    onPress={() => setTrendingExpanded(prev => !prev)}
                  >
                    <Text style={styles.showMoreText}>
                      {trendingExpanded
                        ? 'Show less'
                        : `Show ${trendingTracks.length - 4} more`}
                    </Text>
                    <Ionicons
                      name={trendingExpanded ? 'chevron-up' : 'chevron-down'}
                      size={14}
                      color={colors.primary}
                    />
                  </TouchableOpacity>
                )}
              </View>
            )}

            {/* — Popular Playlists (music only): most-listened public playlists — */}
            {!isContentTag && popularPlaylists.length > 0 && (
              <>
                <Text style={[styles.discoverSectionTitleLg, { marginTop: SPACING.xl }]}>Popular Playlists</Text>
                <GuardedRail onGuardStart={railGuardStart} onGuardEnd={railGuardEnd} contentContainerStyle={styles.playlistRail}>
                  {popularPlaylists.slice(0, 10).map(renderPlaylistCard)}
                </GuardedRail>
              </>
            )}

            {/* — Top 20 (music only): the most-streamed songs on Laybell —
                same layout as Trending — */}
            {!isContentTag && top20Tracks.length > 0 && (
              <>
                <Text style={[styles.discoverSectionTitleLg, { marginTop: SPACING.xl }]}>Top 20</Text>
                <View style={styles.trendingList}>
                  {top20Tracks.slice(0, top20Expanded ? 20 : 4).map((track, i) => (
                    <TrackRow
                      key={track.id}
                      caption={track.caption}
                      artist={track.profiles?.display_name}
                      username={track.profiles?.username}
                      streams={track.stream_count}
                      cover={track.cover_url}
                      avatarUrl={track.profiles?.avatar_url}
                      isPlaying={playingId === track.id}
                      onPlay={() => playQueue(top20Queue(), i)}
                      onCoverPress={() => { playQueue(top20Queue(), i); openNowPlaying(); }}
                      onAvatarPress={() => router.push(`/profile/${track.user_id}`)}
                      onOptions={() => showOptions({
                        postId: track.id,
                        isOwn: track.user_id === currentUserId,
                        authorId: track.user_id,
                        authorName: track.profiles?.username,
                        mediaType: track.type ?? 'audio',
                        onEdit: () => router.push(`/edit-post/${track.id}`),
                        onDeleted: () => setTop20Tracks(prev => prev.filter(t => t.id !== track.id)),
                        onArchived: () => setTop20Tracks(prev => prev.filter(t => t.id !== track.id)),
                        onBlocked: () => setTop20Tracks(prev => prev.filter(t => t.user_id !== track.user_id)),
                      })}
                    />
                  ))}
                  {top20Tracks.length > 4 && (
                    <TouchableOpacity
                      style={styles.showMoreBtn}
                      onPress={() => setTop20Expanded(prev => !prev)}
                    >
                      <Text style={styles.showMoreText}>
                        {top20Expanded ? 'Show less' : `Show ${top20Tracks.length - 4} more`}
                      </Text>
                      <Ionicons
                        name={top20Expanded ? 'chevron-up' : 'chevron-down'}
                        size={14}
                        color={colors.primary}
                      />
                    </TouchableOpacity>
                  )}
                </View>
              </>
            )}

            {/* — Upcoming Playlists (music only): fresh playlists with momentum — */}
            {!isContentTag && upcomingPlaylists.length > 0 && (
              <>
                <Text style={[styles.discoverSectionTitleLg, { marginTop: SPACING.xl }]}>Upcoming Playlists</Text>
                <GuardedRail onGuardStart={railGuardStart} onGuardEnd={railGuardEnd} contentContainerStyle={styles.playlistRail}>
                  {upcomingPlaylists.map(renderPlaylistCard)}
                </GuardedRail>
              </>
            )}

            {/* — More of what you like (music only) — */}
            {!isContentTag && forYouTracks.length > 0 && (
              <>
                <Text style={[styles.discoverSectionTitleLg, { marginTop: SPACING.xl }]}>More of what you like</Text>

                {/* Relevant artists — tap a circle to open that profile */}
                {relevantArtists.length > 0 && (
                  <GuardedRail onGuardStart={railGuardStart} onGuardEnd={railGuardEnd} contentContainerStyle={styles.artistScroll}>
                    {relevantArtists.map(artist => (
                      <TouchableOpacity
                        key={artist.id}
                        style={styles.artistCircleItem}
                        activeOpacity={0.8}
                        onPress={() => router.push(`/profile/${artist.id}`)}
                      >
                        <StoryAvatar
                          userId={artist.id}
                          avatarUrl={artist.avatar_url}
                          name={artist.display_name ?? artist.username}
                          size={64}
                          onPressProfile={() => router.push(`/profile/${artist.id}`)}
                        />
                        <Text style={styles.artistName} numberOfLines={1}>
                          {artist.display_name ?? artist.username}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </GuardedRail>
                )}

                <GuardedRail onGuardStart={railGuardStart} onGuardEnd={railGuardEnd} contentContainerStyle={styles.forYouScroll}>
                  {forYouTracks.map(track => (
                    <TouchableOpacity
                      key={track.id}
                      style={styles.forYouCard}
                      activeOpacity={0.8}
                      onPress={() => { play(track.id, track.media_url, track.caption, track.profiles?.display_name, track.cover_url); openNowPlaying(); }}
                      onLongPress={() => showOptions({
                        postId: track.id,
                        isOwn: track.user_id === currentUserId,
                        authorId: track.user_id,
                        authorName: track.profiles?.username,
                        mediaType: track.type ?? 'audio',
                        onEdit: () => router.push(`/edit-post/${track.id}`),
                        onDeleted: () => setForYouTracks(prev => prev.filter(t => t.id !== track.id)),
                        onArchived: () => setForYouTracks(prev => prev.filter(t => t.id !== track.id)),
                        onBlocked: () => setForYouTracks(prev => prev.filter(t => t.user_id !== track.user_id)),
                      })}
                    >
                      {track.cover_url ? (
                        <Image source={{ uri: track.cover_url }} style={styles.forYouCover} />
                      ) : (
                        <LinearGradient colors={GRADIENTS.primarySoft as any} style={styles.forYouCover}>
                          <Ionicons name="musical-notes" size={28} color={colors.primary} />
                        </LinearGradient>
                      )}
                      <Text style={styles.forYouTitle} numberOfLines={2}>{track.caption}</Text>
                      <Text style={styles.forYouArtist} numberOfLines={1}>
                        {track.profiles?.display_name ?? track.profiles?.username}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </GuardedRail>
              </>
            )}

            {/* — Today's Pick (music only) — */}
            {!isContentTag && todaysPick && (
              <>
                <Text style={[styles.discoverSectionTitleLg, { marginTop: SPACING.xl }]}>Today's Pick</Text>
                <View style={styles.todaysPickSection}>
                  <TouchableOpacity
                    style={styles.todaysPickRow}
                    activeOpacity={0.8}
                    onPress={() => { play(todaysPick.id, todaysPick.media_url, todaysPick.caption, todaysPick.profiles?.display_name, todaysPick.cover_url); openNowPlaying(); }}
                    onLongPress={() => showOptions({
                      postId: todaysPick.id,
                      isOwn: todaysPick.user_id === currentUserId,
                      authorId: todaysPick.user_id,
                      authorName: todaysPick.profiles?.username,
                      mediaType: todaysPick.type ?? 'audio',
                      onEdit: () => router.push(`/edit-post/${todaysPick.id}`),
                      onDeleted: () => setTodaysPick(null),
                      onArchived: () => setTodaysPick(null),
                      onBlocked: () => setTodaysPick(null),
                    })}
                  >
                    {todaysPick.cover_url ? (
                      <Image source={{ uri: todaysPick.cover_url }} style={styles.todaysCover} />
                    ) : (
                      <LinearGradient colors={GRADIENTS.primarySoft as any} style={styles.todaysCover}>
                        <Ionicons name="musical-notes" size={20} color={colors.primary} />
                      </LinearGradient>
                    )}
                    <View style={styles.todaysInfo}>
                      <Text style={styles.todaysTitle} numberOfLines={1}>{todaysPick.caption}</Text>
                      <Text style={styles.todaysArtist} numberOfLines={1}>
                        {todaysPick.profiles?.display_name ?? todaysPick.profiles?.username}
                      </Text>
                    </View>
                    <Ionicons
                      name={playingId === todaysPick.id ? 'pause-circle' : 'play-circle'}
                      size={44}
                      color={colors.primary}
                    />
                  </TouchableOpacity>
                </View>
              </>
            )}

          </ScrollView>
        )
      )}

      {/* Playlists list — public ones as cover squares up top (locked = greyed),
          private ones as the usual rows below. Long-press either for options. */}
      {activeView === 'playlists' && !selectedPlaylist && (
        <FlatList
          data={playlists.filter(p => !p.is_public)}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            playlists.some(p => p.is_public) ? (
              <View>
                <Text style={styles.sectionTitle}>Your public playlists</Text>
                <GuardedRail onGuardStart={railGuardStart} onGuardEnd={railGuardEnd} contentContainerStyle={styles.pubRail}>
                  {playlists.filter(p => p.is_public).map(p => {
                    const locked = !myActivePublicIds.has(p.id);
                    return (
                      <TouchableOpacity
                        key={p.id}
                        style={styles.pubCard}
                        activeOpacity={0.8}
                        onPress={() => { setSelectedPlaylist(p); fetchPlaylistTracks(p.id); }}
                        onLongPress={() => playlistOptions(p)}
                      >
                        <View style={[styles.pubCoverWrap, locked && styles.pubCoverLocked]}>
                          {p.cover ? (
                            <Image source={{ uri: p.cover }} style={styles.pubCover} />
                          ) : (
                            <LinearGradient colors={GRADIENTS.primarySoft as any} style={styles.pubCover}>
                              <Ionicons name="musical-notes" size={26} color={colors.primary} />
                            </LinearGradient>
                          )}
                        </View>
                        {/* Outside the dimmed wrap so the padlock stays crisp */}
                        {locked && (
                          <View style={styles.pubLockOverlay}>
                            <Ionicons name="lock-closed" size={20} color="#fff" />
                          </View>
                        )}
                        <Text style={[styles.pubName, locked && styles.pubNameLocked]} numberOfLines={1}>{p.name}</Text>
                        <Text style={styles.pubMeta} numberOfLines={1}>
                          {locked ? 'Locked — needs a badge slot' : `${formatCount(p.play_count ?? 0)} ${p.play_count === 1 ? 'listen' : 'listens'}`}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </GuardedRail>
                {playlists.some(p => !p.is_public) && <Text style={styles.sectionTitle}>Your private playlists</Text>}
              </View>
            ) : undefined
          }
          ListEmptyComponent={
            playlists.length === 0
              ? renderEmpty(
                  'musical-notes-outline',
                  'No playlists yet',
                  'Group the tracks you love into mixes that are all yours.',
                  { label: 'Create a Playlist', onPress: () => setShowNewPlaylist(true) },
                )
              : null
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.playlistRow}
              onPress={() => { setSelectedPlaylist(item); fetchPlaylistTracks(item.id); }}
              onLongPress={() => playlistOptions(item)}
            >
              {/* Faced with the first track's cover art, same as public squares */}
              {item.cover ? (
                <Image source={{ uri: item.cover }} style={styles.playlistIcon} />
              ) : (
                <LinearGradient colors={GRADIENTS.primarySoft} style={styles.playlistIcon}>
                  <Ionicons name="musical-notes" size={22} color={colors.primary} />
                </LinearGradient>
              )}
              <View style={styles.playlistInfo}>
                <Text style={styles.playlistName}>{item.name}</Text>
                <Text style={styles.playlistMeta}>Private · Long press for options</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
            </TouchableOpacity>
          )}
        />
      )}

      {/* Playlist tracks */}
      {activeView === 'playlists' && selectedPlaylist && (
        <View style={{ flex: 1 }}>
          <View style={styles.detailTopRow}>
            <TouchableOpacity style={styles.backBtn} onPress={() => { setSelectedPlaylist(null); setTracks([]); setEditingPlaylist(false); }}>
              <Ionicons name="chevron-back" size={22} color={colors.primaryLight} />
              <Text style={styles.backText}>Playlists</Text>
            </TouchableOpacity>
            {/* Keep Done visible even if every track was just removed */}
            {(tracks.length > 0 || editingPlaylist) && (
              <TouchableOpacity onPress={() => setEditingPlaylist(e => !e)} hitSlop={8}>
                <Text style={styles.editBtnText}>{editingPlaylist ? 'Done' : 'Edit'}</Text>
              </TouchableOpacity>
            )}
          </View>
          <View style={styles.detailDivider} />
          {/* Header: cover art + prominent title + meta line */}
          <View style={styles.detailHeader}>
            {selectedPlaylist.cover ? (
              <Image source={{ uri: selectedPlaylist.cover }} style={styles.detailCover} />
            ) : (
              <LinearGradient colors={GRADIENTS.primarySoft as any} style={styles.detailCover}>
                <Ionicons name="musical-notes" size={26} color={colors.primary} />
              </LinearGradient>
            )}
            <View style={styles.detailInfo}>
              <Text style={styles.playlistTitle} numberOfLines={2}>{selectedPlaylist.name}</Text>
              <Text style={styles.detailMeta} numberOfLines={1}>
                {selectedPlaylist.is_public ? 'Public' : 'Private'}
                {` · ${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'}`}
                {selectedPlaylist.is_public ? ` · ${formatCount(selectedPlaylist.play_count ?? 0)} ${selectedPlaylist.play_count === 1 ? 'listen' : 'listens'}` : ''}
              </Text>
            </View>
          </View>
          <View style={styles.detailDividerBottom} />
          {tracksLoading ? (
            <ActivityIndicator color={colors.primary} style={{ marginTop: SPACING.xl }} />
          ) : editingPlaylist ? (
            <PlaylistEditor
              tracks={tracks as any}
              onCommitOrder={persistTrackOrder}
              onRemove={removeTracksBulk}
            />
          ) : (
            <FlatList
              data={tracks}
              keyExtractor={item => item.post_id}
              contentContainerStyle={styles.listContent}
              ListEmptyComponent={renderEmpty(
                'add-circle-outline',
                'Nothing in here yet',
                'Add tracks from your Saved or Liked songs, or find something new.',
                { label: 'Find Music', onPress: () => { setSelectedPlaylist(null); setActiveView('discover'); } },
              )}
              renderItem={({ item, index }) => (
                <TrackRow
                  caption={item.posts.caption}
                  artist={item.posts.profiles?.display_name}
                  username={item.posts.profiles?.username}
                  streams={item.posts.stream_count}
                  cover={item.posts.cover_url}
                  avatarUrl={item.posts.profiles?.avatar_url}
                  isPlaying={playingId === item.post_id}
                  onPlay={() => playQueue(playlistQueue(), index)}
                  onCoverPress={() => { playQueue(playlistQueue(), index); openNowPlaying(); }}
                  onAvatarPress={() => router.push(`/profile/${item.posts.user_id}`)}
                  onOptions={() => showOptions({
                    postId: item.post_id,
                    isOwn: item.posts.user_id === currentUserId,
                    authorId: item.posts.user_id,
                    authorName: item.posts.profiles?.username,
                    mediaType: 'audio',
                    onEdit: () => router.push(`/edit-post/${item.post_id}`),
                    onDeleted: () => setTracks(prev => prev.filter(t => t.post_id !== item.post_id)),
                    onArchived: () => setTracks(prev => prev.filter(t => t.post_id !== item.post_id)),
                    onBlocked: () => setTracks(prev => prev.filter(t => t.posts.user_id !== item.posts.user_id)),
                    onRemoveFromPlaylist: () => removeTrackFromPlaylist(selectedPlaylist.id, item.post_id),
                  })}
                />
              )}
            />
          )}
        </View>
      )}

      {/* Saved songs */}
      {activeView === 'saved' && (
        <FlatList
          data={savedTracks}
          keyExtractor={item => item.id}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={<Text style={styles.sectionTitle}>Your saved songs</Text>}
          refreshControl={
            <RefreshControl
              refreshing={savedRefreshing}
              onRefresh={async () => {
                if (!currentUserId) return;
                setSavedRefreshing(true);
                await fetchSavedTracks(currentUserId);
                setSavedRefreshing(false);
              }}
              tintColor={colors.primary}
            />
          }
          ListEmptyComponent={renderEmpty(
            'bookmark-outline',
            'Nothing saved yet',
            'Tracks you save are kept here so you can come back to them anytime.',
            { label: 'Discover Music', onPress: () => setActiveView('discover') },
          )}
          renderItem={({ item }) => (
            <TrackRow
              caption={item.posts?.caption}
              artist={item.posts?.profiles?.display_name}
              username={item.posts?.profiles?.username}
              duration={item.posts?.duration_seconds}
              streams={item.posts?.stream_count}
              cover={item.posts?.cover_url}
              avatarUrl={item.posts?.profiles?.avatar_url}
              isPlaying={playingId === item.posts?.id}
              hidePlayButton
              onPlay={() => play(item.posts?.id, item.posts?.media_url, item.posts?.caption, item.posts?.profiles?.display_name, item.posts?.cover_url)}
              onCoverPress={() => { play(item.posts?.id, item.posts?.media_url, item.posts?.caption, item.posts?.profiles?.display_name, item.posts?.cover_url); openNowPlaying(); }}
              onAddToPlaylist={() => setPlaylistModalPostId(item.posts?.id)}
              onAvatarPress={() => router.push(`/profile/${item.posts?.user_id}`)}
              onOptions={() => showOptions({
                postId: item.posts?.id,
                isOwn: item.posts?.user_id === currentUserId,
                authorId: item.posts?.user_id,
                authorName: item.posts?.profiles?.username,
                mediaType: item.posts?.type ?? 'audio',
                onEdit: () => router.push(`/edit-post/${item.posts?.id}`),
                onDeleted: () => setSavedTracks(prev => prev.filter((s: any) => s.posts?.id !== item.posts?.id)),
                onArchived: () => setSavedTracks(prev => prev.filter((s: any) => s.posts?.id !== item.posts?.id)),
                onBlocked: () => setSavedTracks(prev => prev.filter((s: any) => s.posts?.user_id !== item.posts?.user_id)),
              })}
            />
          )}
        />
      )}

      {/* Liked songs */}
      {activeView === 'liked' && (
        <FlatList
          data={likedTracks}
          keyExtractor={item => item.post_id}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={<Text style={styles.sectionTitle}>Your liked songs</Text>}
          refreshControl={
            <RefreshControl
              refreshing={likedRefreshing}
              onRefresh={async () => {
                if (!currentUserId) return;
                setLikedRefreshing(true);
                await fetchLikedTracks(currentUserId);
                setLikedRefreshing(false);
              }}
              tintColor={colors.primary}
            />
          }
          ListEmptyComponent={renderEmpty(
            'heart-outline',
            'No liked songs yet',
            'Tap the heart on any track and it’ll land here automatically.',
            { label: 'Discover Music', onPress: () => setActiveView('discover') },
          )}
          renderItem={({ item, index }) => (
            <TrackRow
              caption={item.posts?.caption}
              artist={item.posts?.profiles?.display_name}
              username={item.posts?.profiles?.username}
              duration={item.posts?.duration_seconds}
              streams={item.posts?.stream_count}
              cover={item.posts?.cover_url}
              avatarUrl={item.posts?.profiles?.avatar_url}
              isPlaying={playingId === item.posts?.id}
              hidePlayButton
              onPlay={() => playQueue(likedQueue(), index)}
              onCoverPress={() => { playQueue(likedQueue(), index); openNowPlaying(); }}
              onAddToPlaylist={() => setPlaylistModalPostId(item.posts?.id)}
              onAvatarPress={() => router.push(`/profile/${item.posts?.user_id}`)}
              onOptions={() => showOptions({
                postId: item.posts?.id,
                isOwn: item.posts?.user_id === currentUserId,
                authorId: item.posts?.user_id,
                authorName: item.posts?.profiles?.username,
                mediaType: item.posts?.type ?? 'audio',
                onEdit: () => router.push(`/edit-post/${item.posts?.id}`),
                onDeleted: () => setLikedTracks(prev => prev.filter((l: any) => l.posts?.id !== item.posts?.id)),
                onArchived: () => setLikedTracks(prev => prev.filter((l: any) => l.posts?.id !== item.posts?.id)),
                onBlocked: () => setLikedTracks(prev => prev.filter((l: any) => l.posts?.user_id !== item.posts?.user_id)),
              })}
            />
          )}
        />
      )}
      </Animated.View>
      </>
      )}

      {/* Community playlist detail — opened from the Discover playlist rails;
          playable by anyone, listens count for the creator. Backs out to Discover. */}
      {activeView === 'community' && selectedCommunity && (
        <View style={{ flex: 1 }}>
          <TouchableOpacity style={styles.backBtn} onPress={() => { setSelectedCommunity(null); setTracks([]); setActiveView('discover'); }}>
            <Ionicons name="chevron-back" size={22} color={colors.primaryLight} />
            <Text style={styles.backText}>Discover</Text>
          </TouchableOpacity>
          <View style={styles.detailDivider} />
          {/* Header: cover art + prominent title + tappable creator line */}
          <View style={styles.detailHeader}>
            {selectedCommunity.cover ? (
              <Image source={{ uri: selectedCommunity.cover }} style={styles.detailCover} />
            ) : (
              <LinearGradient colors={GRADIENTS.primarySoft as any} style={styles.detailCover}>
                <Ionicons name="musical-notes" size={26} color={colors.primary} />
              </LinearGradient>
            )}
            <View style={styles.detailInfo}>
              <Text style={styles.playlistTitle} numberOfLines={2}>{selectedCommunity.name}</Text>
              <TouchableOpacity onPress={() => router.push(`/profile/${selectedCommunity.user_id}`)} hitSlop={6}>
                <Text style={styles.detailMeta} numberOfLines={1}>
                  by <Text style={styles.detailMetaAccent}>@{selectedCommunity.creator?.username ?? 'unknown'}</Text>
                  {` · ${formatCount(selectedCommunity.play_count ?? 0)} ${selectedCommunity.play_count === 1 ? 'listen' : 'listens'}`}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
          <View style={styles.detailDividerBottom} />
          {tracksLoading ? (
            <ActivityIndicator color={colors.primary} style={{ marginTop: SPACING.xl }} />
          ) : (
            <FlatList
              data={tracks}
              keyExtractor={item => item.post_id}
              contentContainerStyle={styles.listContent}
              ListEmptyComponent={renderEmpty(
                'musical-notes-outline',
                'Nothing in here yet',
                'This playlist has no tracks at the moment.',
              )}
              renderItem={({ item, index }) => (
                <TrackRow
                  caption={item.posts.caption}
                  artist={item.posts.profiles?.display_name}
                  username={item.posts.profiles?.username}
                  streams={item.posts.stream_count}
                  cover={item.posts.cover_url}
                  avatarUrl={item.posts.profiles?.avatar_url}
                  isPlaying={playingId === item.posts.id}
                  onPlay={() => playCommunityTrack(index)}
                  onCoverPress={() => { playCommunityTrack(index); openNowPlaying(); }}
                  onAvatarPress={() => router.push(`/profile/${item.posts.user_id}`)}
                  onOptions={() => showOptions({
                    postId: item.post_id,
                    isOwn: item.posts.user_id === currentUserId,
                    authorId: item.posts.user_id,
                    authorName: item.posts.profiles?.username,
                    mediaType: 'audio',
                    onEdit: () => router.push(`/edit-post/${item.post_id}`),
                    onDeleted: () => setTracks(prev => prev.filter(t => t.post_id !== item.post_id)),
                    onArchived: () => setTracks(prev => prev.filter(t => t.post_id !== item.post_id)),
                    onBlocked: () => setTracks(prev => prev.filter(t => t.posts.user_id !== item.posts.user_id)),
                    // Viewing your OWN public playlist through the rails still
                    // lets you manage it.
                    onRemoveFromPlaylist: selectedCommunity.user_id === currentUserId
                      ? () => removeTrackFromPlaylist(selectedCommunity.id, item.post_id)
                      : undefined,
                  })}
                />
              )}
            />
          )}
        </View>
      )}

      {/* New playlist modal */}
      <Modal visible={showNewPlaylist} transparent animationType="slide" onRequestClose={() => setShowNewPlaylist(false)}>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          {/* Backdrop tap is a two-step exit: with the keyboard up the first
              tap only drops the keyboard; the next closes the sheet. Tapping
              the sheet itself (outside the text field) just drops the
              keyboard. The input and buttons capture their own taps. */}
          <TouchableWithoutFeedback
            onPress={() => {
              if (Keyboard.isVisible()) { Keyboard.dismiss(); return; }
              setShowNewPlaylist(false);
              setNewPlaylistName('');
              setNewPlaylistPublic(false);
            }}
            accessible={false}
          >
          <View style={styles.modalOverlayInner}>
          <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>New Playlist</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="Playlist name..."
              placeholderTextColor={colors.textTertiary}
              value={newPlaylistName}
              onChangeText={setNewPlaylistName}
              autoFocus
            />

            {/* Visibility — private (just for you) or public (discoverable in
                the User Playlists tab; slots gated by earned badge tier). */}
            <View style={styles.visRow}>
              {([
                { pub: false, icon: 'lock-closed', label: 'Private', sub: 'Only you can listen' },
                { pub: true, icon: 'globe-outline', label: 'Public', sub: 'Anyone can discover it' },
              ] as const).map(opt => {
                const on = newPlaylistPublic === opt.pub;
                return (
                  <TouchableOpacity
                    key={opt.label}
                    style={[styles.visBtn, on && styles.visBtnActive]}
                    activeOpacity={0.8}
                    onPress={() => setNewPlaylistPublic(opt.pub)}
                  >
                    <Ionicons name={opt.icon as any} size={16} color={on ? colors.primary : colors.textSecondary} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.visLabel, on && styles.visLabelActive]}>{opt.label}</Text>
                      <Text style={styles.visSub} numberOfLines={1}>{opt.sub}</Text>
                    </View>
                    {on && <Ionicons name="checkmark-circle" size={18} color={colors.primary} />}
                  </TouchableOpacity>
                );
              })}
            </View>
            {newPlaylistPublic && (
              <Text style={[styles.visHint, myPublicCount >= myPublicLimit && { color: colors.error }]}>
                {myPublicLimit === 0
                  ? 'Public playlists need a badge — earn Bronze to unlock your first slot.'
                  : `${myPublicCount} of ${myPublicLimit} public ${myPublicLimit === 1 ? 'slot' : 'slots'} used (${tierLabel(rawTier(profile))} badge)`}
              </Text>
            )}

            <View style={styles.modalBtns}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => { setShowNewPlaylist(false); setNewPlaylistName(''); setNewPlaylistPublic(false); }}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalCreate} onPress={createPlaylist}>
                <Text style={styles.modalCreateText}>Create</Text>
              </TouchableOpacity>
            </View>
          </View>
          </TouchableWithoutFeedback>
          </View>
          </TouchableWithoutFeedback>
        </KeyboardAvoidingView>
      </Modal>

      {/* Add to playlist modal */}
      <AddToPlaylistModal
        visible={!!playlistModalPostId}
        postId={playlistModalPostId ?? ''}
        onClose={() => setPlaylistModalPostId(null)}
      />
    </View>
  );
}


const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  loadingContainer: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },

  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: SPACING.md, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.sm,
  },
  headerTitle: { color: colors.text, fontSize: 32, fontWeight: '900', letterSpacing: 0.3 },

  searchRow: { paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm },
  searchBar: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surfaceLight,
    borderRadius: RADIUS.full,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: SPACING.md, gap: SPACING.sm,
  },
  searchIcon: { marginRight: -4 },
  searchInput: { flex: 1, paddingVertical: SPACING.sm + 2, color: colors.text, fontSize: 15 },
  searchClear: { padding: 2, marginLeft: 2 },
  searchListContent: { padding: SPACING.md, gap: SPACING.sm },
  searchEmpty: { color: colors.textTertiary, fontSize: 14, textAlign: 'center', paddingVertical: SPACING.xl },
  newBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: colors.primary, borderRadius: RADIUS.full,
    paddingVertical: SPACING.xs + 2, paddingHorizontal: SPACING.md,
  },
  newBtnText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  // Listen mode pill — the Laybell logo yellow (#FAB525) easing into a soft
  // orange tail; while active it dims a touch and reads "Exit" so the same
  // button always shows the way back.
  listenBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    borderRadius: RADIUS.full,
    paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md + 4,
    shadowColor: colors.primaryLight, shadowOpacity: 0.5, shadowRadius: 9,
    shadowOffset: { width: 0, height: 0 }, elevation: 6,
  },
  listenBtnActive: { opacity: 0.85 },
  listenBtnText: { color: '#fff', fontSize: 14, fontWeight: '800', letterSpacing: 0.2 },

  // A single rounded "segmented control" track holding the 4 segments; the active
  // one becomes a glowing gradient pill (rendered inside the button).
  // FIXED height + no shrink: as a bare ScrollView in the page column, the
  // rail was getting vertically COMPRESSED by flex negotiation against the
  // Discover scroll view below it — clipping the bottom half of the pill
  // labels. A hard height takes it out of the negotiation entirely.
  toggleRow: {
    height: 48,
    flexGrow: 0,
    flexShrink: 0,
    // Centered between the search bar (8px below it) and the section title
    // (16px above its text): 8 + marginTop(16) = marginBottom(8) + 16 = 24 each side.
    marginTop: SPACING.md,
    marginBottom: SPACING.sm,
  },
  // flexGrow on the content + flex on each pill: when the pills fit (they do,
  // with 4), they stretch to share the full width evenly — no dead space at
  // the right edge; if a pill is ever added back, the row degrades to
  // horizontal scrolling instead of clipping.
  toggleRowContent: {
    flexGrow: 1, flexDirection: 'row', alignItems: 'center',
    gap: SPACING.sm, paddingHorizontal: SPACING.md,
  },
  toggleBtn: {
    flex: 1,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 5,
    paddingVertical: SPACING.xs + 4,
    paddingHorizontal: SPACING.sm,
    borderRadius: RADIUS.full,
    overflow: 'hidden',
    backgroundColor: colors.surfaceLight,
    borderWidth: 1, borderColor: colors.border,
  },
  toggleBtnActive: {
    borderColor: 'transparent',
    shadowColor: colors.primary, shadowOpacity: 0.45, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  toggleText: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  toggleTextActive: { color: colors.text, fontWeight: '800' },

  list: { flex: 1 },
  // flexGrow so short/empty lists still fill the screen — lets pull-to-refresh
  // register when swiping anywhere, not only over a track row.
  listContent: { flexGrow: 1, padding: SPACING.md, gap: SPACING.sm },

  playlistRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.md,
    padding: SPACING.md, borderWidth: 1, borderColor: colors.border, gap: SPACING.md,
  },
  playlistIcon: { width: 48, height: 48, borderRadius: RADIUS.md, alignItems: 'center', justifyContent: 'center' },
  playlistInfo: { flex: 1 },
  playlistName: { color: colors.text, fontSize: 17, fontWeight: '700' },
  playlistMeta: { color: colors.textTertiary, fontSize: 12, marginTop: 2 },

  backBtn: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm },
  detailTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingRight: SPACING.md + SPACING.xs },
  editBtnText: { color: colors.text, fontSize: 17, fontWeight: '700' },
  // Playlist detail header: cover square + big title + quiet meta line, with a
  // clear gap before the track list starts.
  detailHeader: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    paddingHorizontal: SPACING.md, marginTop: SPACING.lg, marginBottom: SPACING.lg,
  },
  detailCover: {
    width: 76, height: 76, borderRadius: RADIUS.md,
    backgroundColor: colors.surfaceLight, alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden',
  },
  detailInfo: { flex: 1 },
  detailMeta: { color: colors.textSecondary, fontSize: 13, marginTop: 5 },
  detailMetaAccent: { color: colors.primary, fontWeight: '700' },
  // Matches the Laybell logo color (primaryLight) for the detail nav actions.
  backText: { color: colors.primaryLight, fontSize: 18, fontWeight: '700' },
  // Hairlines framing the title card — top (under the nav row) and bottom
  // (above the track list).
  detailDivider: { height: 0.5, backgroundColor: colors.border },
  detailDividerBottom: { height: 0.5, backgroundColor: colors.border, marginBottom: SPACING.sm },
  // Wrapper the pill views slide within during the swipe transition.
  viewsWrap: { flex: 1 },
  playlistTitle: { color: colors.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.5, lineHeight: 31 },

  // Library empty states — a soft two-ring halo (primary at low alpha, so it
  // adapts to the theme) instead of a hard gradient tile, copy with room to
  // breathe, and a gradient pill CTA.
  emptyContainer: { alignItems: 'center', paddingTop: SPACING.xxl * 1.6, paddingHorizontal: SPACING.xl, gap: SPACING.sm },
  emptyHalo: {
    width: 108, height: 108, borderRadius: 54,
    backgroundColor: colors.primary + '0A',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: SPACING.xs,
  },
  emptyIconCircle: {
    width: 76, height: 76, borderRadius: 38,
    backgroundColor: colors.primary + '16',
    alignItems: 'center', justifyContent: 'center',
  },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '700', letterSpacing: -0.3 },
  emptySubtitle: { color: colors.textSecondary, fontSize: 14, lineHeight: 20, textAlign: 'center', maxWidth: 270 },
  emptyCta: {
    height: 42, paddingHorizontal: SPACING.xl, borderRadius: RADIUS.full,
    alignItems: 'center', justifyContent: 'center',
    marginTop: SPACING.sm,
    shadowColor: colors.primary, shadowOpacity: 0.35, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  emptyCtaText: { color: '#fff', fontSize: 14.5, fontWeight: '700', letterSpacing: 0.1 },

  // ─── Discover styles ──────────────────────────────────────────────────────
  discoverContent: { paddingBottom: SPACING.xxl * 3 },

  discoverSectionTitle: {
    color: colors.text, fontSize: 20, fontWeight: '800',
    paddingHorizontal: SPACING.md, paddingTop: SPACING.md, paddingBottom: SPACING.sm,
  },
  // Larger primary section header (Genres, More of what you like) — one tier
  // above the secondary "Trending" sub-heading.
  discoverSectionTitleLg: {
    color: colors.text, fontSize: 26, fontWeight: '800',
    paddingHorizontal: SPACING.md, paddingTop: SPACING.md, paddingBottom: SPACING.sm,
  },
  discoverEmpty: { color: colors.textSecondary, fontSize: 14, paddingVertical: SPACING.md },

  genrePills: { paddingHorizontal: SPACING.md, paddingVertical: 4, gap: SPACING.sm, paddingBottom: SPACING.sm },
  genrePill: {
    borderRadius: RADIUS.md, borderWidth: 1, borderColor: colors.border,
    overflow: 'hidden',
  },
  genrePillActive: { borderColor: colors.primary },
  // One shared inner container — same padding for both active and inactive pills
  // so their height is always identical regardless of which has the gradient.
  genrePillInner: {
    paddingVertical: 11, paddingHorizontal: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  genrePillText: { color: colors.textSecondary, fontSize: 15, fontWeight: '600' },
  genrePillTextActive: { color: colors.text, fontWeight: '700' },

  trendingList: { paddingHorizontal: SPACING.xs, gap: SPACING.xs },
  showMoreBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 4, paddingVertical: SPACING.sm, marginTop: SPACING.xs,
  },
  showMoreText: { color: colors.primary, fontSize: 13, fontWeight: '600' },

  forYouScroll: { paddingHorizontal: SPACING.md, gap: SPACING.md, paddingBottom: SPACING.sm },
  forYouCard: { width: FOR_YOU_W, gap: SPACING.xs },
  forYouCover: {
    width: FOR_YOU_W, height: FOR_YOU_W, borderRadius: RADIUS.md,
    backgroundColor: colors.surfaceLight, alignItems: 'center', justifyContent: 'center',
  },
  forYouTitle: { color: colors.text, fontSize: 13, fontWeight: '700' },
  forYouArtist: { color: colors.textSecondary, fontSize: 12 },

  artistScroll: { paddingHorizontal: SPACING.md, gap: SPACING.md, paddingBottom: SPACING.md },
  artistCircleItem: { width: 68, alignItems: 'center', gap: 6 },
  artistAvatar: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: colors.surfaceLight, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.border,
  },
  artistAvatarText: { color: colors.text, fontSize: 24, fontWeight: '800' },
  artistName: { color: colors.textSecondary, fontSize: 12, textAlign: 'center', width: 68 },
  searchProfiles: { paddingBottom: SPACING.sm, marginBottom: SPACING.xs, borderBottomWidth: 0.5, borderBottomColor: colors.border },
  profileRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, paddingVertical: SPACING.xs },
  profileRowName: { color: colors.text, fontSize: 15, fontWeight: '700' },
  profileRowHandle: { color: colors.textTertiary, fontSize: 13, marginTop: 1 },

  todaysPickSection: {
    marginHorizontal: SPACING.md,
    borderRadius: RADIUS.lg, backgroundColor: colors.surfaceLight,
    borderWidth: 1, borderColor: colors.border, overflow: 'hidden',
  },
  todaysPickRow: {
    flexDirection: 'row', alignItems: 'center',
    padding: SPACING.md, gap: SPACING.md,
  },
  todaysCover: {
    width: 52, height: 52, borderRadius: RADIUS.md,
    backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center',
  },
  todaysInfo: { flex: 1 },
  todaysTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  todaysArtist: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  // ──────────────────────────────────────────────────────────────────────────

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)' },
  // Fills the overlay so the tap-to-dismiss-keyboard target covers the whole
  // screen, while keeping the sheet pinned to the bottom.
  modalOverlayInner: { flex: 1, justifyContent: 'flex-end' },
  modalContent: { backgroundColor: colors.surfaceLight, borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl, padding: SPACING.lg, gap: SPACING.md },
  modalTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  modalInput: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, borderRadius: RADIUS.md, padding: SPACING.md, color: colors.text, fontSize: 15 },

  // New-playlist visibility selector + badge-slot hint.
  visRow: { flexDirection: 'row', gap: SPACING.sm },
  visBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.md, padding: SPACING.sm + 2,
  },
  visBtnActive: { borderColor: colors.primary, backgroundColor: colors.primary + '0E' },
  visLabel: { color: colors.textSecondary, fontSize: 13.5, fontWeight: '700' },
  visLabelActive: { color: colors.text },
  visSub: { color: colors.textTertiary, fontSize: 11, marginTop: 1 },
  visHint: { color: colors.textSecondary, fontSize: 12, marginTop: -SPACING.xs },


  // Own Playlists view: public playlists as album-cover squares (locked =
  // greyed + padlock), private ones as the usual rows below.
  // Bold white section headings for the library views (Liked / Saved /
  // Playlists sections).
  sectionTitle: {
    color: colors.text, fontSize: 18, fontWeight: '800', letterSpacing: -0.3,
    paddingTop: SPACING.sm, paddingBottom: SPACING.sm,
  },
  pubRail: { gap: SPACING.md, paddingBottom: SPACING.sm },
  // Same cards on the Discover page — full-bleed rail with edge padding.
  playlistRail: { gap: SPACING.md, paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm },
  pubCard: { width: 120 },
  pubCoverWrap: { width: 120, height: 120, borderRadius: RADIUS.md, overflow: 'hidden' },
  pubCoverLocked: { opacity: 0.45 },
  pubCover: { width: 120, height: 120, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceLight },
  pubLockOverlay: {
    position: 'absolute', top: 0, left: 0, width: 120, height: 120, borderRadius: RADIUS.md,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.35)',
  },
  pubName: { color: colors.text, fontSize: 13.5, fontWeight: '700', marginTop: 6 },
  pubNameLocked: { color: colors.textSecondary },
  pubMeta: { color: colors.textTertiary, fontSize: 11.5, marginTop: 1 },
  modalBtns: { flexDirection: 'row', gap: SPACING.sm },
  modalCancel: { flex: 1, backgroundColor: colors.background, borderRadius: RADIUS.md, padding: SPACING.md, alignItems: 'center', borderWidth: 1, borderColor: colors.border },
  modalCancelText: { color: colors.textSecondary, fontSize: 15, fontWeight: '600' },
  modalCreate: { flex: 1, backgroundColor: colors.primary, borderRadius: RADIUS.md, padding: SPACING.md, alignItems: 'center' },
  modalCreateText: { color: colors.text, fontSize: 15, fontWeight: '700' },
});
