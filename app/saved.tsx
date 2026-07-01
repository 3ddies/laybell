import { View, Text, StyleSheet, TouchableOpacity, FlatList } from 'react-native';
import { useCallback, useEffect, useState } from 'react';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabase';
import { isAudioPost } from '../lib/genres';
import { SPACING, RADIUS, SHADOWS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { useAudio } from '../contexts/AudioContext';
import { useAudioPlayer } from '../hooks/useAudioPlayer';
import { usePostOptions } from '../contexts/PostOptionsContext';
import ExploreGrid from '../components/ExploreGrid';
import TrackRow from '../components/TrackRow';
import AddToPlaylistModal from '../components/AddToPlaylistModal';
import SwipeBackPager from '../components/SwipeBackPager';
import { ListRowsSkeleton } from '../components/Skeleton';

// Everything a user saves is a row in `saves` pointing at a post. Media (image /
// video / slideshow) and songs (audio posts) are the same table, split by type.
const SAVED_TABS = ['media', 'songs'] as const;
type SavedTab = (typeof SAVED_TABS)[number];

// Columns needed by both the media grid and the song rows.
const POST_FIELDS =
  'id,type,media_url,caption,thumbnail_url,cover_url,aspect_ratio,slides,stream_count,view_count,duration_seconds,archived_at,user_id,profiles!posts_user_id_fkey(id,username,display_name,avatar_url,badge_tier,badge_show)';

export default function SavedScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { show: showOptions } = usePostOptions();
  const { playingId, play } = useAudioPlayer();
  const { expand } = useAudio();

  const [tab, setTab] = useState<SavedTab>('media');
  const [media, setMedia] = useState<any[]>([]);
  const [songs, setSongs] = useState<any[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [playlistModalPostId, setPlaylistModalPostId] = useState<string | null>(null);

  // Jump to the Music tab's Playlists view (keeps all saved songs in one place).
  // dismissTo pops the settings/saved modals to the already-mounted tabs pager
  // in a single dispatch, matching the app's modal→tab navigation pattern.
  const goToPlaylists = () => {
    const r = router as any;
    if (typeof r.dismissTo === 'function') r.dismissTo('/(tabs)/music?view=playlists');
    else { try { r.dismissAll?.(); } catch {} r.navigate('/(tabs)/music?view=playlists'); }
  };

  const fetchSaved = useCallback(async (userId: string) => {
    const { data } = await supabase
      .from('saves')
      .select(`id, posts(${POST_FIELDS})`)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    const rows = (data ?? []).filter((s: any) => s.posts && !s.posts.archived_at);
    // Media = anything that isn't an audio post; songs = audio posts.
    setMedia(rows.filter((s: any) => !isAudioPost(s.posts.type)).map((s: any) => s.posts));
    setSongs(rows.filter((s: any) => isAudioPost(s.posts.type)));
  }, []);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) { setCurrentUserId(user.id); await fetchSaved(user.id); }
      setLoading(false);
    })();
  }, [fetchSaved]);

  // Re-pull on focus so unsaving elsewhere is reflected when returning here.
  useFocusEffect(useCallback(() => { if (currentUserId) fetchSaved(currentUserId); }, [currentUserId, fetchSaved]));

  const onRefresh = useCallback(async () => {
    if (!currentUserId) return;
    setRefreshing(true);
    await fetchSaved(currentUserId);
    setRefreshing(false);
  }, [currentUserId, fetchSaved]);

  const removeSong = (postId: string) => setSongs(prev => prev.filter((s: any) => s.posts?.id !== postId));

  return (
    <SwipeBackPager>
      <View style={styles.container}>
        <View style={[styles.header, { paddingTop: Math.max(insets.top, SPACING.md) }]}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="chevron-back" size={26} color={colors.primary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('saved.title')}</Text>
          <View style={styles.headerSpacer} />
        </View>

        {/* Media / Songs sub-tabs */}
        <View style={styles.tabRow}>
          {SAVED_TABS.map((key) => {
            const active = tab === key;
            return (
              <TouchableOpacity key={key} style={[styles.tab, active && styles.tabActive]} onPress={() => setTab(key)} activeOpacity={0.85}>
                <Text style={[styles.tabText, active && styles.tabTextActive]}>{t(`saved.tab.${key}`)}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {loading ? (
          <ListRowsSkeleton rows={8} trailing={false} />
        ) : tab === 'media' ? (
          <ExploreGrid
            posts={media}
            refreshing={refreshing}
            onRefresh={onRefresh}
            currentUserId={currentUserId}
            onPostDeleted={(id) => setMedia(prev => prev.filter((p: any) => p.id !== id))}
            emptyText={t('saved.emptyMedia')}
          />
        ) : (
          <FlatList
            data={songs}
            keyExtractor={item => item.id}
            contentContainerStyle={{ paddingBottom: insets.bottom + 90, flexGrow: 1 }}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Ionicons name="bookmark-outline" size={40} color={colors.textTertiary} />
                <Text style={styles.emptyText}>{t('saved.emptySongs')}</Text>
              </View>
            }
            ListFooterComponent={
              songs.length > 0 ? (
                <TouchableOpacity style={styles.goPlaylists} activeOpacity={0.8} onPress={goToPlaylists}>
                  <Ionicons name="albums-outline" size={18} color={colors.background} />
                  <Text style={styles.goPlaylistsText}>{t('saved.goToPlaylists')}</Text>
                  <Ionicons name="chevron-forward" size={16} color={colors.background} />
                </TouchableOpacity>
              ) : null
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
                badgeProfile={item.posts?.profiles}
                badgeOwnerId={item.posts?.user_id}
                isPlaying={playingId === item.posts?.id}
                hidePlayButton
                onPlay={() => play(item.posts?.id, item.posts?.media_url, item.posts?.caption, item.posts?.profiles?.display_name, item.posts?.cover_url)}
                onCoverPress={() => { play(item.posts?.id, item.posts?.media_url, item.posts?.caption, item.posts?.profiles?.display_name, item.posts?.cover_url); expand(); }}
                onAddToPlaylist={() => setPlaylistModalPostId(item.posts?.id)}
                onAvatarPress={() => router.push(`/profile/${item.posts?.user_id}`)}
                onOptions={() => showOptions({
                  postId: item.posts?.id,
                  isOwn: item.posts?.user_id === currentUserId,
                  authorId: item.posts?.user_id,
                  authorName: item.posts?.profiles?.username,
                  mediaType: item.posts?.type ?? 'audio',
                  mediaUrl: item.posts?.media_url,
                  cover: item.posts?.cover_url,
                  onDeleted: () => removeSong(item.posts?.id),
                  onArchived: () => removeSong(item.posts?.id),
                })}
              />
            )}
          />
        )}

        <AddToPlaylistModal
          visible={!!playlistModalPostId}
          postId={playlistModalPostId ?? ''}
          onClose={() => setPlaylistModalPostId(null)}
        />
      </View>
    </SwipeBackPager>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingBottom: SPACING.sm + 4,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  backBtn: { width: 42, alignItems: 'flex-start', justifyContent: 'center', paddingVertical: SPACING.xs },
  headerSpacer: { width: 42 },
  headerTitle: { color: colors.text, fontSize: 20, fontWeight: '800', letterSpacing: 0.2 },

  tabRow: {
    flexDirection: 'row', marginHorizontal: SPACING.md, marginTop: SPACING.md, marginBottom: SPACING.sm,
    backgroundColor: colors.surface, borderRadius: RADIUS.full, padding: 3, gap: 3,
  },
  tab: { flex: 1, paddingVertical: 9, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  tabActive: { backgroundColor: colors.text, ...SHADOWS.sm },
  tabText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  tabTextActive: { color: colors.background, fontWeight: '700' },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.md, paddingTop: SPACING.xxl },
  emptyText: { color: colors.textTertiary, fontSize: 14, textAlign: 'center' },

  // "Go to playlists" — high-contrast filled pill: white/black text in dark mode,
  // black/white text in light mode (colors.text fill + colors.background content).
  goPlaylists: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm,
    marginHorizontal: SPACING.md, marginTop: SPACING.md,
    paddingVertical: SPACING.md, borderRadius: RADIUS.lg,
    backgroundColor: colors.text,
  },
  goPlaylistsText: { color: colors.background, fontSize: 15, fontWeight: '700' },
});
