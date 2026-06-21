import {
  View, Text, StyleSheet, FlatList,
  TouchableOpacity, ActivityIndicator, Image, RefreshControl,
} from 'react-native';
import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { timeAgo } from '../lib/timeAgo';
import { isAudioPost } from '../lib/genres';
import { maskHiddenProfile, HIDDEN_NAME } from '../lib/hiddenProfile';
import VideoThumb from '../components/VideoThumb';

type RepostRow = {
  user_id: string;
  created_at: string;
  posts: {
    id: string; type: string; media_url: string; caption: string | null;
    thumbnail_url: string | null; cover_url: string | null; user_id: string;
  } | null;
  reposter: { id: string; username: string; display_name: string; avatar_url: string | null } | null;
};

export default function RepostsScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const router = useRouter();
  const [items, setItems] = useState<RepostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => { fetchReposts(); }, []);

  async function fetchReposts() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); setRefreshing(false); return; }

    // Reposts of MY posts (filter on the embedded post's owner via inner join).
    const { data } = await supabase
      .from('reposts')
      .select('user_id, created_at, posts!inner(id, type, media_url, caption, thumbnail_url, cover_url, user_id)')
      .eq('posts.user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(100);

    const rows = (data ?? []) as any[];
    const reposterIds = [...new Set(rows.map(r => r.user_id))];
    let profileMap: Record<string, any> = {};
    if (reposterIds.length) {
      const { data: profiles } = await supabase
        .from('profiles').select('id, username, display_name, avatar_url, hidden').in('id', reposterIds);
      // Reposters who have since hidden their account read as "Hidden account".
      profileMap = Object.fromEntries((profiles ?? []).map((p: any) => [p.id, maskHiddenProfile(p)]));
    }

    setItems(rows.map(r => ({ ...r, reposter: profileMap[r.user_id] ?? null })));
    setLoading(false);
    setRefreshing(false);
  }

  function openPost(post: RepostRow['posts']) {
    if (!post) return;
    router.push(post.type === 'video' ? `/reel/${post.id}` : `/post/${post.id}`);
  }

  function Thumb({ post }: { post: RepostRow['posts'] }) {
    if (!post) return <View style={styles.thumb} />;
    const cover = post.cover_url ?? post.thumbnail_url ?? (post.type === 'image' ? post.media_url : null);
    if (post.type === 'video') {
      return <VideoThumb thumbnailUrl={cover} mediaUrl={post.media_url} style={styles.thumb} />;
    }
    if (cover) return <Image source={{ uri: cover }} style={styles.thumb} />;
    return (
      <LinearGradient colors={['#1C0E06', '#120A04']} style={[styles.thumb, styles.thumbFallback]}>
        <Ionicons name={isAudioPost(post.type) ? 'musical-notes' : 'image'} size={20} color={colors.primary} />
      </LinearGradient>
    );
  }

  if (loading) {
    return <View style={styles.loadingContainer}><ActivityIndicator color={colors.primary} size="large" /></View>;
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('account.reposts')}</Text>
        <View style={{ width: 40 }} />
      </View>

      <FlatList
        data={items}
        keyExtractor={(item, i) => `${item.user_id}-${item.posts?.id}-${i}`}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchReposts(); }} tintColor={colors.primary} />
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <LinearGradient colors={[colors.primary + '24', colors.background]} style={styles.emptyIcon}>
              <Ionicons name="repeat" size={36} color={colors.primary} />
            </LinearGradient>
            <Text style={styles.emptyTitle}>{t('reposts.emptyTitle')}</Text>
            <Text style={styles.emptySubtitle}>{t('reposts.emptySubtitle')}</Text>
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <TouchableOpacity style={styles.userPart} onPress={() => router.push(`/profile/${item.user_id}`)}>
              {item.reposter?.avatar_url ? (
                <Image source={{ uri: item.reposter.avatar_url }} style={styles.avatar} />
              ) : (
                <LinearGradient colors={GRADIENTS.primary} style={styles.avatar}>
                  {item.reposter?.display_name === HIDDEN_NAME ? (
                    <Ionicons name="person" size={22} color="#fff" />
                  ) : (
                    <Text style={styles.avatarText}>{item.reposter?.display_name?.charAt(0).toUpperCase()}</Text>
                  )}
                </LinearGradient>
              )}
              <View style={styles.userInfo}>
                <Text style={styles.name} numberOfLines={1}>{item.reposter?.display_name ?? t('reposts.someone')}</Text>
                <Text style={styles.sub} numberOfLines={1}>
                  {t('reposts.repostedYourPost')} · {timeAgo(item.created_at)}
                </Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => openPost(item.posts)}>
              <Thumb post={item.posts} />
            </TouchableOpacity>
          </View>
        )}
      />
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  loadingContainer: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },

  list: { flex: 1 },
  listContent: { padding: SPACING.md, gap: SPACING.sm, flexGrow: 1 },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    backgroundColor: colors.surfaceLight,
    borderRadius: RADIUS.md, borderWidth: 1, borderColor: colors.border,
    padding: SPACING.sm + 2,
  },
  userPart: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  avatar: { width: 46, height: 46, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.text, fontSize: 18, fontWeight: '700' },
  userInfo: { flex: 1 },
  name: { color: colors.text, fontSize: 15, fontWeight: '700' },
  sub: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },

  thumb: { width: 50, height: 50, borderRadius: RADIUS.sm, backgroundColor: colors.surfaceElevated },
  thumbFallback: { alignItems: 'center', justifyContent: 'center' },

  emptyContainer: { alignItems: 'center', paddingTop: SPACING.xxl * 2, gap: SPACING.md, paddingHorizontal: SPACING.xl },
  emptyIcon: { width: 90, height: 90, borderRadius: RADIUS.xl + 8, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { color: colors.text, fontSize: 20, fontWeight: '800' },
  emptySubtitle: { color: colors.textSecondary, fontSize: 14, textAlign: 'center', lineHeight: 22 },
});
