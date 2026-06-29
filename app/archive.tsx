import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, Image, Alert, RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { restorePostById, deletePostById } from '../lib/postActions';
import { fetchArchivedStories, restoreStory, deleteStory, type Story } from '../lib/stories';
import { isAudioPost } from '../lib/genres';
import VideoThumb from '../components/VideoThumb';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { GridSkeleton } from '../components/Skeleton';

type Tab = 'posts' | 'stories';

export default function ArchiveScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('posts');
  const [posts, setPosts] = useState<any[]>([]);
  const [stories, setStories] = useState<Story[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); setRefreshing(false); return; }
    const [postsRes, archivedStories] = await Promise.all([
      // Own posts with archived_at set (newest archived first). Returns nothing
      // until the posts.archived_at column is migrated — degrades to empty.
      supabase
        .from('posts')
        .select('*')
        .eq('user_id', user.id)
        .not('archived_at', 'is', null)
        .order('archived_at', { ascending: false }),
      fetchArchivedStories(user.id),
    ]);
    setPosts(postsRes.data ?? []);
    setStories(archivedStories);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  function onPostPress(post: any) {
    Alert.alert(
      t('archive.postTitle'),
      t('archive.postBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('archive.restore'),
          onPress: async () => {
            const ok = await restorePostById(post.id);
            if (ok) setPosts(prev => prev.filter(p => p.id !== post.id));
            else Alert.alert(t('archive.errorTitle'), t('archive.restorePostError'));
          },
        },
        {
          text: t('archive.deletePermanently'),
          style: 'destructive',
          onPress: async () => {
            const ok = await deletePostById(post.id);
            if (ok) setPosts(prev => prev.filter(p => p.id !== post.id));
            else Alert.alert(t('archive.errorTitle'), t('archive.deletePostError'));
          },
        },
      ],
    );
  }

  function onStoryPress(story: Story) {
    Alert.alert(
      t('archive.storyTitle'),
      t('archive.storyBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('archive.restore'),
          onPress: async () => {
            const ok = await restoreStory(story.id);
            if (ok) setStories(prev => prev.filter(s => s.id !== story.id));
            else Alert.alert(t('archive.errorTitle'), t('archive.restoreStoryError'));
          },
        },
        {
          text: t('archive.deletePermanently'),
          style: 'destructive',
          onPress: async () => {
            await deleteStory(story.id);
            setStories(prev => prev.filter(s => s.id !== story.id));
          },
        },
      ],
    );
  }

  // Tap an archived story → replay it like the original (read-only: the viewer
  // count shows, but not the individual viewers). Restore/delete moves to a
  // long-press (onStoryPress). The owner is the current user, so the story
  // viewer builds its header from myProfile and skips recording a fresh view.
  function playArchivedStory(story: Story) {
    router.push({
      pathname: '/story/[userId]',
      params: { userId: story.user_id, archived: '1', story: JSON.stringify(story) },
    });
  }

  const isEmpty = tab === 'posts' ? posts.length === 0 : stories.length === 0;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('account.archive')}</Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Posts / Stories segments */}
      <View style={styles.segments}>
        {(['posts', 'stories'] as const).map(seg => (
          <TouchableOpacity
            key={seg}
            style={[styles.segment, tab === seg && styles.segmentActive]}
            onPress={() => setTab(seg)}
          >
            <Ionicons
              name={seg === 'posts' ? 'grid-outline' : 'aperture-outline'}
              size={15}
              color={tab === seg ? colors.text : colors.textSecondary}
            />
            <Text style={[styles.segmentText, tab === seg && styles.segmentTextActive]}>
              {seg === 'posts' ? t('archive.tabPosts') : t('archive.tabStories')}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={{ flex: 1 }}>
          <Text style={styles.hint}>
            {tab === 'posts' ? t('archive.hintPosts') : t('archive.hintStories')}
          </Text>
          <GridSkeleton columns={3} count={12} gap={1} padding={0} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />
          }
        >
          <Text style={styles.hint}>
            {tab === 'posts' ? t('archive.hintPosts') : t('archive.hintStories')}
          </Text>

          {isEmpty ? (
            <View style={styles.empty}>
              <Ionicons
                name={tab === 'posts' ? 'archive-outline' : 'aperture-outline'}
                size={44}
                color={colors.textTertiary}
              />
              <Text style={styles.emptyTitle}>
                {tab === 'posts' ? t('archive.emptyPosts') : t('archive.emptyStories')}
              </Text>
            </View>
          ) : (
            <View style={styles.grid}>
              {tab === 'posts'
                ? posts.map(post => (
                    <TouchableOpacity key={post.id} style={styles.cell} onPress={() => onPostPress(post)} activeOpacity={0.85}>
                      {post.type === 'slideshow' ? (
                        <Image source={{ uri: post.thumbnail_url || post.media_url }} style={styles.cellMedia} resizeMode="cover" />
                      ) : post.type === 'video' ? (
                        <VideoThumb thumbnailUrl={post.thumbnail_url} mediaUrl={post.media_url} style={styles.cellMedia} />
                      ) : post.type === 'image' ? (
                        <Image source={{ uri: post.media_url }} style={styles.cellMedia} resizeMode="cover" />
                      ) : isAudioPost(post.type) && post.cover_url ? (
                        <Image source={{ uri: post.cover_url }} style={styles.cellMedia} resizeMode="cover" />
                      ) : (
                        <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.cellPlaceholder}>
                          <Ionicons name={isAudioPost(post.type) ? 'musical-notes' : 'videocam'} size={26} color={colors.primary} />
                        </LinearGradient>
                      )}
                      <View style={styles.typeBadge}>
                        <Ionicons
                          name={post.type === 'slideshow' ? 'copy' : post.type === 'video' ? 'videocam' : isAudioPost(post.type) ? 'musical-notes' : 'image'}
                          size={11} color="#fff"
                        />
                      </View>
                    </TouchableOpacity>
                  ))
                : stories.map(story => (
                    <TouchableOpacity key={story.id} style={styles.cell} onPress={() => playArchivedStory(story)} onLongPress={() => onStoryPress(story)} activeOpacity={0.85}>
                      {story.media_type === 'video' && !story.thumbnail_url ? (
                        <VideoThumb thumbnailUrl={story.thumbnail_url} mediaUrl={story.media_url} style={styles.cellMedia} />
                      ) : (
                        <Image source={{ uri: story.thumbnail_url ?? story.media_url }} style={styles.cellMedia} resizeMode="cover" />
                      )}
                      {story.media_type === 'video' && (
                        <View style={styles.typeBadge}><Ionicons name="play" size={11} color="#fff" /></View>
                      )}
                    </TouchableOpacity>
                  ))}
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm,
    paddingTop: SPACING.xxl + SPACING.sm,
    paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },

  segments: {
    flexDirection: 'row', gap: SPACING.sm,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.md,
  },
  segment: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: SPACING.sm, borderRadius: RADIUS.full,
    borderWidth: 1, borderColor: colors.border,
  },
  segmentActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  segmentText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  segmentTextActive: { color: colors.text, fontWeight: '700' },

  scroll: { paddingBottom: SPACING.xxl, flexGrow: 1 },
  hint: {
    color: colors.textSecondary, fontSize: 12, lineHeight: 18,
    paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm,
  },

  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: '33.33%', aspectRatio: 1, position: 'relative', padding: 1 },
  cellMedia: { width: '100%', height: '100%' },
  cellPlaceholder: {
    width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center',
    borderWidth: 0.5, borderColor: colors.border,
  },
  typeBadge: {
    position: 'absolute', top: 6, right: 6,
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center',
  },

  empty: { alignItems: 'center', paddingTop: SPACING.xxl, gap: SPACING.sm },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
});
