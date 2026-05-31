import {
  View,
  Text,
  StyleSheet,
  TextInput,
  FlatList,
  TouchableOpacity,
  Image,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { COLORS, SPACING, RADIUS } from '../../constants/theme';

type Post = {
  id: string;
  type: string;
  media_url: string;
  caption: string;
  created_at: string;
  user_id: string;
  profiles: {
    username: string;
    display_name: string;
  };
};

type Profile = {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  badge_tier: string;
};

const GENRES = [
  'All', 'Rap', 'R&B', 'Pop', 'Rock', 'Jazz',
  'Electronic', 'Gospel', 'Afrobeats', 'Lo-Fi', 'Soul'
];

export default function ExploreScreen() {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchType, setSearchType] = useState<'posts' | 'accounts'>('posts');
  const [selectedGenre, setSelectedGenre] = useState('All');
  const [posts, setPosts] = useState<Post[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [trendingPosts, setTrendingPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    fetchTrending();
  }, []);

  useEffect(() => {
    if (searchQuery.trim().length > 0) {
      const timeout = setTimeout(() => handleSearch(), 500);
      return () => clearTimeout(timeout);
    } else {
      setProfiles([]);
      setPosts([]);
    }
  }, [searchQuery, searchType]);

  async function fetchTrending() {
    const { data } = await supabase
      .from('posts')
      .select(`
        *,
        profiles!posts_user_id_fkey (username, display_name)
      `)
      .eq('is_public', true)
      .order('created_at', { ascending: false })
      .limit(20);

    if (data) setTrendingPosts(data as any);
    setLoading(false);
  }

  async function fetchByGenre(genre: string) {
    setLoading(true);
    setSelectedGenre(genre);

    if (genre === 'All') {
      await fetchTrending();
      return;
    }

    const { data } = await supabase
      .from('post_tags')
      .select(`
        post_id,
        posts!inner (
          id, type, media_url, caption, created_at, user_id, is_public,
          profiles!posts_user_id_fkey (username, display_name)
        )
      `)
      .eq('genre', genre.toLowerCase())
      .limit(20);

    if (data) {
      const formatted = data
        .map((item: any) => item.posts)
        .filter((p: any) => p?.is_public);
      setTrendingPosts(formatted);
    }

    setLoading(false);
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
      const { data } = await supabase
        .from('posts')
        .select(`
          *,
          profiles!posts_user_id_fkey (username, display_name)
        `)
        .ilike('caption', `%${searchQuery}%`)
        .eq('is_public', true)
        .limit(20);

      if (data) setPosts(data as any);
    }

    setSearching(false);
  }

  function getBadgeColor(tier: string) {
    switch (tier) {
      case 'gold': return COLORS.gold;
      case 'silver': return COLORS.silver;
      case 'bronze': return COLORS.bronze;
      case 'diamond': return '#A5F3FC';
      default: return COLORS.border;
    }
  }

  const isSearching = searchQuery.trim().length > 0;

  return (
    <View style={styles.container}>

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Explore</Text>
      </View>

      {/* Search Bar */}
      <View style={styles.searchContainer}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search artists, songs, captions..."
          placeholderTextColor={COLORS.textTertiary}
          value={searchQuery}
          onChangeText={setSearchQuery}
          autoCapitalize="none"
        />
      </View>

      {/* Search Type Toggle */}
      {isSearching && (
        <View style={styles.searchToggle}>
          <TouchableOpacity
            style={[styles.toggleBtn, searchType === 'posts' && styles.toggleBtnActive]}
            onPress={() => setSearchType('posts')}
          >
            <Text style={[styles.toggleText, searchType === 'posts' && styles.toggleTextActive]}>
              Posts
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.toggleBtn, searchType === 'accounts' && styles.toggleBtnActive]}
            onPress={() => setSearchType('accounts')}
          >
            <Text style={[styles.toggleText, searchType === 'accounts' && styles.toggleTextActive]}>
              Accounts
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Genre Pills */}
      {!isSearching && (
        <FlatList
          horizontal
          data={GENRES}
          keyExtractor={(item) => item}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.genreList}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[
                styles.genrePill,
                selectedGenre === item && styles.genrePillActive,
              ]}
              onPress={() => fetchByGenre(item)}
            >
              <Text style={[
                styles.genreText,
                selectedGenre === item && styles.genreTextActive,
              ]}>
                {item}
              </Text>
            </TouchableOpacity>
          )}
        />
      )}

      {/* Content */}
      {loading || searching ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator color={COLORS.primary} />
        </View>
      ) : isSearching ? (
        searchType === 'accounts' ? (
          <FlatList
            key="accounts"
            data={profiles}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={
              <Text style={styles.emptyText}>No accounts found</Text>
            }
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.profileRow}
                onPress={() => router.push(`/profile/${item.id}`)}
              >
                {item.avatar_url ? (
                  <Image
                    source={{ uri: item.avatar_url }}
                    style={[styles.profileAvatar, { borderColor: getBadgeColor(item.badge_tier) }]}
                  />
                ) : (
                  <View style={[styles.profileAvatar, { borderColor: getBadgeColor(item.badge_tier) }]}>
                    <Text style={styles.profileAvatarText}>
                      {item.display_name?.charAt(0).toUpperCase()}
                    </Text>
                  </View>
                )}
                <View style={styles.profileInfo}>
                  <Text style={styles.profileDisplayName}>
                    {item.display_name}
                  </Text>
                  <Text style={styles.profileUsername}>
                    {'@'}{item.username}
                  </Text>
                </View>
              </TouchableOpacity>
            )}
          />
        ) : (
          <FlatList
            key="posts"
            data={posts}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={
              <Text style={styles.emptyText}>No posts found</Text>
            }
            renderItem={({ item }) => (
              <View style={styles.searchPostRow}>
                {item.type === 'image' ? (
                  <Image
                    source={{ uri: item.media_url }}
                    style={styles.searchPostThumb}
                  />
                ) : (
                  <View style={styles.searchPostThumbPlaceholder}>
                    <Text>{item.type === 'audio' ? '🎵' : '🎬'}</Text>
                  </View>
                )}
                <View style={styles.searchPostInfo}>
                  <Text style={styles.searchPostCaption} numberOfLines={2}>
                    {item.caption}
                  </Text>
                  <Text style={styles.searchPostUser}>
                    {'@'}{item.profiles?.username}
                  </Text>
                </View>
              </View>
            )}
          />
        )
      ) : (
        <FlatList
          key="grid"
          data={trendingPosts}
          keyExtractor={(item) => item.id}
          numColumns={2}
          contentContainerStyle={styles.gridContent}
          ListEmptyComponent={
            <Text style={styles.emptyText}>No posts yet in this genre</Text>
          }
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.gridItem} onPress={() => router.push(`/post/${item.id}`)}>
              {item.type === 'image' ? (
                <Image
                  source={{ uri: item.media_url }}
                  style={styles.gridImage}
                  resizeMode="cover"
                />
              ) : (
                <View style={styles.gridPlaceholder}>
                  <Text style={styles.gridPlaceholderIcon}>
                    {item.type === 'audio' ? '🎵' : '🎬'}
                  </Text>
                  <Text style={styles.gridPlaceholderCaption} numberOfLines={2}>
                    {item.caption}
                  </Text>
                </View>
              )}
              <View style={styles.gridOverlay}>
                <Text style={styles.gridUsername} numberOfLines={1}>
                  {'@'}{item.profiles?.username}
                </Text>
              </View>
            </TouchableOpacity>
          )}
        />
      )}

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  header: {
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.xxl + SPACING.sm,
    paddingBottom: SPACING.sm,
  },
  headerTitle: {
    color: COLORS.text,
    fontSize: 24,
    fontWeight: 'bold',
  },
  searchContainer: {
    paddingHorizontal: SPACING.md,
    paddingBottom: SPACING.sm,
  },
  searchInput: {
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    color: COLORS.text,
    fontSize: 15,
  },
  searchToggle: {
    flexDirection: 'row',
    paddingHorizontal: SPACING.md,
    gap: SPACING.sm,
    marginBottom: SPACING.sm,
  },
  toggleBtn: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.full,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  toggleBtnActive: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  toggleText: {
    color: COLORS.textSecondary,
    fontSize: 13,
    fontWeight: '500',
  },
  toggleTextActive: {
    color: COLORS.text,
    fontWeight: '700',
  },
  genreList: {
    paddingHorizontal: SPACING.md,
    paddingBottom: SPACING.sm,
    gap: SPACING.sm,
  },
  genrePill: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.full,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  genrePillActive: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  genreText: {
    color: COLORS.textSecondary,
    fontSize: 13,
    fontWeight: '500',
  },
  genreTextActive: {
    color: COLORS.text,
    fontWeight: '700',
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listContent: {
    padding: SPACING.md,
    gap: SPACING.sm,
  },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: SPACING.md,
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md,
    gap: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  profileAvatar: {
    width: 48,
    height: 48,
    borderRadius: RADIUS.full,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
  profileAvatarText: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: 'bold',
  },
  profileInfo: {
    flex: 1,
  },
  profileDisplayName: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '700',
  },
  profileUsername: {
    color: COLORS.textSecondary,
    fontSize: 13,
    marginTop: 2,
  },
  searchPostRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: SPACING.sm,
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md,
    gap: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  searchPostThumb: {
    width: 56,
    height: 56,
    borderRadius: RADIUS.sm,
    backgroundColor: COLORS.surfaceLight,
  },
  searchPostThumbPlaceholder: {
    width: 56,
    height: 56,
    borderRadius: RADIUS.sm,
    backgroundColor: COLORS.surfaceLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchPostInfo: {
    flex: 1,
  },
  searchPostCaption: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '500',
  },
  searchPostUser: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  gridContent: {
    padding: SPACING.xs,
    gap: SPACING.xs,
  },
  gridItem: {
    flex: 1,
    margin: SPACING.xs,
    aspectRatio: 1,
    borderRadius: RADIUS.md,
    overflow: 'hidden',
    backgroundColor: COLORS.surface,
  },
  gridImage: {
    width: '100%',
    height: '100%',
  },
  gridPlaceholder: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.sm,
    gap: SPACING.xs,
  },
  gridPlaceholderIcon: {
    fontSize: 32,
  },
  gridPlaceholderCaption: {
    color: COLORS.textSecondary,
    fontSize: 11,
    textAlign: 'center',
  },
  gridOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
    padding: SPACING.xs,
  },
  gridUsername: {
    color: COLORS.text,
    fontSize: 11,
    fontWeight: '600',
  },
  emptyText: {
    color: COLORS.textTertiary,
    fontSize: 14,
    textAlign: 'center',
    marginTop: SPACING.xxl,
  },
});