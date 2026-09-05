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

type Tab = 'all' | 'liked' | 'saved';
const TABS: Tab[] = ['all', 'liked', 'saved'];

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
// audio (music/podcast/audiobook) by song name or artist; defaults to the most-streamed.
// Tap a row's cover to PREVIEW the track; tap the row (or ＋) to select it.
export default function SongPickerModal({ visible, onClose, onSelect, ownOnly = false }: {
  visible: boolean;
  onClose: () => void;
  onSelect: (song: PickedSong) => void;
  /**
   * Music-video mode: offer ONLY songs this user made or is credited on, and
   * drop the Liked/Saved tabs (those are other people's tracks, which is the
   * opposite of what "a song currently on my page" means).
   */
  ownOnly?: boolean;
}) {
  const { colors, mode } = useTheme();
  const isLight = mode === 'light';
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { playSong, stop: stopSong } = usePostMusicActions();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('all');

  // Per-tab result cache for this opening of the sheet. Revisiting a tab paints
  // from here in the same commit as the tab highlight, so there is no skeleton
  // and no flash — the list simply is what it was. Cleared on close so a song
  // liked in between is picked up next time.
  const cache = useRef<Partial<Record<Tab, any[]>>>({});
  // How many songs a tab dropped for lacking reuse consent. A tab that is empty
  // ONLY because of that must not claim you have no likes.
  const dropped = useRef<Partial<Record<Tab, number>>>({});
  // Monotonic id: a response from a tab you have already left is discarded
  // rather than painted over the current one.
  const reqId = useRef(0);

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

  // Reset on CLOSE, not on open. Resetting on open sets `tab` in one effect
  // while the loader effect below runs in the same commit still seeing the
  // PREVIOUS tab — so opening the sheet fired a throwaway query for whichever
  // tab you happened to leave it on. Tearing down on the way out means the next
  // open starts from already-correct state and loads exactly once.
  //
  // The caches go too: a song liked between openings should show up.
  useEffect(() => {
    if (visible) return;
    stopPreview();
    setQuery('');
    setTab('all');
    setResults([]);
    setLoading(false);
    cache.current = {};
    dropped.current = {};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // ONE effect owns every load. It used to be two, plus imperative calls in
  // switchTab, and that is what made the All tab flash twice: switchTab fetched
  // immediately AND changing `tab` re-ran the effect, so two identical searches
  // raced, each toggling the skeleton on and off.
  //
  // Now nothing fetches imperatively. The tab and the query are the inputs; this
  // decides what that combination should show.
  useEffect(() => {
    if (!visible) return;
    const term = query.trim();
    const id = ++reqId.current;
    // Late responses from a tab you already left must not paint. Without this
    // the previous tab's rows land on top of the new tab's.
    const fresh = () => id === reqId.current;

    const cached = cache.current[tab];

    // Music-video mode: one fixed list (mine + credited), filtered locally as
    // you type. No server search — the set is small and already in hand, and a
    // per-keystroke query over your own catalogue would be pure latency.
    if (ownOnly) {
      if (cached) { setLoading(false); setResults(filterLocal(cached, term)); return; }
      setLoading(true);
      loadOwnAndCredited().then((rows) => {
        if (!fresh()) return;
        cache.current.all = rows;
        setResults(filterLocal(rows, term));
        setLoading(false);
      });
      return;
    }

    // Liked / Saved. Cached means the switch is a pure render — the list is on
    // screen in the same commit as the tab highlight, with no skeleton between.
    if (tab !== 'all') {
      if (cached) { setLoading(false); setResults(filterLocal(cached, term)); return; }
      setLoading(true);
      loadMine(tab).then(({ rows, droppedCount }) => {
        if (!fresh()) return;
        cache.current[tab] = rows;
        dropped.current[tab] = droppedCount;
        setResults(filterLocal(rows, term));
        setLoading(false);
      });
      return;
    }

    // All with an empty box: the default listing, also cached, so coming
    // back from Liked is instant instead of re-fetching what it already had.
    if (!term) {
      if (cached) { setLoading(false); setResults(cached); return; }
      setLoading(true);
      runSearch('').then((rows) => {
        if (!fresh()) return;
        cache.current.all = rows;
        setResults(rows);
        setLoading(false);
      });
      return;
    }

    // All while typing. Deliberately does NOT raise `loading`: swapping the
    // list for a skeleton on every keystroke is the stutter this was reported
    // for. The current results stay put and are replaced once the answer lands.
    const timer = setTimeout(() => {
      runSearch(term).then((rows) => {
        if (!fresh()) return;
        setResults(rows);
        setLoading(false);
      });
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, tab, query, ownOnly]);

  // Switching tab clears the search box: a term typed against the whole
  // catalogue rarely matches inside your own likes, and carrying it over makes
  // a full tab look empty. Purely state — the effect above does the loading.
  function switchTab(next: Tab) {
    if (next === tab) return;
    stopPreview();
    setQuery('');
    setTab(next);
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

  /**
   * Music-video mode listing: songs this user uploaded, plus songs they are
   * credited on via posts.features (the collaborator credits from
   * song_features.sql). A featured artist posting the video for a track they
   * sang on is the normal case, so owning the upload cannot be the test.
   *
   * Two queries merged rather than one `.or()`: the credited half is a jsonb
   * containment check, and embedding `[{"id":"…"}]` inside PostgREST's or-syntax
   * means quoting braces and quotes into a comma-separated grammar. Two plain
   * requests are slower by one round trip and impossible to get subtly wrong.
   *
   * NO consent filter here, unlike searchSounds. That gate exists because
   * attaching someone's audio to a video is SYNCHRONISATION — actually
   * reproducing their recording. Link-only mode never plays the track; it
   * renders a credit and a link to the song's own post. There is no
   * reproduction to license, and requiring reuse-consent to link to a song you
   * performed on would block the exact case this feature is for.
   */
  async function loadOwnAndCredited(): Promise<any[]> {
    const { data: { user } } = await supabase.auth.getUser();
    const uid = user?.id;
    if (!uid) return [];

    const base = () => supabase
      .from('posts')
      .select(MINE_EMBED_LEGACY)
      .in('type', ['audio', 'podcast', 'audiobook'])
      .is('archived_at', null)
      .order('created_at', { ascending: false })
      .limit(100);

    const [mine, credited] = await Promise.all([
      base().eq('user_id', uid),
      base().contains('features', [{ id: uid }]),
    ]);

    const byId = new Map<string, any>();
    for (const row of [...(mine.data ?? []), ...(credited.data ?? [])]) {
      if (row?.id) byId.set(row.id, row);
    }
    return [...byId.values()];
  }

  // RETURNS rows rather than setting state. Every caller is the one effect
  // above, which decides whether the answer is still wanted before painting it.
  async function runSearch(q: string): Promise<any[]> {
    const term = q.trim();
    const { data, error } = await searchSounds(term, true);
    if (error && /sound_opt_in|sound_withdrawn_at/.test(error.message ?? '')) {
      // sound_optin.sql hasn't been applied yet. Retry unfiltered so the picker
      // keeps working, matching how every other feature here degrades before its
      // migration lands. Once the migration runs the consent filter takes effect
      // on its own, with no code change.
      const { data: fallback } = await searchSounds(term, false);
      return fallback ?? [];
    }
    return data ?? [];
  }

  // Your liked or saved songs. One query per tab per open — the list is small
  // and bounded, so filtering it in memory beats round-tripping every keystroke.
  async function loadMine(kind: Tab): Promise<{ rows: any[]; droppedCount: number }> {
    const { data: { user } } = await supabase.auth.getUser();
    const uid = user?.id;
    if (!uid) return { rows: [], droppedCount: 0 };

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

    return { rows: reusable, droppedCount: songs.length - reusable.length };
  }

  // Pure. Local search within Liked/Saved, over title and artist — the same two
  // fields the server-side search matches on.
  function filterLocal(rows: any[], term: string): any[] {
    const q = term.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((p: any) => {
      const title = String(p.caption ?? '').toLowerCase();
      const artist = `${p.profiles?.display_name ?? ''} ${p.profiles?.username ?? ''}`.toLowerCase();
      return title.includes(q) || artist.includes(q);
    });
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

          {/* Source picker. All searches the whole public catalogue;
              Liked and Saved read your own library. Hidden in music-video
              mode, where the only valid source is your own catalogue. */}
          {!ownOnly && (
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
          )}

          {/* Fixed-height capsule; the clear button is ALWAYS mounted (hidden
              via opacity) so the input never reflows/misaligns when it appears. */}
          {/* textSecondary, not textTertiary, for BOTH the icon and the
              placeholder. Tertiary measured 1.94:1 on this field in light mode —
              the washed-out look — and is no better in dark. Secondary is 6.05:1
              light and 6.79:1 dark. */}
          <View style={[styles.searchBar, isLight && styles.searchBarLight]}>
            <Ionicons name="search-outline" size={18} color={colors.textSecondary} />
            <TextInput
              style={styles.searchInput}
              placeholder={t('songPicker.searchPlaceholder')}
              placeholderTextColor={colors.textSecondary}
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
                {tab === 'all' || query.trim()
                  ? t('songPicker.empty')
                  : (dropped.current[tab] ?? 0) > 0
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
                      {/* Softer than colors.text in light mode. A filled circle
                          at #16161A is 17:1 on this row — a black blob sitting
                          beside the orange add, two heavy marks fighting for the
                          same attention. textSecondary keeps it unmistakably a
                          control at 6:1 and lets the orange lead, which is the
                          one that commits you to something. Dark mode is left
                          alone: a white circle on a dark row does not read heavy
                          the way black on cream does. */}
                      <Ionicons
                        name={previewing ? 'pause-circle' : 'play-circle'}
                        size={30}
                        color={isLight ? colors.textSecondary : colors.text}
                      />
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
  // Light mode: a defined edge, because nothing else can carry one.
  //
  // The field is surfaceLight on a surface sheet — 1.15:1, invisible as a shape —
  // and it cannot be fixed with fill. Recessing it enough to read as a boundary
  // (3:1) needs a tint dark enough to drop the placeholder under 4.5:1, so the
  // fill can be legible or it can be visible, not both. The border does the work
  // instead: 3.0:1 against the field it encloses, 2.6:1 against the sheet, and
  // still lighter than the text so it reads as an input rather than a button.
  searchBarLight: { borderColor: '#948F82' },
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
