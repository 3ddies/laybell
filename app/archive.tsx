import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, Image, Alert, RefreshControl, Platform, Dimensions, ActivityIndicator,
} from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';
import { useRouter, useFocusEffect } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { restorePostById, deletePostById } from '../lib/postActions';
import { fetchArchivedStories, deleteStory, type Story } from '../lib/stories';
import { fetchArchivedStorybooks, fetchStorybookFull, unarchiveStorybook, updateStorybook, deleteStorybook, type Storybook } from '../lib/storybooks';
import ArchiveOptionsSheet, { type ArchiveOption } from '../components/ArchiveOptionsSheet';
import * as Haptics from 'expo-haptics';
import { isAudioPost } from '../lib/genres';
import VideoThumb from '../components/VideoThumb';
import StoryThumb from '../components/StoryThumb';
import ConfirmDialog from '../components/ConfirmDialog';
import { SPACING, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { GridSkeleton } from '../components/Skeleton';

const SCREEN_W = Dimensions.get('window').width;
// Stories archive: 3 columns of 9:16 (vertical) thumbnails — stories are portrait,
// so they're shown as the rectangle they are, not squashed into a square.
const STORY_W = Math.floor(SCREEN_W / 3);

type Tab = 'posts' | 'stories';

export default function ArchiveScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('posts');
  const [posts, setPosts] = useState<any[]>([]);
  const [stories, setStories] = useState<Story[]>([]);
  const [archivedBooks, setArchivedBooks] = useState<Storybook[]>([]);
  const [openingBookId, setOpeningBookId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); setRefreshing(false); return; }
    const [postsRes, archivedStories, archivedStorybooks] = await Promise.all([
      // Own posts with archived_at set (newest archived first). Returns nothing
      // until the posts.archived_at column is migrated — degrades to empty.
      supabase
        .from('posts')
        .select('*')
        .eq('user_id', user.id)
        .not('archived_at', 'is', null)
        .order('archived_at', { ascending: false }),
      fetchArchivedStories(user.id),
      fetchArchivedStorybooks(user.id),
    ]);
    setPosts(postsRes.data ?? []);
    setStories(archivedStories);
    setArchivedBooks(archivedStorybooks);
    setLoading(false);
    setRefreshing(false);
  }, []);

  // Refetch on focus (not just mount) so a book made public in the editor — or any
  // change from the options sheet — is reflected when returning to this screen.
  useFocusEffect(useCallback(() => { load(); }, [load]));

  function selectTab(seg: Tab) {
    if (seg === tab) return;
    Haptics.selectionAsync().catch(() => {});
    setTab(seg);
  }

  // Restore / delete-permanently is a themed ConfirmDialog (Restore is the safe
  // primary; "Delete permanently" the destructive secondary). `confirm` holds the
  // target and stays set through the exit animation; `dialogOpen` drives visibility.
  // Posts tap → themed restore / delete-permanently dialog (unchanged). Stories and
  // storybooks use the long-press options sheet below instead.
  const [confirm, setConfirm] = useState<{ id: string } | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  function onPostPress(post: any) { setConfirm({ id: post.id }); setDialogOpen(true); }

  async function doRestore() {
    const c = confirm; if (!c) return;
    setDialogOpen(false);
    const ok = await restorePostById(c.id);
    if (ok) setPosts(prev => prev.filter(p => p.id !== c.id));
    else Alert.alert(t('archive.errorTitle'), t('archive.restorePostError'));
  }

  async function doDeletePermanently() {
    const c = confirm; if (!c) return;
    setDialogOpen(false);
    const ok = await deletePostById(c.id);
    if (ok) setPosts(prev => prev.filter(p => p.id !== c.id));
    else Alert.alert(t('archive.errorTitle'), t('archive.deletePostError'));
  }

  // Long-press options sheet for an archived storybook or story. The target stays
  // set through the sheet's close animation (so its rows don't blank mid-slide); a
  // fresh open overwrites it.
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [optionsTarget, setOptionsTarget] = useState<{ kind: 'book'; book: Storybook } | { kind: 'story'; story: Story } | null>(null);
  function openOptions(target: { kind: 'book'; book: Storybook } | { kind: 'story'; story: Story }) {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setOptionsTarget(target);
    setOptionsOpen(true);
  }

  // Restore an archived book to the shelf — privately (back on the shelf, still
  // hidden from others) or public (also visible on the profile to everyone). Both
  // clear archived_at. Optimistic, with a revert on failure.
  async function restoreBookToShelf(b: Storybook, makePublic: boolean) {
    setArchivedBooks(prev => prev.filter(x => x.id !== b.id));
    const ok = makePublic
      ? await updateStorybook(b.id, { is_public: true, archived_at: null })
      : await unarchiveStorybook(b.id);
    if (ok) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    else { setArchivedBooks(prev => [b, ...prev]); Alert.alert(t('archive.errorTitle'), "Couldn't update this storybook. Please try again."); }
  }

  async function deleteBook(b: Storybook) {
    setArchivedBooks(prev => prev.filter(x => x.id !== b.id));
    const ok = await deleteStorybook(b.id);
    if (ok) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    else { setArchivedBooks(prev => [b, ...prev]); Alert.alert(t('archive.errorTitle'), "Couldn't delete this storybook. Please try again."); }
  }

  async function deleteArchivedStory(s: Story) {
    setStories(prev => prev.filter(x => x.id !== s.id));
    await deleteStory(s.id);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  }

  // Tap an archived story → replay it like the original (read-only: the viewer
  // count shows, but not the individual viewers). Restore/delete live in the
  // long-press options sheet. The owner is the current user, so the story viewer
  // builds its header from myProfile and skips recording a fresh view.
  function playArchivedStory(story: Story) {
    router.push({
      pathname: '/story/[userId]',
      params: { userId: story.user_id, archived: '1', story: JSON.stringify(story) },
    });
  }

  // Tap an archived storybook → open its viewer. Pre-load the book (and warm the
  // first frame) first, so it opens already-painted like the profile shelf does.
  async function openArchivedBook(b: Storybook) {
    if (openingBookId) return;
    setOpeningBookId(b.id);
    const full = await fetchStorybookFull(b.id); // also warms the viewer's cache
    if (!full) { setOpeningBookId(null); Alert.alert(t('archive.errorTitle'), "Couldn't load this storybook."); return; }
    const first = full.chapters.flatMap(c => c.items)[0];
    const firstUrl = first ? (first.media_type === 'video' ? first.thumbnail_url : first.media_url) : null;
    if (firstUrl) {
      await Promise.race([Image.prefetch(firstUrl).catch(() => {}), new Promise(r => setTimeout(r, 2000))]);
    }
    setOpeningBookId(null);
    router.push({ pathname: '/storybook/[id]', params: { id: b.id, books: JSON.stringify(archivedBooks.map(x => x.id)) } });
  }

  // Build the options-sheet rows for the current long-press target.
  const sheetOptions: ArchiveOption[] = (() => {
    const target = optionsTarget;
    if (!target) return [];
    if (target.kind === 'book') {
      const b = target.book;
      return [
        { key: 'view', label: t('archive.opt.view'), icon: 'eye-outline', onPress: () => openArchivedBook(b) },
        { key: 'edit', label: t('archive.opt.edit'), icon: 'create-outline', onPress: () => router.push({ pathname: '/storybook/edit/[id]', params: { id: b.id } }) },
        { key: 'shelf', label: t('archive.opt.putBack'), icon: 'library-outline', onPress: () => restoreBookToShelf(b, false) },
        { key: 'public', label: t('archive.opt.makePublic'), icon: 'globe-outline', onPress: () => restoreBookToShelf(b, true) },
        { key: 'delete', label: t('archive.opt.deleteBook'), icon: 'trash-outline', tone: 'destructive',
          confirm: { title: t('archive.opt.deleteBookTitle'), body: t('archive.opt.deleteBookBody'), confirmLabel: t('common.delete') },
          onPress: () => deleteBook(b) },
      ];
    }
    const s = target.story;
    return [
      { key: 'view', label: t('archive.opt.view'), icon: 'eye-outline', onPress: () => playArchivedStory(s) },
      { key: 'delete', label: t('archive.opt.deleteStory'), icon: 'trash-outline', tone: 'destructive',
        confirm: { title: t('archive.opt.deleteStoryTitle'), body: t('archive.opt.deleteStoryBody'), confirmLabel: t('common.delete') },
        onPress: () => deleteArchivedStory(s) },
    ];
  })();
  const sheetTitle = optionsTarget ? (optionsTarget.kind === 'book' ? optionsTarget.book.title : t('archive.story.subtitle')) : undefined;
  const sheetSubtitle = optionsTarget?.kind === 'book' ? t('archive.book.subtitle') : undefined;

  const isEmpty = tab === 'posts' ? posts.length === 0 : (stories.length === 0 && archivedBooks.length === 0);

  const confirmDialog = (
    <ConfirmDialog
      visible={dialogOpen}
      title={t('archive.postTitle')}
      message={t('archive.postBody')}
      confirmLabel={t('archive.restore')}
      icon="refresh-outline"
      secondaryLabel={t('archive.deletePermanently')}
      secondaryDestructive
      onConfirm={doRestore}
      onSecondary={doDeletePermanently}
      onCancel={() => setDialogOpen(false)}
    />
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('account.archive')}</Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Posts / Stories — the active word highlighted, the other dimmed */}
      <View style={styles.segments}>
        {(['posts', 'stories'] as const).map(seg => (
          <TouchableOpacity
            key={seg}
            style={styles.segment}
            onPress={() => selectTab(seg)}
            activeOpacity={0.6}
          >
            <Text style={[styles.segmentText, tab === seg && styles.segmentTextActive]}>
              {seg === 'posts' ? t('archive.tabPosts') : t('archive.tabStories')}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={{ flex: 1 }}>
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
          {tab === 'stories' && archivedBooks.length > 0 && (
            <View style={styles.bookSection}>
              <Text style={styles.sectionLabel}>{t('archive.book.section')}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.bookRail}>
                {archivedBooks.map(b => (
                  <TouchableOpacity
                    key={b.id}
                    style={styles.bookTile}
                    activeOpacity={0.85}
                    onPress={() => openArchivedBook(b)}
                    onLongPress={() => openOptions({ kind: 'book', book: b })}
                    delayLongPress={300}
                  >
                    {b.cover_url ? (
                      <Image source={{ uri: b.cover_url }} style={styles.bookCover} resizeMode="cover" />
                    ) : (
                      <View style={[styles.bookCover, styles.bookCoverEmpty]}>
                        <Ionicons name="book" size={22} color={colors.textTertiary} />
                      </View>
                    )}
                    {openingBookId === b.id && (
                      <View style={styles.bookOpening}><ActivityIndicator color="#fff" /></View>
                    )}
                    <Text style={styles.bookTitle} numberOfLines={1}>{b.title}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          )}

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
                    <TouchableOpacity key={story.id} style={styles.storyCell} onPress={() => playArchivedStory(story)} onLongPress={() => openOptions({ kind: 'story', story })} activeOpacity={0.85}>
                      <StoryThumb story={story} width={STORY_W - 2} />
                      {story.media_type === 'video' && (
                        <View style={styles.typeBadge}><Ionicons name="play" size={11} color="#fff" /></View>
                      )}
                    </TouchableOpacity>
                  ))}
            </View>
          )}
        </ScrollView>
      )}

      {Platform.OS === 'ios' ? (
        <FullWindowOverlay>{confirmDialog}</FullWindowOverlay>
      ) : confirmDialog}

      <ArchiveOptionsSheet
        visible={optionsOpen}
        title={sheetTitle}
        subtitle={sheetSubtitle}
        options={sheetOptions}
        onClose={() => setOptionsOpen(false)}
      />
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
  headerTitle: { color: colors.text, fontSize: 17, fontWeight: '700', letterSpacing: -0.3 },

  // Posts / Stories as plain words — selection is just the active word highlighted
  // (full color + bold), the other dimmed. No bar, pill, box or track.
  segments: {
    flexDirection: 'row',
    // Same vertical footprint as before (old was xs top + md bottom = 20), but split
    // evenly top/bottom so the words sit centered instead of hugging the header line.
    marginHorizontal: SPACING.md, marginVertical: 10,
  },
  segment: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 6 },
  segmentText: { color: colors.textSecondary, fontSize: 15, fontWeight: '600', letterSpacing: -0.2 },
  segmentTextActive: { color: colors.text, fontWeight: '700' },

  scroll: { paddingTop: SPACING.xs, paddingBottom: SPACING.xxl, flexGrow: 1 },

  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: '33.33%', aspectRatio: 1, position: 'relative', padding: 1 },
  // Stories are portrait: a 9:16 cell (height comes from StoryThumb), 1px gutter.
  storyCell: { width: STORY_W, padding: 1, position: 'relative' },
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

  // Archived storybooks rail, pinned at the top of the Stories archive.
  bookSection: { paddingBottom: SPACING.sm },
  sectionLabel: { color: colors.text, fontSize: 14, fontWeight: '800', paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm },
  bookRail: { paddingHorizontal: SPACING.md, gap: SPACING.md },
  bookTile: { width: 96 },
  bookCover: { width: 96, height: 128, borderRadius: 14, backgroundColor: colors.surfaceLight },
  bookCoverEmpty: { alignItems: 'center', justifyContent: 'center' },
  bookOpening: { position: 'absolute', top: 0, left: 0, width: 96, height: 128, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  bookTitle: { color: colors.text, fontSize: 12, fontWeight: '600', marginTop: 6 },
});
