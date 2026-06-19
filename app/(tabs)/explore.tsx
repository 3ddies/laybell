import {
  View, Text, StyleSheet, TextInput,
  FlatList, TouchableOpacity, Image, ActivityIndicator, Keyboard, ScrollView,
  PanResponder, Animated, Easing, Dimensions,
} from 'react-native';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter, useFocusEffect } from 'expo-router';
import { useNavigation } from '@react-navigation/native';
import { useTabSwipeControl } from '../../contexts/PagerContext';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { SPACING, RADIUS, GRADIENTS, SHADOWS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import ExploreGrid from '../../components/ExploreGrid';
import TrackRow from '../../components/TrackRow';
import FollowButton from '../../components/FollowButton';
import SuggestedAccounts from '../../components/SuggestedAccounts';
import HighlightText from '../../components/HighlightText';
import { maybeRefreshLocation } from '../../lib/location';
import StoryAvatar from '../../components/StoryAvatar';
import BadgeEmblem from '../../components/BadgeEmblem';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { badgeRingColors, chosenTier, specialRingTier, rawTier, tierRank } from '../../lib/badges';
import { postMatchTier, profileMatchTier } from '../../lib/searchRank';
import { usePostOptions } from '../../contexts/PostOptionsContext';
import { fetchBlockedIds } from '../../lib/blocks';
import { useAudio } from '../../contexts/AudioContext';
import { GENRES as MUSIC_GENRES, GENRE_FILTERS, CONTENT_TAGS, isAudioPost } from '../../lib/genres';
import {
  buildAffinityProfile, loadSeenPostIds, recordSeenPostIds, scorePost,
  sortRailByAffinity, EMPTY_PROFILE, type UserAffinityProfile,
} from '../../lib/feedScorer';

// Genre clusters for the All grid: 4-song stacks titled by genre, cached per
// user. Refreshes every 24h — or every 3h when the user is actively consuming
// from them (2+ cluster plays since the last refresh).
const CLUSTERS_KEY = 'explore_genre_clusters_v1';
const CLUSTERS_TTL_IDLE_MS = 24 * 60 * 60 * 1000;
const CLUSTERS_TTL_ACTIVE_MS = 3 * 60 * 60 * 1000;
const CLUSTERS_ACTIVE_PLAYS = 2;
const CLUSTERS_MAX = 14;

type SongCluster = { title: string; songs: any[] };

type Post = {
  id: string; type: string; media_url: string;
  caption: string; created_at: string; user_id: string;
  profiles: { username: string; display_name: string; avatar_url?: string | null };
  likes?: { count: number }[];
  comments?: { count: number }[];
  thumbnail_url?: string | null;
  aspect_ratio?: string | null;
  stream_count?: number;
  save_count?: number;
  cover_url?: string | null;
  genre?: string | null;
};
type Profile = {
  id: string; username: string; display_name: string;
  avatar_url: string | null; badge_tier: string | null; badge_show?: boolean | null;
};

export default function ExploreScreen() {
  const { show: showOptions } = usePostOptions();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { play, currentTrack, isPlaying, expand } = useAudio();
  const [searchQuery, setSearchQuery] = useState('');
  const searchRefs = useRef<Record<string, any>>({}); // per-row nodes for expand-from-row open
  // Search results are sorted/filtered into tabs. One query fetches everything;
  // the tabs filter client-side (no re-query when switching tabs).
  const [searchTab, setSearchTab] = useState<'relevancy' | 'posts' | 'music' | 'videos' | 'accounts'>('relevancy');
  const [searchFocused, setSearchFocused] = useState(false);
  const [selectedGenre, setSelectedGenre] = useState('All');
  const [posts, setPosts] = useState<Post[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [trendingPosts, setTrendingPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [seenPostIds, setSeenPostIds] = useState<Set<string>>(new Set());
  // Genre rail ordered by user affinity — music genres and the content-type tags
  // (Podcasts / Audiobooks) interleave by relevancy, most-engaged first after
  // "All". Mirrors the Music Discover bar.
  const [orderedGenres, setOrderedGenres] = useState<string[]>([...GENRE_FILTERS, ...CONTENT_TAGS]);
  const affinityProfile = useRef<UserAffinityProfile>(EMPTY_PROFILE);
  const followingSetRef = useRef<Set<string>>(new Set());
  const blockedIdsRef = useRef<Set<string>>(new Set());
  // Genre song clusters (All view) + the cache record they came from, so plays
  // can be counted against the active refresh window.
  const [songClusters, setSongClusters] = useState<SongCluster[]>([]);
  const clustersKeyRef = useRef<string | null>(null);

  // Drop archived posts (archived_at set) and posts from blocked users before
  // ranking/display. archived_at is absent pre-migration → harmless no-op.
  const visiblePosts = (rows: any[] = []) =>
    rows.filter((p) => !p.archived_at && !blockedIdsRef.current.has(p.user_id));

  // ── Dwell-swipe rule (same as the Music page) ──────────────────────────────
  // After 4 consecutive seconds on Explore, horizontal swipes step through the
  // genre pills instead of changing app tabs. Edges fall through to the app
  // pager (back past the first pill → Home; forward past the last → Post).
  // EXTRA RULE: two forward swipes within 2.5 seconds jump straight to the
  // next main screen (the new-post page), regardless of pill position.
  const navigation = useNavigation<any>();
  const setTabSwipe = useTabSwipeControl();
  const dwellArmedRef = useRef(false);
  const selectedGenreRef = useRef(selectedGenre);
  selectedGenreRef.current = selectedGenre;
  const orderedGenresRef = useRef(orderedGenres);
  orderedGenresRef.current = orderedGenres;
  const isSearchingRef = useRef(false);
  const lastForwardTsRef = useRef(0);

  useFocusEffect(useCallback(() => {
    const t = setTimeout(() => {
      dwellArmedRef.current = true;
      setTabSwipe(false);
    }, 4000);
    return () => {
      clearTimeout(t);
      dwellArmedRef.current = false;
      lastForwardTsRef.current = 0;
      setTabSwipe(true);
    };
  }, [setTabSwipe]));

  const genreSwipePan = useRef(PanResponder.create({
    // Forgiving dominance bar (1.25×) so slightly diagonal side-swipes register.
    onMoveShouldSetPanResponder: (_e, g) =>
      dwellArmedRef.current && !isSearchingRef.current &&
      Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.25,
    // Once claimed, never surrender mid-gesture — a child stealing the responder
    // meant the release handler never ran and the swipe silently vanished.
    onPanResponderTerminationRequest: () => false,
    onPanResponderRelease: (_e, g) => {
      // Register on distance OR a quick flick — short fast side-swipes count.
      if (Math.abs(g.dx) < 40 && Math.abs(g.vx) < 0.3) return;
      const order = orderedGenresRef.current;
      const idx = order.indexOf(selectedGenreRef.current);
      if (g.dx < 0) {
        // Forward. Double-swipe within 2.5s → straight to the new-post page.
        const now = Date.now();
        if (now - lastForwardTsRef.current < 2500) {
          lastForwardTsRef.current = 0;
          navigation.navigate('post');
          return;
        }
        lastForwardTsRef.current = now;
        if (idx < 0 || idx >= order.length - 1) navigation.navigate('post');
        else fetchByGenre(order[idx + 1]);
      } else {
        lastForwardTsRef.current = 0;
        if (idx <= 0) navigation.navigate('index');
        else fetchByGenre(order[idx - 1]);
      }
    },
  })).current;

  // Slide the content in from the travel direction when the genre changes
  // (fired by pill taps and the dwell-swipe alike).
  const genreAnimX = useRef(new Animated.Value(0)).current;
  const prevGenreIdxRef = useRef(0);
  useEffect(() => {
    const idx = orderedGenres.indexOf(selectedGenre);
    if (idx < 0) return;
    if (idx !== prevGenreIdxRef.current) {
      const dir = idx > prevGenreIdxRef.current ? 1 : -1;
      genreAnimX.setValue(dir * Dimensions.get('window').width);
      Animated.timing(genreAnimX, {
        toValue: 0, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: true,
      }).start();
    }
    prevGenreIdxRef.current = idx;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGenre]);

  useEffect(() => { setup(); }, []);

  useEffect(() => {
    if (searchQuery.trim().length > 0) {
      const t = setTimeout(() => handleSearch(), 500);
      return () => clearTimeout(t);
    } else {
      setProfiles([]); setPosts([]); setSearchTab('relevancy');
    }
  }, [searchQuery]);

  async function setup() {
    // Auth + seen-posts (AsyncStorage) in parallel — both fast
    const [{ data: { user } }, seen] = await Promise.all([
      supabase.auth.getUser(),
      loadSeenPostIds(),
    ]);
    const userId = user?.id ?? null;
    if (userId) setCurrentUserId(userId);
    setSeenPostIds(seen);

    // Quietly refresh the coarse location if it's on and stale (>1 day) — keeps the
    // "people near you" suggestions current without blocking the feed.
    if (userId) {
      (async () => {
        try {
          const { data } = await supabase.from('profiles').select('location_enabled').eq('id', userId).maybeSingle();
          await maybeRefreshLocation(userId, data?.location_enabled);
        } catch {}
      })();
    }

    // Affinity profile (AsyncStorage cache) + following list + blocks in parallel
    if (userId) {
      const [profile, followingResult, blocked] = await Promise.all([
        buildAffinityProfile(userId),
        supabase.from('follows').select('following_id').eq('follower_id', userId),
        fetchBlockedIds(),
      ]);
      affinityProfile.current = profile;
      followingSetRef.current = new Set(
        (followingResult.data ?? []).map((f: any) => f.following_id),
      );
      blockedIdsRef.current = blocked;
    }

    // Reorder the genre rail by affinity, keeping "All" pinned first. Genres and
    // the Podcasts/Audiobooks tags are ranked together, so the user's most-engaged
    // category (genre or content type) leads the scroll bar.
    setOrderedGenres(['All', ...sortRailByAffinity([...MUSIC_GENRES, ...CONTENT_TAGS], affinityProfile.current)]);

    loadGenreClusters(userId, seen); // cached — TTL-checked, non-blocking
    await fetchTrending(seen);
  }

  // Display name for a stored (lowercase) genre tag; untagged songs pool
  // under the generic trending title.
  function displayGenre(g?: string | null): string {
    if (!g) return 'Trending Songs';
    const hit = [...MUSIC_GENRES, ...CONTENT_TAGS].find(x => x.toLowerCase() === g.toLowerCase());
    return hit ?? g.charAt(0).toUpperCase() + g.slice(1);
  }

  // Build (or load from cache) the genre clusters for the All grid.
  // Selection: the shared feed scorer (relevance / trending / likes / fresh-
  // ness vs the seen-set) times a modest creator-badge trust boost. The user's
  // most-interacted genres lead, then the order CYCLES — each reappearance of
  // a genre carries its next-best 4 songs — until the pool runs dry.
  // A cached cluster can hold songs that were deleted (or whose author hid their
  // account) since it was built — they'd otherwise stay visible/clickable in the
  // grid for the whole 24h TTL. Cheaply verify the cached ids against live posts
  // (one query) and drop any that are gone, keeping the ≥2-song stack rule.
  async function pruneDeletedClusters(key: string, cached: any) {
    try {
      const clusters: SongCluster[] = cached.clusters ?? [];
      const ids = [...new Set(clusters.flatMap((c: any) => c.songs.map((s: any) => s.id)))];
      if (!ids.length) return;
      const { data } = await supabase
        .from('posts').select('id')
        .in('id', ids).eq('is_public', true).is('archived_at', null);
      if (!data) return;
      const alive = new Set((data as any[]).map((r) => r.id));
      if (ids.every((id) => alive.has(id))) return; // nothing removed — leave the cache as-is
      const pruned = clusters
        .map((c: any) => ({ ...c, songs: c.songs.filter((s: any) => alive.has(s.id)) }))
        .filter((c: any) => c.songs.length >= 2);
      setSongClusters(pruned);
      AsyncStorage.setItem(key, JSON.stringify({ ...cached, clusters: pruned })).catch(() => {});
    } catch {}
  }

  async function loadGenreClusters(userId: string | null, overrideSeen?: Set<string>) {
    const key = `${CLUSTERS_KEY}_${userId ?? 'anon'}`;
    clustersKeyRef.current = key;
    try {
      const raw = await AsyncStorage.getItem(key);
      if (raw) {
        const cached = JSON.parse(raw);
        const ttl = (cached.plays ?? 0) >= CLUSTERS_ACTIVE_PLAYS ? CLUSTERS_TTL_ACTIVE_MS : CLUSTERS_TTL_IDLE_MS;
        if (Date.now() - (cached.refreshedAt ?? 0) < ttl && Array.isArray(cached.clusters) && cached.clusters.length) {
          setSongClusters(cached.clusters);          // instant render
          pruneDeletedClusters(key, cached);         // then drop any since-deleted/hidden songs
          return;
        }
      }
    } catch {}

    const { data } = await supabase
      .from('posts')
      .select('id, type, media_url, caption, cover_url, stream_count, genre, created_at, user_id, profiles!posts_user_id_fkey(id, username, display_name, badge_tier), likes(count), comments(count)')
      .eq('is_public', true)
      .is('archived_at', null) // archived songs are hidden from browse/stream (visiblePosts can't catch it — archived_at isn't in this select)
      .eq('type', 'audio')
      .order('stream_count', { ascending: false })
      .limit(160);
    const seen = overrideSeen ?? seenPostIds;
    const now = Date.now();
    const ranked = visiblePosts(data ?? [])
      .map((p: any) => ({
        p,
        s: scorePost(p, affinityProfile.current, followingSetRef.current, seen, now)
          * (1 + 0.05 * tierRank(rawTier(p.profiles))),
      }))
      .sort((a, b) => b.s - a.s);

    // Bucket by genre (best-ranked first within each), chunk into stacks of 4
    // (a trailing single is dropped — one-song cards look bare).
    const byGenre: Record<string, any[]> = {};
    for (const { p } of ranked) (byGenre[displayGenre(p.genre)] ||= []).push(p);
    const chunksOf: Record<string, any[][]> = {};
    for (const g of Object.keys(byGenre)) {
      const chunks: any[][] = [];
      for (let i = 0; i < byGenre[g].length; i += 4) chunks.push(byGenre[g].slice(i, i + 4));
      chunksOf[g] = chunks.filter(c => c.length >= 2 || byGenre[g].length === 1);
    }

    // Most-interacted genres first, cycling round-robin down the feed.
    const order = sortRailByAffinity(Object.keys(byGenre), affinityProfile.current);
    const clusters: SongCluster[] = [];
    for (let cycle = 0; clusters.length < CLUSTERS_MAX; cycle++) {
      let pushedAny = false;
      for (const g of order) {
        const chunk = chunksOf[g]?.[cycle];
        if (chunk?.length) {
          clusters.push({ title: g, songs: chunk });
          pushedAny = true;
          if (clusters.length >= CLUSTERS_MAX) break;
        }
      }
      if (!pushedAny) break;
    }

    setSongClusters(clusters);
    AsyncStorage.setItem(key, JSON.stringify({ clusters, refreshedAt: Date.now(), plays: 0 })).catch(() => {});
  }

  // A song played from a cluster — counts toward the 2-play threshold that
  // switches this window's refresh from 24h to 3h.
  function noteClusterPlay() {
    const key = clustersKeyRef.current;
    if (!key) return;
    AsyncStorage.getItem(key).then(raw => {
      if (!raw) return;
      const rec = JSON.parse(raw);
      rec.plays = (rec.plays ?? 0) + 1;
      return AsyncStorage.setItem(key, JSON.stringify(rec));
    }).catch(() => {});
  }

  // `overrideSeen` is passed from setup() before the seenPostIds state update applies.
  async function fetchTrending(overrideSeen?: Set<string>) {
    const { data } = await supabase
      .from('posts')
      .select('*, profiles!posts_user_id_fkey (username, display_name, badge_tier, badge_show, profile_theme), likes(count), comments(count)')
      .eq('is_public', true)
      .order('created_at', { ascending: false })
      .limit(30);
    if (data) {
      const seen = overrideSeen ?? seenPostIds;
      const now  = Date.now();
      const sorted = visiblePosts(data).sort((a: any, b: any) =>
        scorePost(b, affinityProfile.current, followingSetRef.current, seen, now) -
        scorePost(a, affinityProfile.current, followingSetRef.current, seen, now),
      );
      setTrendingPosts(sorted as any);
      recordSeenPostIds(sorted.map((p: any) => p.id));
    }
    setLoading(false);
  }

  async function fetchByGenre(genre: string, silent = false, overrideSeen?: Set<string>) {
    if (!silent) setLoading(true);
    setSelectedGenre(genre);
    if (genre === 'All') { await fetchTrending(overrideSeen); if (!silent) setLoading(false); return; }

    let q = supabase
      .from('posts')
      .select('*, profiles!posts_user_id_fkey (username, display_name, badge_tier, badge_show, profile_theme), likes(count), comments(count)')
      .eq('is_public', true)
      .order('created_at', { ascending: false })
      .limit(30);

    // Podcasts / Audiobooks filter by type; music genres filter by genre field.
    if (genre === 'Podcasts') {
      q = q.eq('type', 'podcast');
    } else if (genre === 'Audiobooks') {
      q = q.eq('type', 'audiobook');
    } else {
      q = q.eq('genre', genre.toLowerCase());
    }

    const { data } = await q;
    if (data) {
      const seen = overrideSeen ?? seenPostIds;
      const now  = Date.now();
      const sorted = visiblePosts(data).sort((a: any, b: any) =>
        scorePost(b, affinityProfile.current, followingSetRef.current, seen, now) -
        scorePost(a, affinityProfile.current, followingSetRef.current, seen, now),
      );
      setTrendingPosts(sorted as any);
      recordSeenPostIds(sorted.map((p: any) => p.id));
    }
    if (!silent) setLoading(false);
  }

  async function onRefresh() {
    setRefreshing(true);
    // Reload the seen-set so already-shown posts are deprioritised and fresh
    // content surfaces toward the top on every pull-to-refresh.
    const seen = await loadSeenPostIds();
    setSeenPostIds(seen);
    if (selectedGenre === 'All') await fetchTrending(seen);
    else await fetchByGenre(selectedGenre, true, seen);
    loadGenreClusters(currentUserId, seen); // re-checks the 3h/24h window
    setRefreshing(false);
  }

  async function handleSearch() {
    if (!searchQuery.trim()) return;
    setSearching(true);

    const q = searchQuery.toLowerCase().trim();

    // Matching accounts — surfaced atop the Relevancy tab and used to also pull
    // their posts. Ordered by how closely the name matches.
    const { data: profData } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, badge_tier, badge_show, profile_theme, hidden')
      .or(`username.ilike.%${searchQuery}%,display_name.ilike.%${searchQuery}%`)
      .limit(20);
    // Hidden accounts never appear in search.
    const matched = (profData ?? []).filter((p: any) => !p.hidden);
    setProfiles([...matched].sort((a: any, b: any) => profileMatchTier(b, q) - profileMatchTier(a, q)));

    const authorIds = matched.map((p: any) => p.id);
    let query = supabase
      .from('posts')
      .select(`
        *,
        profiles!posts_user_id_fkey (username, display_name, avatar_url, badge_tier, badge_show, profile_theme),
        likes(count),
        comments(count)
      `)
      .eq('is_public', true)
      .limit(40);

    if (authorIds.length > 0) {
      query = query.or(`caption.ilike.%${searchQuery}%,user_id.in.(${authorIds.join(',')})`);
    } else {
      query = query.ilike('caption', `%${searchQuery}%`);
    }

    const { data } = await query;
    if (data) {
      // Relevancy = closeness of match first, then the post's algorithm score
      // (scorePost). No seen-penalty — the user is actively searching.
      const now = Date.now();
      const ranked = visiblePosts(data).sort((a: any, b: any) => {
        const ta = postMatchTier(a, q), tb = postMatchTier(b, q);
        if (tb !== ta) return tb - ta;
        return scorePost(b, affinityProfile.current, followingSetRef.current, new Set(), now) -
               scorePost(a, affinityProfile.current, followingSetRef.current, new Set(), now);
      });
      setPosts(ranked as any);
    }

    setSearching(false);
  }

  const isSearching = searchQuery.trim().length > 0;
  isSearchingRef.current = isSearching; // dwell-swipe stays out of search mode

  // Highlight ONLY the single result at the very top of the Relevancy tab — the
  // first matching account if any, otherwise the top-ranked post. Everything else
  // renders plain so the highlight reads as a signal, not noise.
  const q = searchQuery.trim().toLowerCase();
  const relevancyTopPostId = (searchTab === 'relevancy' && q && profiles.length === 0 && posts.length > 0)
    ? posts[0].id : null;

  // One account row — reused by the Relevancy header (highlighted) and the
  // dedicated Accounts tab (plain).
  const renderAccount = (acc: any, highlight = false) => (
    <TouchableOpacity key={acc.id} style={styles.accountRow} onPress={() => router.push(`/profile/${acc.id}`)}>
      <StoryAvatar
        userId={acc.id}
        avatarUrl={acc.avatar_url}
        name={acc.display_name}
        size={48}
        badgeRing={specialRingTier(chosenTier(acc)) ? badgeRingColors(chosenTier(acc)) : undefined}
      />
      <View style={styles.accountInfo}>
        <View style={styles.accountNameRow}>
          <HighlightText text={acc.display_name} query={highlight ? searchQuery : undefined} style={[styles.accountName, styles.flexShrink]} highlightStyle={styles.searchHl} numberOfLines={1} />
          <BadgeEmblem profile={acc} size={13} />
        </View>
        <HighlightText text={`@${acc.username}`} query={highlight ? searchQuery : undefined} style={styles.accountUsername} highlightStyle={styles.searchHl} numberOfLines={1} />
      </View>
      <FollowButton userId={acc.id} />
    </TouchableOpacity>
  );

  return (
    // Dwell-swipe detector on the root: after 4s here, horizontal flings step
    // the genre pills (see genreSwipePan).
    <View style={styles.container} {...genreSwipePan.panHandlers}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Explore</Text>
      </View>

      {/* Search */}
      <View style={styles.searchRow}>
        <View style={styles.searchBar}>
          <Ionicons name="search-outline" size={18} color={colors.textTertiary} style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            placeholder="Artists, songs, captions..."
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

      {/* Search tabs: Relevancy · Posts · Music · Videos · Accounts */}
      {isSearching && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.toggleScroll}
          contentContainerStyle={styles.toggleRow}
        >
          {(['relevancy', 'posts', 'music', 'videos', 'accounts'] as const).map(tab => (
            <TouchableOpacity
              key={tab}
              style={[styles.toggleBtn, searchTab === tab && styles.toggleBtnActive]}
              onPress={() => setSearchTab(tab)}
            >
              <Text style={[styles.toggleText, searchTab === tab && styles.toggleTextActive]}>
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Genre pills */}
      {!isSearching && (
        <FlatList
          horizontal
          data={orderedGenres}
          keyExtractor={item => item}
          showsHorizontalScrollIndicator={false}
          style={styles.genreFlatList}
          contentContainerStyle={styles.genreList}
          renderItem={({ item }) => {
            const active = selectedGenre === item;
            return active ? (
              <TouchableOpacity onPress={() => fetchByGenre(item)} style={styles.genrePillWrap}>
                <LinearGradient colors={GRADIENTS.primaryWarm} style={styles.genrePillGradient}>
                  <Text style={styles.genreTextActive}>{item}</Text>
                </LinearGradient>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.genrePillWrap, styles.genrePill]}
                onPress={() => fetchByGenre(item)}
              >
                <Text style={styles.genreText}>{item}</Text>
              </TouchableOpacity>
            );
          }}
        />
      )}

      {/* Content — slides in from the travel direction on genre change */}
      <Animated.View style={[styles.contentWrap, { transform: [{ translateX: genreAnimX }] }]}>
      {loading || searching ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : isSearching ? (
        searchTab === 'accounts' ? (
          <FlatList
            key="accounts"
            data={profiles}
            keyExtractor={item => item.id}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={<Text style={styles.emptyText}>No accounts found</Text>}
            renderItem={({ item }) => renderAccount(item, false)}
          />
        ) : (
        <FlatList
          key={searchTab}
          data={searchTab === 'posts'
            ? posts.filter(p => p.type === 'image' || p.type === 'slideshow')
            : searchTab === 'music'
            ? posts.filter(p => isAudioPost(p.type))
            : searchTab === 'videos'
            ? posts.filter(p => p.type === 'video')
            : posts}
          keyExtractor={item => item.id}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            searchTab === 'relevancy' && profiles.length > 0 ? (
              <View style={styles.accountsHeader}>
                {profiles.slice(0, 6).map((acc: any, i: number) => renderAccount(acc, i === 0))}
                <View style={styles.accountsDivider} />
              </View>
            ) : null
          }
          ListEmptyComponent={
            <Text style={styles.emptyText}>
              {searchTab === 'posts' ? 'No image posts found'
                : searchTab === 'music' ? 'No music found'
                : searchTab === 'videos' ? 'No videos found'
                : 'No results found'}
            </Text>
          }
          renderItem={({ item }) => {
            // Only the very top relevancy result gets highlighted.
            const hq = item.id === relevancyTopPostId ? searchQuery : undefined;
            return isAudioPost(item.type) ? (
            <TrackRow
              caption={item.caption}
              artist={item.profiles?.display_name}
              username={item.profiles?.username}
              streams={item.stream_count}
              cover={item.cover_url}
              avatarUrl={item.profiles?.avatar_url}
              badgeProfile={item.profiles}
              badgeOwnerId={item.user_id}
              highlightQuery={hq}
              isPlaying={currentTrack?.id === item.id && isPlaying}
              onPlay={() => play({ id: item.id, uri: item.media_url, caption: item.caption, artist: item.profiles?.display_name, cover: item.cover_url })}
              onCoverPress={() => { play({ id: item.id, uri: item.media_url, caption: item.caption, artist: item.profiles?.display_name, cover: item.cover_url }); expand(); }}
              onAvatarPress={() => router.push(`/profile/${item.user_id}`)}
              onOptions={() => showOptions({
                postId: item.id,
                isOwn: item.user_id === currentUserId,
                authorId: item.user_id,
                authorName: item.profiles?.username,
                mediaType: item.type ?? 'audio',
                onEdit: () => router.push(`/edit-post/${item.id}`),
                onDeleted: () => setPosts(prev => prev.filter(p => p.id !== item.id)),
                onArchived: () => setPosts(prev => prev.filter(p => p.id !== item.id)),
                onBlocked: () => setPosts(prev => prev.filter(p => p.user_id !== item.user_id)),
              })}
            />
          ) : (
            <TouchableOpacity
              ref={(n) => { if (n) searchRefs.current[item.id] = n; }}
              style={styles.postRow}
              onPress={() => {
                const node = searchRefs.current[item.id];
                const pathname = item.type === 'video' ? '/reel/[id]' : '/post/[id]';
                const seed = JSON.stringify(item);
                if (node?.measureInWindow) {
                  node.measureInWindow((x: number, y: number, width: number, height: number) =>
                    router.push({ pathname, params: { id: item.id, post: seed, src: JSON.stringify({ x, y, width, height }) } }));
                } else {
                  router.push({ pathname, params: { id: item.id, post: seed } });
                }
              }}
              onLongPress={() => showOptions({
                postId: item.id,
                isOwn: item.user_id === currentUserId,
                authorId: item.user_id,
                authorName: item.profiles?.username,
                mediaType: item.type,
                onEdit: () => router.push(`/edit-post/${item.id}`),
                onDeleted: () => setPosts(prev => prev.filter(p => p.id !== item.id)),
                onArchived: () => setPosts(prev => prev.filter(p => p.id !== item.id)),
                onBlocked: () => setPosts(prev => prev.filter(p => p.user_id !== item.user_id)),
              })}
            >
              {item.type === 'image' || item.type === 'slideshow' || (item.type === 'video' && item.thumbnail_url) ? (
                <Image source={{ uri: item.type === 'image' ? item.media_url : (item.thumbnail_url || item.media_url) }} style={styles.postThumb} />
              ) : (
                <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.postThumb}>
                  <Ionicons name={item.type === 'audio' ? 'musical-notes' : 'videocam'} size={20} color={colors.primary} />
                </LinearGradient>
              )}
              <View style={styles.postInfo}>
                <HighlightText text={item.caption || 'Audio Track'} query={hq} style={styles.postCaption} highlightStyle={styles.searchHl} numberOfLines={2} />
                <View style={styles.postMeta}>
                  <HighlightText text={`@${item.profiles?.username}`} query={hq} style={styles.postUser} highlightStyle={styles.searchHl} numberOfLines={1} />
                  <BadgeEmblem profile={item.profiles} ownerId={item.user_id} size={11} />
                  {((item.likes?.[0]?.count || 0) + (item.comments?.[0]?.count || 0)) > 0 && (
                    <View style={styles.postStats}>
                      <Ionicons name="heart" size={11} color={colors.like} />
                      <Text style={styles.postStatText}>{item.likes?.[0]?.count || 0}</Text>
                      <Ionicons name="chatbubble" size={11} color={colors.textTertiary} />
                      <Text style={styles.postStatText}>{item.comments?.[0]?.count || 0}</Text>
                    </View>
                  )}
                </View>
              </View>
              <FollowButton userId={item.user_id} />
              {/* Author's profile picture — tap to open their profile */}
              <TouchableOpacity onPress={() => router.push(`/profile/${item.user_id}`)} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                {item.profiles?.avatar_url ? (
                  <Image source={{ uri: item.profiles.avatar_url }} style={styles.postAuthorAvatar} />
                ) : (
                  <LinearGradient colors={GRADIENTS.primary} style={styles.postAuthorAvatar}>
                    <Text style={styles.postAuthorInitial}>{item.profiles?.display_name?.charAt(0).toUpperCase()}</Text>
                  </LinearGradient>
                )}
              </TouchableOpacity>
            </TouchableOpacity>
          );
        }}
        />
        )
      ) : (
        <ExploreGrid
          posts={trendingPosts}
          refreshing={refreshing}
          onRefresh={onRefresh}
          songTiles={selectedGenre !== 'All'}
          songClusters={selectedGenre === 'All' ? songClusters : undefined}
          onClusterSongPlay={noteClusterPlay}
          currentUserId={currentUserId}
          header={selectedGenre === 'All' ? <SuggestedAccounts currentUserId={currentUserId} /> : undefined}
          onPostDeleted={(id) => {
            setTrendingPosts(prev => prev.filter(p => p.id !== id));
            setPosts(prev => prev.filter(p => p.id !== id));
          }}
        />
      )}
      </Animated.View>
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  contentWrap: { flex: 1 },
  header: { paddingHorizontal: SPACING.md, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.sm },
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
  searchHl: { color: colors.primary, fontWeight: '800' },
  accountsHeader: {},
  accountsDivider: { height: 0.5, backgroundColor: colors.border, marginVertical: SPACING.sm },

  // Horizontal tab scroller — flexShrink:0 (on the scroller AND each pill) keeps the
  // pills at their content width so they scroll instead of compressing. No explicit
  // flexDirection on the content container: the horizontal ScrollView handles the
  // row layout (forcing flexDirection:'row' here squeezes the children to fit).
  toggleScroll: { flexGrow: 0, flexShrink: 0, marginBottom: SPACING.sm },
  toggleRow: { paddingHorizontal: SPACING.md, gap: SPACING.sm, alignItems: 'center' },
  toggleBtn: {
    flexShrink: 0,
    paddingVertical: SPACING.xs + 2, paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.full, borderWidth: 1, borderColor: colors.border,
  },
  toggleBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  toggleText: { color: colors.textSecondary, fontSize: 13, fontWeight: '500' },
  toggleTextActive: { color: colors.text, fontWeight: '700' },

  genreFlatList: {
    flexShrink: 0,
    flexGrow: 0,
  },
  genreList: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    gap: SPACING.sm,
    alignItems: 'flex-start',
  },
  genrePillWrap: {
    flexShrink: 0,
    borderRadius: RADIUS.full,
    overflow: 'hidden',
  },
  genrePill: {
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md + 2,
    backgroundColor: colors.surfaceLight,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIUS.full,
  },
  genrePillGradient: {
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md + 2,
    borderRadius: RADIUS.full,
  },
  genreText: { color: colors.textSecondary, fontSize: 13, fontWeight: '500' },
  genreTextActive: { color: colors.text, fontSize: 13, fontWeight: '700' },

  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  listContent: { padding: SPACING.md, gap: SPACING.sm },

  accountRow: {
    flexDirection: 'row', alignItems: 'center',
    padding: SPACING.md,
    backgroundColor: colors.surfaceLight,
    borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: colors.border, gap: SPACING.md,
  },
  accountAvatar: {
    width: 48, height: 48, borderRadius: RADIUS.full,
    backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center', borderWidth: 2,
  },
  accountAvatarText: { color: colors.text, fontSize: 18, fontWeight: '700' },
  accountInfo: { flex: 1 },
  accountNameRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  flexShrink: { flexShrink: 1 },
  accountName: { color: colors.text, fontSize: 15, fontWeight: '700' },
  accountUsername: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },

  postRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surfaceLight,
    borderRadius: RADIUS.md, gap: SPACING.md, paddingRight: SPACING.md,
    borderWidth: 1, borderColor: colors.border, overflow: 'hidden',
  },
  postThumb: { width: 64, height: 64, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  postInfo: { flex: 1, paddingRight: SPACING.xs },
  postCaption: { color: colors.text, fontSize: 14, fontWeight: '500' },
  postMeta: { flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: SPACING.sm },
  postUser: { color: colors.textSecondary, fontSize: 12 },
  postStats: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  postStatText: { color: colors.textTertiary, fontSize: 11 },
  postAuthorAvatar: {
    width: 30, height: 30, borderRadius: 15, flexShrink: 0,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceLight,
  },
  postAuthorInitial: { color: '#fff', fontSize: 12, fontWeight: '700' },
  postTypeTag: {
    width: 28, height: 28, borderRadius: RADIUS.full,
    backgroundColor: colors.primary + '18',
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },

  gridContent: { padding: SPACING.xs, gap: SPACING.xs },
  gridItem: {
    flex: 1, margin: SPACING.xs, aspectRatio: 1,
    borderRadius: RADIUS.md, overflow: 'hidden',
    backgroundColor: colors.surfaceLight,
  },
  gridImage: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm },
  gridCaption: { color: colors.textSecondary, fontSize: 11, textAlign: 'center', paddingHorizontal: SPACING.sm },
  gridOverlay: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: SPACING.sm, paddingVertical: 4,
  },
  gridUsername: { color: colors.text, fontSize: 11, fontWeight: '600' },
  emptyText: { color: colors.textTertiary, fontSize: 14, textAlign: 'center', marginTop: SPACING.xxl },
});
