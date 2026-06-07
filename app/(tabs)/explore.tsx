import {
  View, Text, StyleSheet, TextInput,
  FlatList, TouchableOpacity, Image, ActivityIndicator,
} from 'react-native';
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { COLORS, SPACING, RADIUS, GRADIENTS, SHADOWS } from '../../constants/theme';
import ExploreGrid from '../../components/ExploreGrid';
import TrackRow from '../../components/TrackRow';
import { showPostOptions } from '../../lib/postActions';
import { useAudio } from '../../contexts/AudioContext';
import { GENRES as MUSIC_GENRES, GENRE_FILTERS, CONTENT_TAGS, isAudioPost } from '../../lib/genres';
import {
  buildAffinityProfile, loadSeenPostIds, recordSeenPostIds, scorePost,
  sortGenresByAffinity, EMPTY_PROFILE, type UserAffinityProfile,
} from '../../lib/feedScorer';

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
  avatar_url: string | null; badge_tier: string;
};


function getBadgeColor(tier: string) {
  switch (tier) {
    case 'gold': return COLORS.gold;
    case 'silver': return COLORS.silver;
    case 'bronze': return COLORS.bronze;
    case 'diamond': return COLORS.diamond;
    default: return COLORS.border;
  }
}

export default function ExploreScreen() {
  const router = useRouter();
  const { play, currentTrack, isPlaying, expand } = useAudio();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchType, setSearchType] = useState<'posts' | 'accounts'>('posts');
  const [selectedGenre, setSelectedGenre] = useState('All');
  const [posts, setPosts] = useState<Post[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [trendingPosts, setTrendingPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [seenPostIds, setSeenPostIds] = useState<Set<string>>(new Set());
  // Genre rail ordered by user affinity (Meme floored near the front), with the
  // content-type tags pinned to the end — mirrors the Music Discover bar.
  const [orderedGenres, setOrderedGenres] = useState<string[]>([...GENRE_FILTERS, ...CONTENT_TAGS]);
  const affinityProfile = useRef<UserAffinityProfile>(EMPTY_PROFILE);
  const followingSetRef = useRef<Set<string>>(new Set());

  useEffect(() => { setup(); }, []);

  useEffect(() => {
    if (searchQuery.trim().length > 0) {
      const t = setTimeout(() => handleSearch(), 500);
      return () => clearTimeout(t);
    } else {
      setProfiles([]); setPosts([]);
    }
  }, [searchQuery, searchType]);

  async function setup() {
    // Auth + seen-posts (AsyncStorage) in parallel — both fast
    const [{ data: { user } }, seen] = await Promise.all([
      supabase.auth.getUser(),
      loadSeenPostIds(),
    ]);
    const userId = user?.id ?? null;
    if (userId) setCurrentUserId(userId);
    setSeenPostIds(seen);

    // Affinity profile (AsyncStorage cache) + following list in parallel
    if (userId) {
      const [profile, followingResult] = await Promise.all([
        buildAffinityProfile(userId),
        supabase.from('follows').select('following_id').eq('follower_id', userId),
      ]);
      affinityProfile.current = profile;
      followingSetRef.current = new Set(
        (followingResult.data ?? []).map((f: any) => f.following_id),
      );
    }

    // Reorder the genre rail by affinity (Meme floored near the front), keeping
    // "All" first and the Podcasts/Audiobooks tags pinned at the end.
    setOrderedGenres(['All', ...sortGenresByAffinity([...MUSIC_GENRES], affinityProfile.current), ...CONTENT_TAGS]);

    await fetchTrending(seen);
  }

  // `overrideSeen` is passed from setup() before the seenPostIds state update applies.
  async function fetchTrending(overrideSeen?: Set<string>) {
    const { data } = await supabase
      .from('posts')
      .select('*, profiles!posts_user_id_fkey (username, display_name), likes(count), comments(count)')
      .eq('is_public', true)
      .order('created_at', { ascending: false })
      .limit(30);
    if (data) {
      const seen = overrideSeen ?? seenPostIds;
      const now  = Date.now();
      const sorted = [...data].sort((a: any, b: any) =>
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
      .select('*, profiles!posts_user_id_fkey (username, display_name), likes(count), comments(count)')
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
      const sorted = [...data].sort((a: any, b: any) =>
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
    setRefreshing(false);
  }

  async function handleSearch() {
    if (!searchQuery.trim()) return;
    setSearching(true);

    if (searchType === 'accounts') {
      const { data } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, badge_tier')
        .or(`username.ilike.%${searchQuery}%,display_name.ilike.%${searchQuery}%`)
        .limit(20);
      if (data) setProfiles(data);
    } else {
      // Find profiles whose name matches — use their IDs to also pull their posts
      const { data: matchedProfiles } = await supabase
        .from('profiles')
        .select('id')
        .or(`username.ilike.%${searchQuery}%,display_name.ilike.%${searchQuery}%`)
        .limit(15);

      const authorIds = (matchedProfiles ?? []).map((p: any) => p.id);

      let query = supabase
        .from('posts')
        .select(`
          *,
          profiles!posts_user_id_fkey (username, display_name, avatar_url),
          likes(count),
          comments(count)
        `)
        .eq('is_public', true)
        .limit(30);

      if (authorIds.length > 0) {
        // Match caption OR posts from matching authors
        query = query.or(`caption.ilike.%${searchQuery}%,user_id.in.(${authorIds.join(',')})`);
      } else {
        query = query.ilike('caption', `%${searchQuery}%`);
      }

      const { data } = await query;

      if (data) {
        // Sort by personalized engagement score; no seen-penalty in search
        // (user is actively looking, so previously-seen results are still relevant).
        const now = Date.now();
        const sorted = [...data].sort((a: any, b: any) =>
          scorePost(b, affinityProfile.current, followingSetRef.current, new Set(), now) -
          scorePost(a, affinityProfile.current, followingSetRef.current, new Set(), now),
        );
        setPosts(sorted as any);
      }
    }

    setSearching(false);
  }

  const isSearching = searchQuery.trim().length > 0;

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Explore</Text>
      </View>

      {/* Search */}
      <View style={styles.searchRow}>
        <View style={styles.searchBar}>
          <Ionicons name="search-outline" size={18} color={COLORS.textTertiary} style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            placeholder="Artists, songs, captions..."
            placeholderTextColor={COLORS.textTertiary}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCapitalize="none"
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')}>
              <Ionicons name="close-circle" size={18} color={COLORS.textTertiary} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Search type toggle */}
      {isSearching && (
        <View style={styles.toggleRow}>
          {(['posts', 'accounts'] as const).map(type => (
            <TouchableOpacity
              key={type}
              style={[styles.toggleBtn, searchType === type && styles.toggleBtnActive]}
              onPress={() => setSearchType(type)}
            >
              <Text style={[styles.toggleText, searchType === type && styles.toggleTextActive]}>
                {type.charAt(0).toUpperCase() + type.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
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

      {/* Content */}
      {loading || searching ? (
        <View style={styles.centered}>
          <ActivityIndicator color={COLORS.primary} />
        </View>
      ) : isSearching ? (
        searchType === 'accounts' ? (
          <FlatList
            key="accounts"
            data={profiles}
            keyExtractor={item => item.id}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={<Text style={styles.emptyText}>No accounts found</Text>}
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.accountRow} onPress={() => router.push(`/profile/${item.id}`)}>
                {item.avatar_url ? (
                  <Image source={{ uri: item.avatar_url }} style={[styles.accountAvatar, { borderColor: getBadgeColor(item.badge_tier) }]} />
                ) : (
                  <LinearGradient colors={GRADIENTS.primary} style={[styles.accountAvatar, { borderColor: getBadgeColor(item.badge_tier) }]}>
                    <Text style={styles.accountAvatarText}>{item.display_name?.charAt(0).toUpperCase()}</Text>
                  </LinearGradient>
                )}
                <View style={styles.accountInfo}>
                  <Text style={styles.accountName}>{item.display_name}</Text>
                  <Text style={styles.accountUsername}>@{item.username}</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={COLORS.textTertiary} />
              </TouchableOpacity>
            )}
          />
        ) : (
          <FlatList
            key="posts"
            data={posts}
            keyExtractor={item => item.id}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={<Text style={styles.emptyText}>No posts found</Text>}
            renderItem={({ item }) => isAudioPost(item.type) ? (
              <TrackRow
                caption={item.caption}
                artist={item.profiles?.display_name}
                username={item.profiles?.username}
                streams={item.stream_count}
                cover={item.cover_url}
                avatarUrl={item.profiles?.avatar_url}
                isPlaying={currentTrack?.id === item.id && isPlaying}
                onPlay={() => play({ id: item.id, uri: item.media_url, caption: item.caption, artist: item.profiles?.display_name, cover: item.cover_url })}
                onCoverPress={() => { play({ id: item.id, uri: item.media_url, caption: item.caption, artist: item.profiles?.display_name, cover: item.cover_url }); expand(); }}
                onAvatarPress={() => router.push(`/profile/${item.user_id}`)}
                onOptions={() => showPostOptions({
                  postId: item.id,
                  isOwn: item.user_id === currentUserId,
                  onEdit: () => router.push(`/edit-post/${item.id}`),
                  onDeleted: () => setPosts(prev => prev.filter(p => p.id !== item.id)),
                })}
              />
            ) : (
              <TouchableOpacity
                style={styles.postRow}
                onPress={() => router.push(item.type === 'video' ? `/reel/${item.id}` : `/post/${item.id}`)}
                onLongPress={() => showPostOptions({
                  postId: item.id,
                  isOwn: item.user_id === currentUserId,
                  onEdit: () => router.push(`/edit-post/${item.id}`),
                  onDeleted: () => setPosts(prev => prev.filter(p => p.id !== item.id)),
                })}
              >
                {item.type === 'image' || (item.type === 'video' && item.thumbnail_url) ? (
                  <Image source={{ uri: item.type === 'image' ? item.media_url : (item.thumbnail_url as string) }} style={styles.postThumb} />
                ) : (
                  <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.postThumb}>
                    <Ionicons name={item.type === 'audio' ? 'musical-notes' : 'videocam'} size={20} color={COLORS.primary} />
                  </LinearGradient>
                )}
                <View style={styles.postInfo}>
                  <Text style={styles.postCaption} numberOfLines={2}>{item.caption || 'Audio Track'}</Text>
                  <View style={styles.postMeta}>
                    <Text style={styles.postUser}>@{item.profiles?.username}</Text>
                    {((item.likes?.[0]?.count || 0) + (item.comments?.[0]?.count || 0)) > 0 && (
                      <View style={styles.postStats}>
                        <Ionicons name="heart" size={11} color={COLORS.like} />
                        <Text style={styles.postStatText}>{item.likes?.[0]?.count || 0}</Text>
                        <Ionicons name="chatbubble" size={11} color={COLORS.textTertiary} />
                        <Text style={styles.postStatText}>{item.comments?.[0]?.count || 0}</Text>
                      </View>
                    )}
                  </View>
                </View>
                <TouchableOpacity
                  style={styles.postTypeTag}
                  onPress={() => showPostOptions({
                    postId: item.id,
                    isOwn: item.user_id === currentUserId,
                    onEdit: () => router.push(`/edit-post/${item.id}`),
                    onDeleted: () => setPosts(prev => prev.filter(p => p.id !== item.id)),
                  })}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="ellipsis-horizontal" size={16} color={COLORS.textSecondary} />
                </TouchableOpacity>
              </TouchableOpacity>
            )}
          />
        )
      ) : (
        <ExploreGrid
          posts={trendingPosts}
          refreshing={refreshing}
          onRefresh={onRefresh}
          songTiles={selectedGenre !== 'All'}
          currentUserId={currentUserId}
          onPostDeleted={(id) => {
            setTrendingPosts(prev => prev.filter(p => p.id !== id));
            setPosts(prev => prev.filter(p => p.id !== id));
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: { paddingHorizontal: SPACING.md, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.sm },
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

  toggleRow: { flexDirection: 'row', paddingHorizontal: SPACING.md, gap: SPACING.sm, marginBottom: SPACING.sm },
  toggleBtn: {
    paddingVertical: SPACING.xs + 2, paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.full, borderWidth: 1, borderColor: COLORS.border,
  },
  toggleBtnActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  toggleText: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '500' },
  toggleTextActive: { color: COLORS.text, fontWeight: '700' },

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
    backgroundColor: COLORS.surfaceLight,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.full,
  },
  genrePillGradient: {
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md + 2,
    borderRadius: RADIUS.full,
  },
  genreText: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '500' },
  genreTextActive: { color: COLORS.text, fontSize: 13, fontWeight: '700' },

  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  listContent: { padding: SPACING.md, gap: SPACING.sm },

  accountRow: {
    flexDirection: 'row', alignItems: 'center',
    padding: SPACING.md,
    backgroundColor: COLORS.surfaceLight,
    borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: COLORS.border, gap: SPACING.md,
  },
  accountAvatar: {
    width: 48, height: 48, borderRadius: RADIUS.full,
    backgroundColor: COLORS.primary,
    alignItems: 'center', justifyContent: 'center', borderWidth: 2,
  },
  accountAvatarText: { color: COLORS.text, fontSize: 18, fontWeight: '700' },
  accountInfo: { flex: 1 },
  accountName: { color: COLORS.text, fontSize: 15, fontWeight: '700' },
  accountUsername: { color: COLORS.textSecondary, fontSize: 13, marginTop: 2 },

  postRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: COLORS.surfaceLight,
    borderRadius: RADIUS.md, gap: SPACING.md, paddingRight: SPACING.md,
    borderWidth: 1, borderColor: COLORS.border, overflow: 'hidden',
  },
  postThumb: { width: 64, height: 64, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.surface },
  postInfo: { flex: 1, paddingRight: SPACING.xs },
  postCaption: { color: COLORS.text, fontSize: 14, fontWeight: '500' },
  postMeta: { flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: SPACING.sm },
  postUser: { color: COLORS.textSecondary, fontSize: 12 },
  postStats: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  postStatText: { color: COLORS.textTertiary, fontSize: 11 },
  postTypeTag: {
    width: 28, height: 28, borderRadius: RADIUS.full,
    backgroundColor: COLORS.primary + '18',
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },

  gridContent: { padding: SPACING.xs, gap: SPACING.xs },
  gridItem: {
    flex: 1, margin: SPACING.xs, aspectRatio: 1,
    borderRadius: RADIUS.md, overflow: 'hidden',
    backgroundColor: COLORS.surfaceLight,
  },
  gridImage: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm },
  gridCaption: { color: COLORS.textSecondary, fontSize: 11, textAlign: 'center', paddingHorizontal: SPACING.sm },
  gridOverlay: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: SPACING.sm, paddingVertical: 4,
  },
  gridUsername: { color: COLORS.text, fontSize: 11, fontWeight: '600' },
  emptyText: { color: COLORS.textTertiary, fontSize: 14, textAlign: 'center', marginTop: SPACING.xxl },
});
