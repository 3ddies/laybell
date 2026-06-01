import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Image, ActivityIndicator,
} from 'react-native';
import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { COLORS, SPACING, RADIUS } from '../constants/theme';

type Post = { id: string; type: string; media_url: string; caption: string; thumbnail_url?: string | null };

export default function PrivatePostsScreen() {
  const router = useRouter();
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { fetchPosts(); }, []);

  async function fetchPosts() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }
    const { data } = await supabase
      .from('posts')
      .select('id, type, media_url, caption, thumbnail_url')
      .eq('user_id', user.id)
      .eq('is_public', false)
      .order('created_at', { ascending: false });
    if (data) setPosts(data);
    setLoading(false);
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={COLORS.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Private Posts</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.centered}><ActivityIndicator color={COLORS.primary} size="large" /></View>
      ) : posts.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="lock-closed-outline" size={40} color={COLORS.textTertiary} />
          <Text style={styles.emptyText}>No private posts</Text>
          <Text style={styles.emptySubtext}>Posts set to "Followers only" show up here</Text>
        </View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false}>
          <View style={styles.postsGrid}>
            {posts.map((post) => (
              <TouchableOpacity key={post.id} style={styles.gridItem} onPress={() => router.push(`/post/${post.id}`)}>
                {post.type === 'image' || (post.type === 'video' && post.thumbnail_url) ? (
                  <Image
                    source={{ uri: post.type === 'image' ? post.media_url : (post.thumbnail_url as string) }}
                    style={styles.gridImage}
                    resizeMode="cover"
                  />
                ) : (
                  <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.gridPlaceholder}>
                    <Ionicons
                      name={post.type === 'audio' ? 'musical-notes' : 'videocam'}
                      size={28} color={COLORS.primary}
                    />
                  </LinearGradient>
                )}
                <View style={styles.gridBadge}>
                  <Ionicons name="lock-closed" size={10} color={COLORS.text} />
                </View>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: COLORS.border,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: COLORS.text, fontSize: 18, fontWeight: '800' },

  postsGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  gridItem: { width: '33.33%', aspectRatio: 1, position: 'relative' },
  gridImage: { width: '100%', height: '100%' },
  gridPlaceholder: {
    width: '100%', height: '100%',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 0.5, borderColor: COLORS.border,
  },
  gridBadge: {
    position: 'absolute', top: 6, right: 6,
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: COLORS.primary,
    alignItems: 'center', justifyContent: 'center',
  },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, padding: SPACING.xxl },
  emptyText: { color: COLORS.text, fontSize: 16, fontWeight: '700' },
  emptySubtext: { color: COLORS.textSecondary, fontSize: 13, textAlign: 'center' },
});
