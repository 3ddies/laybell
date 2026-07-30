import {
  View, Text, StyleSheet, Modal, FlatList, TextInput,
  TouchableOpacity, Keyboard,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useEffect, useRef, useState } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { isAudioPost } from '../lib/genres';
import { formatCount } from '../lib/format';
import { usePostMusicActions } from '../contexts/PostMusicContext';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { TrackListSkeleton } from './Skeleton';

export type PickedSong = {
  id: string;
  title: string;
  artist: string;
  artistId: string;
  cover?: string | null;
};

// Preview playback inside this sheet is keyed by this host id in the shared
// post-music player.
const PREVIEW_HOST = 'song-picker';

type Tab = 'trending' | 'liked' | 'saved';
const TABS: Tab[] = ['trending', 'liked', 'saved'];

// The embed used for Liked/Saved. Mirrors the shape searchSounds() returns, so
// both feed the same row renderer and the same pick().
//
// sound_opt_in / sound_withdrawn_at are selected so the consent rule can be
// applied here too. Attaching someone's audio to a video is synchronisation,
// which no performing-rights licence covers — the uploader's own consent is the
// entire legal basis for this picker. Liking a track is not consent to reuse
// it, so the same filter the search applies has to apply to your own library.
const MINE_EMBED =
  'id, caption, cover_url, media_url, user_id, stream_count, type, archived_at, sound_opt_in, sound_withdrawn_at, profiles!posts_user_id_fkey(id, username, display_name, avatar_url)';
// Same select without the consent columns, for a database where sound_optin.sql
// hasn't been applied — matching how runSearch() degrades.
const MINE_EMBED_LEGACY =
  'id, caption, cover_url, media_url, user_id, stream_count, type, archived_at, profiles!posts_user_id_fkey(id, username, display_name, avatar_url)';

// Pick another creator's track to use on your image/video/story. Searches public
// audio (music/podcast/audiobook) by song name or artist; defaults to trending.
// Tap a row's cover to PREVIEW the track; tap the row (or ＋) to select it.
export default function SongPickerModal({ visible, onClose, onSelect }: {
  visible: boolean;
  onClose: () => void;
  onSelect: (song: PickedSong) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { playSong, stop: stopSong } = usePostMusicActions();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('trending');
  // Liked/Saved are fetched once per open and filtered in memory, so typing in
  // the search box doesn't re-query. `null` means "not loaded yet".
  const [mine, setMine] = useState<any[] | null>(null);
  // A liked song whose creator never allowed reuse is dropped, which would
  // otherwise read as "your likes are empty". Counting the drops lets the empty
  // state say what actually happened.
  const [filteredOut, setFilteredOut] = useState(0);

  function stopPreview() {
    stopSong(PREVIEW_HOST);
    setPreviewId(null);
  }
  function togglePreview(item: any) {
    if (previewId === item.id) {
      stopPreview();
    } else {
      playSong(PREVIEW_HOST, item.id, item.media_url ?? null);
      setPreviewId(item.id);
    }
  }

  useEffect(() => {
    if (visible) { setQuery(''); setTab('trending'); setMine(null); runSearch(''); }
    else stopPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Trending searches the server (debounced); Liked/Saved filter the fetched
  // list in memory, so those tabs respond to typing instantly and never
  // re-query.
  useEffect(() => {
    if (!visible) return;
    if (tab !== 'trending') { applyLocalFilter(query, mine); return; }
    const timer = setTimeout(() => runSearch(query), 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, tab, mine]);

  // Switching tab clears the search box: a term typed against the whole
  // catalogue rarely matches inside your own likes, and carrying it over makes
  // a full tab look empty.
  function switchTab(next: Tab) {
    if (next === tab) return;
    stopPreview();
    setQuery('');
    setTab(next);
    if (next === 'trending') { runSearch(''); return; }
    if (mine === null || mineKind.current !== next) loadMine(next);
  }

  // `consentFilter` is separated out so the search can be retried without it on a
  // pre-migration database — see runSearch.
  async function searchSounds(term: string, consentFilter: boolean) {
    let req = supabase
      .from('posts')
      .select('id, caption, cover_url, media_url, user_id, stream_count, profiles!posts_user_id_fkey(id, username, display_name, avatar_url)')
      .eq('is_public', true)
      .in('type', ['audio', 'podcast', 'audiobook'])
      .limit(30);

    if (consentFilter) {
      // Only sounds whose creator affirmatively allowed reuse and hasn't since
      // withdrawn it. Attaching audio to a video is synchronisation — a right no
      // performing-rights licence covers — so the uploader's own consent is the
      // entire legal basis for this feature. See supabase/sql/sound_optin.sql.
      //
      // `.is(..., null)` rather than a negated comparison: in SQL, null is
      // "unknown", so `.neq` would exclude every row that was never withdrawn —
      // i.e. almost the whole catalogue.
      req = req.eq('sound_opt_in', true).is('sound_withdrawn_at', null);
    }

    if (term) {
      // Also match by artist: find matching profiles, then OR their tracks in.
      const { data: profs } = await supabase
        .from('profiles').select('id').or(`username.ilike.%${term}%,display_name.ilike.%${term}%`).limit(15);
      const ids = (profs ?? []).map((p: any) => p.id);
      req = ids.length
        ? req.or(`caption.ilike.%${term}%,user_id.in.(${ids.join(',')})`)
        : req.ilike('caption', `%${term}%`);
    } else {
      req = req.order('stream_count', { ascending: false });
    }
    return req;
  }

  async function runSearch(q: string) {
    setLoading(true);
    const term = q.trim();

    const { data, error } = await searchSounds(term, true);
    if (error && /sound_opt_in|sound_withdrawn_at/.test(error.message ?? '')) {
      // sound_optin.sql hasn't been applied yet. Retry unfiltered so the picker
      // keeps working, matching how every other feature here degrades before its
      // migration lands. Once the migration runs the consent filter takes effect
      // on its own, with no code change.
      const { data: fallback } = await searchSounds(term, false);
      setResults(fallback ?? []);
      setLoading(false);
      return;
    }
    setResults(data ?? []);
    setLoading(false);
  }

  // Which kind `mine` currently holds, so re-entering a tab doesn't refetch but
  // switching between Liked and Saved does.
  const mineKind = useRef<Tab | null>(null);

  // Your liked or saved songs. One query per tab per open — the list is small
  // and bounded, so filtering it in memory beats round-tripping every keystroke.
  async function loadMine(kind: Tab) {
    setLoading(true);
    setResults([]);
    setFilteredOut(0);
    const { data: { user } } = await supabase.auth.getUser();
    const uid = user?.id;
    if (!uid) { mineKind.current = kind; setMine([]); setLoading(false); return; }

    const table = kind === 'liked' ? 'likes' : 'saves';
    let rows: any[] = [];
    let consentKnown = true;

    const { data, error } = await supabase
      .from(table)
      .select(`post_id, posts(${MINE_EMBED})`)
      .eq('user_id', uid)
      .order('created_at', { ascending: false })
      .limit(200);

    if (error && /sound_opt_in|sound_withdrawn_at/.test(error.message ?? '')) {
      // Pre-migration database: retry without the consent columns so the tab
      // still works, exactly as runSearch() does for the same reason.
      const { data: legacy } = await supabase
        .from(table)
        .select(`post_id, posts(${MINE_EMBED_LEGACY})`)
        .eq('user_id', uid)
        .order('created_at', { ascending: false })
        .limit(200);
      rows = legacy ?? [];
      consentKnown = false;
    } else {
      rows = data ?? [];
    }

    // The embed is null for a deleted post; archived and non-audio rows are the
    // same exclusions the Liked list on the Music tab makes.
    const songs = rows
      .map((r: any) => r.posts)
      .filter((p: any) => p && isAudioPost(p.type) && !p.archived_at);
    const reusable = consentKnown
      ? songs.filter((p: any) => p.sound_opt_in === true && p.sound_withdrawn_at == null)
      : songs;

    setFilteredOut(songs.length - reusable.length);
    mineKind.current = kind;
    setMine(reusable);
    setLoading(false);
  }

  // Local search within Liked/Saved, over title and artist — the same two
  // fields the server-side search matches on.
  function applyLocalFilter(q: string, rows: any[] | null) {
    if (rows === null) { setResults([]); return; }
    const term = q.trim().toLowerCase();
    if (!term) { setResults(rows); return; }
    setResults(rows.filter((p: any) => {
      const title = String(p.caption ?? '').toLowerCase();
      const artist = `${p.profiles?.display_name ?? ''} ${p.profiles?.username ?? ''}`.toLowerCase();
      return title.includes(term) || artist.includes(term);
    }));
  }

  function pick(item: any) {
    Keyboard.dismiss();
    stopPreview();
    onSelect({
      id: item.id,
      title: item.caption || t('songPicker.audioTrack'),
      artist: item.profiles?.display_name || item.profiles?.username || t('songPicker.unknownArtist'),
      artistId: item.profiles?.id || item.user_id,
      cover: item.cover_url ?? null,
    });
    onClose();
  }

  function close() {
    stopPreview();
    onClose();
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={close}>
        <TouchableOpacity style={styles.sheet} activeOpacity={1}>
          <View style={styles.handle} />
          <View style={styles.head}>
            <Text style={styles.title}>{t('songPicker.title')}</Text>
            <TouchableOpacity onPress={close} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('a11y.close')}><Ionicons name="close" size={22} color={colors.textSecondary} /></TouchableOpacity>
          </View>

          {/* Source picker. Trending searches the whole public catalogue;
              Liked and Saved read your own library. */}
          <View style={styles.tabs}>
            {TABS.map((tb) => {
              const on = tab === tb;
              return (
                <TouchableOpacity
                  key={tb}
                  style={[styles.tab, on && styles.tabOn]}
                  onPress={() => switchTab(tb)}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                >
                  <Text style={[styles.tabText, on && styles.tabTextOn]} numberOfLines={1}>
                    {t(`songPicker.tab${tb.charAt(0).toUpperCase()}${tb.slice(1)}`)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Fixed-height capsule; the clear button is ALWAYS mounted (hidden
              via opacity) so the input never reflows/misaligns when it appears. */}
          <View style={styles.searchBar}>
            <Ionicons name="search-outline" size={18} color={colors.textTertiary} />
            <TextInput
              style={styles.searchInput}
              placeholder={t('songPicker.searchPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              selectionColor={colors.primary}
              cursorColor={colors.primary}
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
            />
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.clear')}
              onPress={() => setQuery('')}
              disabled={query.length === 0}
              style={{ opacity: query.length > 0 ? 1 : 0 }}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
            </TouchableOpacity>
          </View>

          {loading ? (
            <View style={styles.skeletonWrap}><TrackListSkeleton rows={8} /></View>
          ) : results.length === 0 ? (
            <View style={styles.center}>
              <Text style={styles.empty}>
                {/* A tab that is empty ONLY because every song in it is
                    reuse-restricted says so, rather than claiming you have no
                    likes — the difference is the user's to know about. */}
                {tab === 'trending' || query.trim()
                  ? t('songPicker.empty')
                  : filteredOut > 0
                    ? t('songPicker.noneReusable')
                    : t(tab === 'liked' ? 'songPicker.emptyLiked' : 'songPicker.emptySaved')}
              </Text>
            </View>
          ) : (
            <FlatList
              data={results}
              keyExtractor={(item) => item.id}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              contentContainerStyle={styles.list}
              renderItem={({ item }) => {
                const previewing = previewId === item.id;
                return (
                  <TouchableOpacity style={styles.row} onPress={() => pick(item)} activeOpacity={0.8}>
                    {item.cover_url ? (
                      <ExpoImage source={{ uri: item.cover_url }} style={styles.cover} contentFit="cover" cachePolicy="memory-disk" />
                    ) : (
                      <LinearGradient colors={GRADIENTS.primarySoft} style={styles.cover}>
                        <Ionicons name="musical-notes" size={18} color={colors.primary} />
                      </LinearGradient>
                    )}
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.rowTitle, previewing && { color: colors.primary }]} numberOfLines={1}>
                        {item.caption || t('songPicker.audioTrack')}
                      </Text>
                      <Text style={styles.rowArtist} numberOfLines={1}>
                        {item.profiles?.display_name || item.profiles?.username}
                        {item.stream_count ? ` · ${t('songPicker.plays', { count: formatCount(item.stream_count) })}` : ''}
                      </Text>
                    </View>
                    {/* Preview + select, side by side, matched size */}
                    <TouchableOpacity accessibilityRole="button" accessibilityLabel={previewing ? t('a11y.pause') : t('a11y.play')} onPress={() => togglePreview(item)} hitSlop={8}>
                      <Ionicons name={previewing ? 'pause-circle' : 'play-circle'} size={30} color={colors.primary} />
                    </TouchableOpacity>
                    <Ionicons name="add-circle" size={30} color={colors.primary} />
                  </TouchableOpacity>
                );
              }}
            />
          )}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    maxHeight: '80%', minHeight: '55%', paddingBottom: SPACING.xl,
  },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginTop: SPACING.sm },
  tabs: {
    flexDirection: 'row', gap: SPACING.sm,
    paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm,
  },
  tab: {
    flex: 1, paddingVertical: SPACING.sm - 1, borderRadius: RADIUS.full,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surfaceLight,
    borderWidth: 1, borderColor: 'transparent',
  },
  tabOn: { backgroundColor: colors.primary + '1A', borderColor: colors.primary },
  tabText: { color: colors.textSecondary, fontSize: 13, fontWeight: '700' },
  tabTextOn: { color: colors.primary },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.lg, paddingVertical: SPACING.md },
  title: { color: colors.text, fontSize: 17, fontWeight: '800' },
  searchBar: {
    height: 44,
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.surfaceLight, borderRadius: 22,
    borderWidth: 1, borderColor: colors.borderStrong,
    paddingHorizontal: SPACING.md, marginHorizontal: SPACING.md, marginBottom: SPACING.sm,
  },
  // Intrinsic-height input centered by the fixed-height row — stretching it to
  // the row's full height made iOS top-align the text against the icon.
  searchInput: { flex: 1, paddingVertical: 0, color: colors.text, fontSize: 15, lineHeight: 20 },
  center: { alignItems: 'center', justifyContent: 'center', padding: SPACING.xxl },
  skeletonWrap: { flex: 1, padding: SPACING.md },
  empty: { color: colors.textTertiary, fontSize: 14 },
  list: { padding: SPACING.md, gap: SPACING.sm },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: colors.border, padding: SPACING.sm + 2,
  },
  cover: { width: 48, height: 48, borderRadius: RADIUS.sm, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  rowTitle: { color: colors.text, fontSize: 14.5, fontWeight: '700' },
  rowArtist: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
});
