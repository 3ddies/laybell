import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, ActivityIndicator, Image, Alert, RefreshControl,
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
import { COLORS, SPACING, RADIUS } from '../constants/theme';

type Tab = 'posts' | 'stories';

export default function ArchiveScreen() {
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
      'Archived post',
      'Restore this post to your profile, or delete it permanently.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Restore',
          onPress: async () => {
            const ok = await restorePostById(post.id);
            if (ok) setPosts(prev => prev.filter(p => p.id !== post.id));
            else Alert.alert('Error', 'Could not restore the post. Please try again.');
          },
        },
        {
          text: 'Delete permanently',
          style: 'destructive',
          onPress: async () => {
            const ok = await deletePostById(post.id);
            if (ok) setPosts(prev => prev.filter(p => p.id !== post.id));
            else Alert.alert('Error', 'Could not delete the post. Please try again.');
          },
        },
      ],
    );
  }

  function onStoryPress(story: Story) {
    Alert.alert(
      'Archived story',
      'Restore this story to share it again for 24 hours, or delete it permanently.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Restore',
          onPress: async () => {
            const ok = await restoreStory(story.id);
            if (ok) setStories(prev => prev.filter(s => s.id !== story.id));
            else Alert.alert('Error', 'Could not restore the story. Please try again.');
          },
        },
        {
          text: 'Delete permanently',
          style: 'destructive',
          onPress: async () => {
            await deleteStory(story.id);
            setStories(prev => prev.filter(s => s.id !== story.id));
          },
        },
      ],
    );
  }

  const isEmpty = tab === 'posts' ? posts.length === 0 : stories.length === 0;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={COLORS.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Archive</Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Posts / Stories segments */}
      <View style={styles.segments}>
        {(['posts', 'stories'] as const).map(t => (
          <TouchableOpacity
            key={t}
            style={[styles.segment, tab === t && styles.segmentActive]}
            onPress={() => setTab(t)}
          >
            <Ionicons
              name={t === 'posts' ? 'grid-outline' : 'aperture-outline'}
              size={15}
              color={tab === t ? COLORS.text : COLORS.textSecondary}
            />
            <Text style={[styles.segmentText, tab === t && styles.segmentTextActive]}>
              {t === 'posts' ? 'Posts' : 'Stories'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={COLORS.primary} /></View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={COLORS.primary} />
          }
        >
          <Text style={styles.hint}>
            {tab === 'posts'
              ? 'Posts you archived are hidden from your profile, feed and explore. Tap one to restore or permanently delete it.'
              : 'Stories that expired after 24 hours. Tap one to re-share it for another 24 hours or permanently delete it.'}
          </Text>

          {isEmpty ? (
            <View style={styles.empty}>
              <Ionicons
                name={tab === 'posts' ? 'archive-outline' : 'aperture-outline'}
                size={44}
                color={COLORS.textTertiary}
              />
              <Text style={styles.emptyTitle}>
                {tab === 'posts' ? 'No archived posts' : 'No archived stories'}
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
                          <Ionicons name={isAudioPost(post.type) ? 'musical-notes' : 'videocam'} size={26} color={COLORS.primary} />
                        </LinearGradient>
                      )}
                      <View style={styles.typeBadge}>
                        <Ionicons
                          name={post.type === 'slideshow' ? 'copy' : post.type === 'video' ? 'videocam' : isAudioPost(post.type) ? 'musical-notes' : 'image'}
                          size={11} color={COLORS.text}
                        />
                      </View>
                    </TouchableOpacity>
                  ))
                : stories.map(story => (
                    <TouchableOpacity key={story.id} style={styles.cell} onPress={() => onStoryPress(story)} activeOpacity={0.85}>
                      {story.media_type === 'video' && !story.thumbnail_url ? (
                        <VideoThumb thumbnailUrl={story.thumbnail_url} mediaUrl={story.media_url} style={styles.cellMedia} />
                      ) : (
                        <Image source={{ uri: story.thumbnail_url ?? story.media_url }} style={styles.cellMedia} resizeMode="cover" />
                      )}
                      {story.media_type === 'video' && (
                        <View style={styles.typeBadge}><Ionicons name="play" size={11} color={COLORS.text} /></View>
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm,
    paddingTop: SPACING.xxl + SPACING.sm,
    paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: COLORS.border,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: COLORS.text, fontSize: 18, fontWeight: '800' },

  segments: {
    flexDirection: 'row', gap: SPACING.sm,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.md,
  },
  segment: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: SPACING.sm, borderRadius: RADIUS.full,
    borderWidth: 1, borderColor: COLORS.border,
  },
  segmentActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  segmentText: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '600' },
  segmentTextActive: { color: COLORS.text, fontWeight: '700' },

  scroll: { paddingBottom: SPACING.xxl, flexGrow: 1 },
  hint: {
    color: COLORS.textSecondary, fontSize: 12, lineHeight: 18,
    paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm,
  },

  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: '33.33%', aspectRatio: 1, position: 'relative', padding: 1 },
  cellMedia: { width: '100%', height: '100%' },
  cellPlaceholder: {
    width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center',
    borderWidth: 0.5, borderColor: COLORS.border,
  },
  typeBadge: {
    position: 'absolute', top: 6, right: 6,
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center',
  },

  empty: { alignItems: 'center', paddingTop: SPACING.xxl, gap: SPACING.sm },
  emptyTitle: { color: COLORS.text, fontSize: 16, fontWeight: '700' },
});
