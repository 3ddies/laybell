import {
  View, Text, StyleSheet, FlatList, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert, TextInput, Modal, Image, Dimensions, RefreshControl, Keyboard,
} from 'react-native';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { useAudioPlayer } from '../../hooks/useAudioPlayer';
import { useAudio } from '../../contexts/AudioContext';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../../constants/theme';
import AddToPlaylistModal from '../../components/AddToPlaylistModal';
import TrackRow from '../../components/TrackRow';
import { usePostOptions } from '../../contexts/PostOptionsContext';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { GENRES, CONTENT_TAGS, isAudioPost } from '../../lib/genres';
import { postMatchTier } from '../../lib/searchRank';
import {
  buildAffinityProfile, loadSeenPostIds, scorePost,
  sortGenresByAffinity, EMPTY_PROFILE, type UserAffinityProfile,
} from '../../lib/feedScorer';

const SCREEN_W           = Dimensions.get('window').width;
const FOR_YOU_W          = Math.floor((SCREEN_W - SPACING.md * 2 - SPACING.md) / 2.3);
const TODAYS_PICK_KEY    = 'todays_pick_v2';
const TODAYS_PICK_TTL_MS = 18 * 60 * 60 * 1000; // 18 hours
// Discover content refreshes on a 4-day cadence. A manual pull-to-refresh only
// triggers an actual refetch once this window has elapsed; within it, pulling
// is a no-op (the curated content intentionally stays put).
const DISCOVER_TS_KEY    = 'discover_refreshed_at';
const DISCOVER_TTL_MS    = 4 * 24 * 60 * 60 * 1000; // 4 days

type ContentType = 'music' | 'podcast' | 'audiobook';

type Playlist = { id: string; name: string; is_public: boolean; created_at: string };
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
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [tracksLoading, setTracksLoading] = useState(false);
  const [showNewPlaylist, setShowNewPlaylist] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const { playingId, play } = useAudioPlayer();
  const { playQueue, expand } = useAudio();
  const [savedTracks, setSavedTracks] = useState<any[]>([]);
  const [playlistModalPostId, setPlaylistModalPostId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<'discover' | 'playlists' | 'saved' | 'liked'>('discover');
  const [likedTracks, setLikedTracks] = useState<any[]>([]);
  const [savedRefreshing, setSavedRefreshing] = useState(false);
  const [likedRefreshing, setLikedRefreshing] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const router = useRouter();

  // ─── Search state ──────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);

  // ─── Discover tab state ────────────────────────────────────────────────────
  const [discoverGenre, setDiscoverGenre]       = useState('All');
  const [orderedGenreList, setOrderedGenreList] = useState<string[]>([...GENRES]);
  const [trendingTracks, setTrendingTracks]     = useState<any[]>([]);
  const [trendingLoading, setTrendingLoading]   = useState(false);
  const [trendingExpanded, setTrendingExpanded] = useState(false);
  const [forYouTracks, setForYouTracks]         = useState<any[]>([]);
  const [todaysPick, setTodaysPick]             = useState<any | null>(null);
  const [discoverLoading, setDiscoverLoading]   = useState(true);
  const [discoverRefreshing, setDiscoverRefreshing] = useState(false);
  const affinityProfile = useRef<UserAffinityProfile>(EMPTY_PROFILE);
  const followingSetRef = useRef<Set<string>>(new Set());
  const seenRef         = useRef<Set<string>>(new Set());
  const discoverRefreshedAt = useRef(0); // epoch ms of the last 4-day refresh cycle

  useEffect(() => { setup(); }, []);

  // Debounced song search — matches song names (captions), usernames and display
  // names, ranked by relevancy like the explore page.
  useEffect(() => {
    if (searchQuery.trim().length === 0) { setSearchResults([]); setSearching(false); return; }
    setSearching(true); // show immediately so "No songs found" doesn't flash during the debounce
    const t = setTimeout(() => runSearch(), 400);
    return () => clearTimeout(t);
  }, [searchQuery]);

  async function runSearch() {
    const term = searchQuery.trim();
    if (!term) return;
    setSearching(true);
    const ql = term.toLowerCase();

    // Profiles whose name/handle matches — used to also pull in their songs.
    const { data: matchedProfiles } = await supabase
      .from('profiles').select('id').or(`username.ilike.%${term}%,display_name.ilike.%${term}%`).limit(15);
    const authorIds = (matchedProfiles ?? []).map((p: any) => p.id);

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
      const ranked = [...data].sort((a: any, b: any) => {
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
      }
    }, [currentUserId])
  );

  async function setup() {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      setCurrentUserId(user.id);
      await Promise.all([fetchPlaylists(user.id), fetchSavedTracks(user.id), fetchLikedTracks(user.id)]);
      fetchDiscoverData(user.id); // runs in background with its own loading state
    }
    setLoading(false);
  }

  async function fetchPlaylists(userId: string) {
    const { data } = await supabase.from('playlists').select('*').eq('user_id', userId).order('created_at', { ascending: false });
    if (data) setPlaylists(data);
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

  async function createPlaylist() {
    if (!newPlaylistName.trim() || !currentUserId) return;
    const { data, error } = await supabase.from('playlists')
      .insert({ user_id: currentUserId, name: newPlaylistName.trim(), is_public: false })
      .select().single();
    if (error) { Alert.alert('Error', error.message); return; }
    if (data) { setPlaylists(prev => [data, ...prev]); setNewPlaylistName(''); setShowNewPlaylist(false); }
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

  function topGenreDisplay(profile: UserAffinityProfile): string {
    const entries = Object.entries(profile.genreScores);
    if (!entries.length) return 'All';
    const topLower = entries.reduce((a, b) => a[1] > b[1] ? a : b)[0];
    return GENRES.find(g => g.toLowerCase() === topLower) ?? 'All';
  }

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

    setOrderedGenreList(sortGenresByAffinity([...GENRES], profile));

    const initialGenre = topGenreDisplay(profile);
    setDiscoverGenre(initialGenre);

    await Promise.all([
      fetchTrendingByGenre(initialGenre),
      fetchForYouTracks(),
      fetchTodaysPick(userId),
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
      setOrderedGenreList(sortGenresByAffinity([...GENRES], profile));
      await Promise.all([
        fetchTrendingByGenre(discoverGenre),
        fetchForYouTracks(),
        fetchTodaysPick(currentUserId),
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
        .map(p => ({ p, score: scorePost(p, affinityProfile.current, followingSetRef.current, seenRef.current, now) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
        .map(x => x.p);
      setTrendingTracks(scored);
    }
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

    const now = Date.now();
    const scored = [...candidates]
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
  const openNowPlaying = () => expand();

  if (loading) {
    return <View style={styles.loadingContainer}><ActivityIndicator color={COLORS.primary} size="large" /></View>;
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
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Music</Text>
        {activeView === 'playlists' && (
          <TouchableOpacity style={styles.newBtn} onPress={() => setShowNewPlaylist(true)}>
            <Ionicons name="add" size={18} color={COLORS.text} />
            <Text style={styles.newBtnText}>Playlist</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Search bar — find songs by name, username, or display name */}
      <View style={styles.searchRow}>
        <View style={styles.searchBar}>
          <Ionicons name="search-outline" size={18} color={COLORS.textTertiary} style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search songs, artists..."
            placeholderTextColor={COLORS.textTertiary}
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
              <Ionicons name="close-circle" size={20} color={COLORS.textTertiary} />
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
          ListEmptyComponent={searching ? null : <Text style={styles.searchEmpty}>No songs found</Text>}
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
                onEdit: () => router.push(`/edit-post/${item.id}`),
                onDeleted: () => setSearchResults(prev => prev.filter(p => p.id !== item.id)),
              })}
            />
          )}
        />
      ) : (
      <>

      {/* Toggle — plain View so all 4 pills share equal flex width and nothing overflows */}
      <View style={styles.toggleRow}>
        {(['discover', 'playlists', 'saved', 'liked'] as const).map(view => {
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
              onPress={() => { setActiveView(view); setSelectedPlaylist(null); }}
            >
              <Ionicons name={(on ? icons[view][0] : icons[view][1]) as any} size={15} color={on ? COLORS.text : COLORS.textSecondary} />
              <Text style={[styles.toggleText, on && styles.toggleTextActive]} numberOfLines={1}>{labels[view]}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* ─── Discover ──────────────────────────────────────────────────────── */}
      {activeView === 'discover' && (
        discoverLoading ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={COLORS.primary} size="large" />
          </View>
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.discoverContent}
            refreshControl={
              <RefreshControl
                refreshing={discoverRefreshing}
                onRefresh={onDiscoverRefresh}
                tintColor={COLORS.primary}
              />
            }
          >

            {/* — Genres label (the major genre tabs live directly below) — */}
            <Text style={styles.discoverSectionTitleLg}>Genres</Text>

            {/* — Genre + content-type pills (All · genres · Podcasts · Audiobooks) — */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.genrePills}>
              {(['All', ...orderedGenreList, ...CONTENT_TAGS]).map(genre => {
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
            </ScrollView>

            {/* — Trending: top songs for the selected genre — */}
            <Text style={styles.discoverSectionTitle}>
              {discoverGenre === 'Podcasts'
                ? 'Trending podcasts'
                : discoverGenre === 'Audiobooks'
                ? 'Top audiobooks'
                : 'Trending'}
            </Text>

            {trendingLoading ? (
              <ActivityIndicator color={COLORS.primary} style={{ marginVertical: SPACING.md }} />
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
                {trendingTracks.slice(0, trendingExpanded ? 8 : 4).map(track => (
                  <TrackRow
                    key={track.id}
                    caption={track.caption}
                    artist={track.profiles?.display_name}
                    username={track.profiles?.username}
                    streams={track.stream_count}
                    cover={track.cover_url}
                    avatarUrl={track.profiles?.avatar_url}
                    isPlaying={playingId === track.id}
                    onPlay={() => play(track.id, track.media_url, track.caption, track.profiles?.display_name, track.cover_url)}
                    onCoverPress={() => { play(track.id, track.media_url, track.caption, track.profiles?.display_name, track.cover_url); openNowPlaying(); }}
                    onAvatarPress={() => router.push(`/profile/${track.user_id}`)}
                    onOptions={() => showOptions({
                      postId: track.id,
                      isOwn: track.user_id === currentUserId,
                      onEdit: () => router.push(`/edit-post/${track.id}`),
                      onDeleted: () => {
                        setTrendingTracks(prev => prev.filter(t => t.id !== track.id));
                        setForYouTracks(prev => prev.filter(t => t.id !== track.id));
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
                      color={COLORS.primary}
                    />
                  </TouchableOpacity>
                )}
              </View>
            )}

            {/* — More of what you like (music only) — */}
            {!isContentTag && forYouTracks.length > 0 && (
              <>
                <Text style={[styles.discoverSectionTitleLg, { marginTop: SPACING.xl }]}>More of what you like</Text>

                {/* Relevant artists — tap a circle to open that profile */}
                {relevantArtists.length > 0 && (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.artistScroll}>
                    {relevantArtists.map(artist => (
                      <TouchableOpacity
                        key={artist.id}
                        style={styles.artistCircleItem}
                        activeOpacity={0.8}
                        onPress={() => router.push(`/profile/${artist.id}`)}
                      >
                        {artist.avatar_url ? (
                          <Image source={{ uri: artist.avatar_url }} style={styles.artistAvatar} />
                        ) : (
                          <LinearGradient colors={GRADIENTS.primary as any} style={styles.artistAvatar}>
                            <Text style={styles.artistAvatarText}>
                              {(artist.display_name ?? artist.username ?? '?').charAt(0).toUpperCase()}
                            </Text>
                          </LinearGradient>
                        )}
                        <Text style={styles.artistName} numberOfLines={1}>
                          {artist.display_name ?? artist.username}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                )}

                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.forYouScroll}>
                  {forYouTracks.map(track => (
                    <TouchableOpacity
                      key={track.id}
                      style={styles.forYouCard}
                      activeOpacity={0.8}
                      onPress={() => { play(track.id, track.media_url, track.caption, track.profiles?.display_name, track.cover_url); openNowPlaying(); }}
                    >
                      {track.cover_url ? (
                        <Image source={{ uri: track.cover_url }} style={styles.forYouCover} />
                      ) : (
                        <LinearGradient colors={GRADIENTS.primarySoft as any} style={styles.forYouCover}>
                          <Ionicons name="musical-notes" size={28} color={COLORS.primary} />
                        </LinearGradient>
                      )}
                      <Text style={styles.forYouTitle} numberOfLines={2}>{track.caption}</Text>
                      <Text style={styles.forYouArtist} numberOfLines={1}>
                        {track.profiles?.display_name ?? track.profiles?.username}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
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
                  >
                    {todaysPick.cover_url ? (
                      <Image source={{ uri: todaysPick.cover_url }} style={styles.todaysCover} />
                    ) : (
                      <LinearGradient colors={GRADIENTS.primarySoft as any} style={styles.todaysCover}>
                        <Ionicons name="musical-notes" size={20} color={COLORS.primary} />
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
                      color={COLORS.primary}
                    />
                  </TouchableOpacity>
                </View>
              </>
            )}

          </ScrollView>
        )
      )}

      {/* Playlists list */}
      {activeView === 'playlists' && !selectedPlaylist && (
        <FlatList
          data={playlists}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.emptyIcon}>
                <Ionicons name="musical-notes" size={32} color={COLORS.primary} />
              </LinearGradient>
              <Text style={styles.emptyTitle}>No playlists yet</Text>
              <Text style={styles.emptySubtitle}>Tap "+ Playlist" to create your first one</Text>
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.playlistRow}
              onPress={() => { setSelectedPlaylist(item); fetchPlaylistTracks(item.id); }}
              onLongPress={() => deletePlaylist(item.id)}
            >
              <LinearGradient colors={GRADIENTS.primarySoft} style={styles.playlistIcon}>
                <Ionicons name="musical-notes" size={22} color={COLORS.primary} />
              </LinearGradient>
              <View style={styles.playlistInfo}>
                <Text style={styles.playlistName}>{item.name}</Text>
                <Text style={styles.playlistMeta}>{item.is_public ? 'Public' : 'Private'} · Long press to delete</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={COLORS.textTertiary} />
            </TouchableOpacity>
          )}
        />
      )}

      {/* Playlist tracks */}
      {activeView === 'playlists' && selectedPlaylist && (
        <View style={{ flex: 1 }}>
          <TouchableOpacity style={styles.backBtn} onPress={() => { setSelectedPlaylist(null); setTracks([]); }}>
            <Ionicons name="chevron-back" size={18} color={COLORS.primary} />
            <Text style={styles.backText}>Playlists</Text>
          </TouchableOpacity>
          <Text style={styles.playlistTitle}>{selectedPlaylist.name}</Text>
          {tracksLoading ? (
            <ActivityIndicator color={COLORS.primary} style={{ marginTop: SPACING.xl }} />
          ) : (
            <FlatList
              data={tracks}
              keyExtractor={item => item.post_id}
              contentContainerStyle={styles.listContent}
              ListEmptyComponent={
                <View style={styles.emptyContainer}>
                  <Text style={styles.emptySubtitle}>No tracks yet — save audio posts from the feed</Text>
                </View>
              }
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
                    onEdit: () => router.push(`/edit-post/${item.post_id}`),
                    onDeleted: () => setTracks(prev => prev.filter(t => t.post_id !== item.post_id)),
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
          refreshControl={
            <RefreshControl
              refreshing={savedRefreshing}
              onRefresh={async () => {
                if (!currentUserId) return;
                setSavedRefreshing(true);
                await fetchSavedTracks(currentUserId);
                setSavedRefreshing(false);
              }}
              tintColor={COLORS.primary}
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.emptyIcon}>
                <Ionicons name="bookmark" size={32} color={COLORS.primary} />
              </LinearGradient>
              <Text style={styles.emptyTitle}>No saved songs yet</Text>
              <Text style={styles.emptySubtitle}>Save audio posts from your feed</Text>
            </View>
          }
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
                onEdit: () => router.push(`/edit-post/${item.posts?.id}`),
                onDeleted: () => setSavedTracks(prev => prev.filter((s: any) => s.posts?.id !== item.posts?.id)),
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
          refreshControl={
            <RefreshControl
              refreshing={likedRefreshing}
              onRefresh={async () => {
                if (!currentUserId) return;
                setLikedRefreshing(true);
                await fetchLikedTracks(currentUserId);
                setLikedRefreshing(false);
              }}
              tintColor={COLORS.primary}
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.emptyIcon}>
                <Ionicons name="heart" size={32} color={COLORS.primary} />
              </LinearGradient>
              <Text style={styles.emptyTitle}>No liked songs yet</Text>
              <Text style={styles.emptySubtitle}>Like audio posts from your feed</Text>
            </View>
          }
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
                onEdit: () => router.push(`/edit-post/${item.posts?.id}`),
                onDeleted: () => setLikedTracks(prev => prev.filter((l: any) => l.posts?.id !== item.posts?.id)),
              })}
            />
          )}
        />
      )}
      </>
      )}

      {/* New playlist modal */}
      <Modal visible={showNewPlaylist} transparent animationType="slide" onRequestClose={() => setShowNewPlaylist(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>New Playlist</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="Playlist name..."
              placeholderTextColor={COLORS.textTertiary}
              value={newPlaylistName}
              onChangeText={setNewPlaylistName}
              autoFocus
            />
            <View style={styles.modalBtns}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => { setShowNewPlaylist(false); setNewPlaylistName(''); }}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalCreate} onPress={createPlaylist}>
                <Text style={styles.modalCreateText}>Create</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
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


const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  loadingContainer: { flex: 1, backgroundColor: COLORS.background, alignItems: 'center', justifyContent: 'center' },

  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: SPACING.md, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.sm,
  },
  headerTitle: { color: COLORS.text, fontSize: 28, fontWeight: '800' },

  searchRow: { paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm },
  searchBar: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: COLORS.surfaceLight,
    borderRadius: RADIUS.full,
    borderWidth: 1, borderColor: COLORS.border,
    paddingHorizontal: SPACING.md, gap: SPACING.sm,
  },
  searchIcon: { marginRight: -4 },
  searchInput: { flex: 1, paddingVertical: SPACING.sm + 2, color: COLORS.text, fontSize: 15 },
  searchClear: { padding: 2, marginLeft: 2 },
  searchListContent: { padding: SPACING.md, gap: SPACING.sm },
  searchEmpty: { color: COLORS.textTertiary, fontSize: 14, textAlign: 'center', paddingVertical: SPACING.xl },
  newBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: COLORS.primary, borderRadius: RADIUS.full,
    paddingVertical: SPACING.xs + 2, paddingHorizontal: SPACING.md,
  },
  newBtnText: { color: COLORS.text, fontSize: 13, fontWeight: '700' },

  toggleRow: {
    flexDirection: 'row',
    paddingHorizontal: SPACING.sm,
    gap: SPACING.xs,
    // Centered between the search bar (8px below it) and the section title
    // (16px above its text): 8 + marginTop(16) = marginBottom(8) + 16 = 24 each side.
    marginTop: SPACING.md,
    marginBottom: SPACING.sm,
  },
  toggleBtn: {
    flex: 1,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 4,
    paddingVertical: SPACING.xs + 2,
    borderRadius: RADIUS.xl, borderWidth: 1, borderColor: COLORS.border,
  },
  toggleBtnActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  toggleText: { color: COLORS.textSecondary, fontSize: 12, fontWeight: '500' },
  toggleTextActive: { color: COLORS.text, fontWeight: '700' },

  list: { flex: 1 },
  // flexGrow so short/empty lists still fill the screen — lets pull-to-refresh
  // register when swiping anywhere, not only over a track row.
  listContent: { flexGrow: 1, padding: SPACING.md, gap: SPACING.sm },

  playlistRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: COLORS.surfaceLight, borderRadius: RADIUS.md,
    padding: SPACING.md, borderWidth: 1, borderColor: COLORS.border, gap: SPACING.md,
  },
  playlistIcon: { width: 48, height: 48, borderRadius: RADIUS.md, alignItems: 'center', justifyContent: 'center' },
  playlistInfo: { flex: 1 },
  playlistName: { color: COLORS.text, fontSize: 15, fontWeight: '700' },
  playlistMeta: { color: COLORS.textTertiary, fontSize: 12, marginTop: 2 },

  backBtn: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm },
  backText: { color: COLORS.primary, fontSize: 15, fontWeight: '600' },
  playlistTitle: { color: COLORS.text, fontSize: 22, fontWeight: '800', paddingHorizontal: SPACING.md, marginBottom: SPACING.sm },

  emptyContainer: { alignItems: 'center', paddingTop: SPACING.xxl, gap: SPACING.md },
  emptyIcon: { width: 72, height: 72, borderRadius: RADIUS.xl, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { color: COLORS.text, fontSize: 18, fontWeight: '700' },
  emptySubtitle: { color: COLORS.textSecondary, fontSize: 14, textAlign: 'center' },

  // ─── Discover styles ──────────────────────────────────────────────────────
  discoverContent: { paddingBottom: SPACING.xxl * 3 },

  discoverSectionTitle: {
    color: COLORS.text, fontSize: 20, fontWeight: '800',
    paddingHorizontal: SPACING.md, paddingTop: SPACING.md, paddingBottom: SPACING.sm,
  },
  // Larger primary section header (Genres, More of what you like) — one tier
  // above the secondary "Trending" sub-heading.
  discoverSectionTitleLg: {
    color: COLORS.text, fontSize: 26, fontWeight: '800',
    paddingHorizontal: SPACING.md, paddingTop: SPACING.md, paddingBottom: SPACING.sm,
  },
  discoverEmpty: { color: COLORS.textSecondary, fontSize: 14, paddingVertical: SPACING.md },

  genrePills: { paddingHorizontal: SPACING.md, paddingVertical: 4, gap: SPACING.sm, paddingBottom: SPACING.sm },
  genrePill: {
    borderRadius: RADIUS.md, borderWidth: 1, borderColor: COLORS.border,
    overflow: 'hidden',
  },
  genrePillActive: { borderColor: COLORS.primary },
  // One shared inner container — same padding for both active and inactive pills
  // so their height is always identical regardless of which has the gradient.
  genrePillInner: {
    paddingVertical: 11, paddingHorizontal: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  genrePillText: { color: COLORS.textSecondary, fontSize: 15, fontWeight: '600' },
  genrePillTextActive: { color: COLORS.text, fontWeight: '700' },

  trendingList: { paddingHorizontal: SPACING.xs, gap: SPACING.xs },
  showMoreBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 4, paddingVertical: SPACING.sm, marginTop: SPACING.xs,
  },
  showMoreText: { color: COLORS.primary, fontSize: 13, fontWeight: '600' },

  forYouScroll: { paddingHorizontal: SPACING.md, gap: SPACING.md, paddingBottom: SPACING.sm },
  forYouCard: { width: FOR_YOU_W, gap: SPACING.xs },
  forYouCover: {
    width: FOR_YOU_W, height: FOR_YOU_W, borderRadius: RADIUS.md,
    backgroundColor: COLORS.surfaceLight, alignItems: 'center', justifyContent: 'center',
  },
  forYouTitle: { color: COLORS.text, fontSize: 13, fontWeight: '700' },
  forYouArtist: { color: COLORS.textSecondary, fontSize: 12 },

  artistScroll: { paddingHorizontal: SPACING.md, gap: SPACING.md, paddingBottom: SPACING.md },
  artistCircleItem: { width: 68, alignItems: 'center', gap: 6 },
  artistAvatar: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: COLORS.surfaceLight, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: COLORS.border,
  },
  artistAvatarText: { color: COLORS.text, fontSize: 24, fontWeight: '800' },
  artistName: { color: COLORS.textSecondary, fontSize: 12, textAlign: 'center', width: 68 },

  todaysPickSection: {
    marginHorizontal: SPACING.md,
    borderRadius: RADIUS.lg, backgroundColor: COLORS.surfaceLight,
    borderWidth: 1, borderColor: COLORS.border, overflow: 'hidden',
  },
  todaysPickRow: {
    flexDirection: 'row', alignItems: 'center',
    padding: SPACING.md, gap: SPACING.md,
  },
  todaysCover: {
    width: 52, height: 52, borderRadius: RADIUS.md,
    backgroundColor: COLORS.background, alignItems: 'center', justifyContent: 'center',
  },
  todaysInfo: { flex: 1 },
  todaysTitle: { color: COLORS.text, fontSize: 15, fontWeight: '700' },
  todaysArtist: { color: COLORS.textSecondary, fontSize: 13, marginTop: 2 },
  // ──────────────────────────────────────────────────────────────────────────

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: COLORS.surfaceLight, borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl, padding: SPACING.lg, gap: SPACING.md },
  modalTitle: { color: COLORS.text, fontSize: 18, fontWeight: '800' },
  modalInput: { backgroundColor: COLORS.background, borderWidth: 1, borderColor: COLORS.border, borderRadius: RADIUS.md, padding: SPACING.md, color: COLORS.text, fontSize: 15 },
  modalBtns: { flexDirection: 'row', gap: SPACING.sm },
  modalCancel: { flex: 1, backgroundColor: COLORS.background, borderRadius: RADIUS.md, padding: SPACING.md, alignItems: 'center', borderWidth: 1, borderColor: COLORS.border },
  modalCancelText: { color: COLORS.textSecondary, fontSize: 15, fontWeight: '600' },
  modalCreate: { flex: 1, backgroundColor: COLORS.primary, borderRadius: RADIUS.md, padding: SPACING.md, alignItems: 'center' },
  modalCreateText: { color: COLORS.text, fontSize: 15, fontWeight: '700' },
});
