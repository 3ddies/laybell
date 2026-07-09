import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Image,
} from 'react-native';
import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { GridSkeleton } from '../components/Skeleton';

type Post = { id: string; type: string; media_url: string; caption: string; thumbnail_url?: string | null };

export default function PrivatePostsScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { t } = useTranslation();
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { fetchPosts(); }, []);

  async function fetchPosts() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }
    const { data } = await supabase
      .from('posts')
      .select('*')
      .eq('user_id', user.id)
      .eq('is_public', false)
      .order('created_at', { ascending: false });
    // Hide archived posts (archived_at set); absent pre-migration → no-op.
    if (data) setPosts(data.filter((p: any) => !p.archived_at));
    setLoading(false);
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('account.privatePosts')}</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <GridSkeleton columns={3} count={12} gap={0} padding={0} />
      ) : posts.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="lock-closed-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyText}>{t('privatePosts.empty')}</Text>
          <Text style={styles.emptySubtext}>{t('privatePosts.emptySub')}</Text>
        </View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false}>
          <View style={styles.postsGrid}>
            {posts.map((post) => (
              <TouchableOpacity key={post.id} style={styles.gridItem} onPress={() => router.push(`/post/${post.id}`)}>
                {post.type === 'image' || post.type === 'slideshow' || (post.type === 'video' && post.thumbnail_url) ? (
                  <Image
                    source={{ uri: post.type === 'image' ? post.media_url : (post.thumbnail_url || post.media_url) }}
                    style={styles.gridImage}
                    resizeMode="cover"
                  />
                ) : (
                  <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.gridPlaceholder}>
                    <Ionicons
                      name={post.type === 'audio' ? 'musical-notes' : 'videocam'}
                      size={28} color={colors.primary}
                    />
                  </LinearGradient>
                )}
                <View style={styles.gridBadge}>
                  <Ionicons name="lock-closed" size={10} color="#fff" />
                </View>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },

  postsGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  gridItem: { width: '33.33%', aspectRatio: 1, position: 'relative' },
  gridImage: { width: '100%', height: '100%' },
  gridPlaceholder: {
    width: '100%', height: '100%',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 0.5, borderColor: colors.border,
  },
  gridBadge: {
    position: 'absolute', top: 6, right: 6,
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, padding: SPACING.xxl },
  emptyText: { color: colors.text, fontSize: 16, fontWeight: '700' },
  emptySubtext: { color: colors.textSecondary, fontSize: 13, textAlign: 'center' },
});
