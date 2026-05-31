import {
  View, Text, StyleSheet, TextInput,
  FlatList, TouchableOpacity, Image, ActivityIndicator,
} from 'react-native';
import { useState, useEffect } from 'react';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { COLORS, SPACING, RADIUS, GRADIENTS, SHADOWS } from '../../constants/theme';

type Post = {
  id: string; type: string; media_url: string;
  caption: string; created_at: string; user_id: string;
  profiles: { username: string; display_name: string };
};
type Profile = {
  id: string; username: string; display_name: string;
  avatar_url: string | null; badge_tier: string;
};

const GENRES = ['All','Rap','R&B','Pop','Rock','Jazz','Electronic','Gospel','Afrobeats','Lo-Fi','Soul'];

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
  const [searchQuery, setSearchQuery] = useState('');
  const [searchType, setSearchType] = useState<'posts' | 'accounts'>('posts');
  const [selectedGenre, setSelectedGenre] = useState('All');
  const [posts, setPosts] = useState<Post[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [trendingPosts, setTrendingPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);

  useEffect(() => { fetchTrending(); }, []);

  useEffect(() => {
    if (searchQuery.trim().length > 0) {
      const t = setTimeout(() => handleSearch(), 500);
      return () => clearTimeout(t);
    } else {
      setProfiles([]); setPosts([]);
    }
  }, [searchQuery, searchType]);

  async function fetchTrending() {
    const { data } = await supabase
      .from('posts')
      .select('*, profiles!posts_user_id_fkey (username, display_name)')
      .eq('is_public', true)
      .order('created_at', { ascending: false })
      .limit(20);
    if (data) setTrendingPosts(data as any);
    setLoading(false);
  }

  async function fetchByGenre(genre: string) {
    setLoading(true);
    setSelectedGenre(genre);
    if (genre === 'All') { await fetchTrending(); return; }
    const { data } = await supabase
      .from('post_tags')
      .select('post_id, posts!inner(id,type,media_url,caption,created_at,user_id,is_public,profiles!posts_user_id_fkey(username,display_name))')
      .eq('genre', genre.toLowerCase())
      .limit(20);
    if (data) {
      const formatted = data.map((item: any) => item.posts).filter((p: any) => p?.is_public);
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
        .select('*, profiles!posts_user_id_fkey (username, display_name)')
        .ilike('caption', `%${searchQuery}%`)
        .eq('is_public', true)
        .limit(20);
      if (data) setPosts(data as any);
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
          data={GENRES}
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
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={<Text style={styles.emptyText}>No posts found</Text>}
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.postRow} onPress={() => router.push(`/post/${item.id}`)}>
                {item.type === 'image' ? (
                  <Image source={{ uri: item.media_url }} style={styles.postThumb} />
                ) : (
                  <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.postThumb}>
                    <Ionicons name={item.type === 'audio' ? 'musical-notes' : 'videocam'} size={20} color={COLORS.primary} />
                  </LinearGradient>
                )}
                <View style={styles.postInfo}>
                  <Text style={styles.postCaption} numberOfLines={2}>{item.caption}</Text>
                  <Text style={styles.postUser}>@{item.profiles?.username}</Text>
                </View>
              </TouchableOpacity>
            )}
          />
        )
      ) : (
        <FlatList
          key="grid"
          data={trendingPosts}
          keyExtractor={item => item.id}
          numColumns={2}
          contentContainerStyle={styles.gridContent}
          ListEmptyComponent={<Text style={styles.emptyText}>No posts in this genre yet</Text>}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.gridItem} onPress={() => router.push(`/post/${item.id}`)}>
              {item.type === 'image' ? (
                <Image source={{ uri: item.media_url }} style={styles.gridImage} resizeMode="cover" />
              ) : (
                <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.gridImage}>
                  <Ionicons name={item.type === 'audio' ? 'musical-notes' : 'videocam'} size={32} color={COLORS.primary} />
                  <Text style={styles.gridCaption} numberOfLines={2}>{item.caption}</Text>
                </LinearGradient>
              )}
              <View style={styles.gridOverlay}>
                <Text style={styles.gridUsername} numberOfLines={1}>@{item.profiles?.username}</Text>
              </View>
            </TouchableOpacity>
          )}
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
    borderRadius: RADIUS.md, gap: SPACING.md,
    borderWidth: 1, borderColor: COLORS.border, overflow: 'hidden',
  },
  postThumb: { width: 64, height: 64, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.surface },
  postInfo: { flex: 1, paddingRight: SPACING.md },
  postCaption: { color: COLORS.text, fontSize: 14, fontWeight: '500' },
  postUser: { color: COLORS.textSecondary, fontSize: 12, marginTop: 2 },

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
