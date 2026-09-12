import { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity, Keyboard, ActivityIndicator,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { isAudioPost } from '../lib/genres';
import { formatCount } from '../lib/format';
import { setSongLike, subscribeSongLike } from '../lib/songLike';
import { usePostMusicActions } from '../contexts/PostMusicContext';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { TrackListSkeleton } from './Skeleton';

// The song list behind every "add music": tabs, search, preview, and a like on
// every song. Shown in a sheet by components/SongPickerModal (images, slideshows,
// stories) and inline in the video studio's music menu (components/VideoStudio).
//
// Tabs (owner, 2026-09-11): All — the public catalogue; Liked — songs you liked,
// with a heart on every row so a song can be liked right here; Yours — your own
// songs; Saved — songs you saved. Music-video mode shows one list instead: songs
// you made or are credited on.
//
// Mounted only while it is on screen, so each opening starts on All with an empty
// search, loads once, and stops its preview when it goes.

export type PickedSong = {
  id: string;
  title: string;
  artist: string;
  artistId: string;
  cover?: string | null;
};

// Preview playback here is keyed by this host id in the shared post-music player.
const PREVIEW_HOST = 'song-picker';

type Tab = 'all' | 'liked' | 'yours' | 'saved';
const TABS: Tab[] = ['all', 'liked', 'yours', 'saved'];
// Music-video mode's single list is cached apart from Yours: it also holds songs
// you are credited on, and it is not limited to public ones.
type ListKey = Tab | 'credited';

const SONG_SELECT =
  'id, caption, cover_url, media_url, user_id, stream_count, profiles!posts_user_id_fkey(id, username, display_name, avatar_url)';

// The embed used for Liked and Saved. Mirrors the shape searchSounds() returns, so
// every list feeds the same row renderer and the same pick().
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

const DARK_ACCENT = '#FAB525';

export default function SongBrowser({ ownOnly = false, selectedId = null, onPick, tone = 'theme' }: {
  /** Music-video mode: only songs this user made or is credited on, and no tabs. */
  ownOnly?: boolean;
  /** The song already attached, marked in the list. */
  selectedId?: string | null;
  onPick: (song: PickedSong) => void;
  /** 'dark' sits over video (the studio); 'theme' follows the app theme (sheets). */
  tone?: 'theme' | 'dark';
}) {
  const { colors, mode } = useTheme();
  const isLight = mode === 'light';
  const themed = useThemedStyles(makeStyles);
  const dark = tone === 'dark';
  const s = dark ? darkStyles : themed;
  const accent = dark ? DARK_ACCENT : colors.primary;
  const soft = dark ? 'rgba(255,255,255,0.72)' : colors.textSecondary;
  const { t } = useTranslation();
  const { playSong, stop: stopSong } = usePostMusicActions();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  // The listed songs you have liked, for the hearts.
  const [liked, setLiked] = useState<Set<string>>(() => new Set());

  // Per-list result cache for this opening. Revisiting a tab paints from here in
  // the same commit as the tab highlight — no skeleton between, no flash.
  const cache = useRef<Partial<Record<ListKey, any[]>>>({});
  // How many songs a list dropped for lacking reuse consent. A list that is empty
  // ONLY because of that must not claim you have no likes.
  const dropped = useRef<Partial<Record<ListKey, number>>>({});
  // Monotonic id: a response from a list you have already left is discarded
  // rather than painted over the current one.
  const reqId = useRef(0);
  const uidRef = useRef<string | null>(null);
  const listKey: ListKey = ownOnly ? 'credited' : tab;

  async function userId(): Promise<string | null> {
    if (uidRef.current) return uidRef.current;
    const { data: { user } } = await supabase.auth.getUser();
    uidRef.current = user?.id ?? null;
    return uidRef.current;
  }

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
  // Leaving stops the preview. No state to set — the list is gone.
  useEffect(() => () => stopSong(PREVIEW_HOST), [stopSong]);

  function markLiked(ids: string[], on: boolean) {
    setLiked((prev) => {
      if (ids.every((id) => prev.has(id) === on)) return prev;
      const next = new Set(prev);
      for (const id of ids) { if (on) next.add(id); else next.delete(id); }
      return next;
    });
  }

  // ONE effect owns every load. The list and the query are the inputs; this
  // decides what that combination should show. (Two loaders plus imperative
  // fetches in switchTab once raced each other and made All flash twice.)
  useEffect(() => {
    const term = query.trim();
    const id = ++reqId.current;
    const fresh = () => id === reqId.current;
    const failed = () => { if (fresh()) { setResults([]); setLoading(false); } };
    const cached = cache.current[listKey];

    // Liked, Yours, Saved and music-video mode's list: fetched once per opening, then
    // filtered here as you type — small, bounded lists, where a query per
    // keystroke would be pure latency.
    if (listKey !== 'all') {
      if (cached) { setLoading(false); setResults(filterLocal(cached, term)); return; }
      setLoading(true);
      const load: Promise<{ rows: any[]; droppedCount: number }> =
        listKey === 'liked' ? loadLibrary('likes')
          : listKey === 'saved' ? loadLibrary('saves')
          : listKey === 'yours' ? loadYours().then((rows) => ({ rows, droppedCount: 0 }))
          : loadOwnAndCredited().then((rows) => ({ rows, droppedCount: 0 }));
      load.then(({ rows, droppedCount }) => {
        if (!fresh()) return;
        cache.current[listKey] = rows;
        dropped.current[listKey] = droppedCount;
        // Liked's rows are liked by definition. Marked once, here, so a heart
        // un-liked in this list is not refilled by the next keystroke's filter.
        if (listKey === 'liked') markLiked(rows.map((r: any) => r.id), true);
        setResults(filterLocal(rows, term));
        setLoading(false);
      }, failed);
      return;
    }

    // All with an empty box: the default listing, also cached, so coming back
    // from another tab is instant instead of re-fetching what it already had.
    if (!term) {
      if (cached) { setLoading(false); setResults(cached); return; }
      setLoading(true);
      runSearch('').then((rows) => {
        if (!fresh()) return;
        cache.current.all = rows;
        setResults(rows);
        setLoading(false);
      }, failed);
      return;
    }

    // All while typing. Deliberately does NOT raise `loading`: swapping the list
    // for a skeleton on every keystroke is the stutter this was reported for. The
    // current results stay put and are replaced once the answer lands.
    const timer = setTimeout(() => {
      runSearch(term).then((rows) => {
        if (!fresh()) return;
        setResults(rows);
        setLoading(false);
      }, failed);
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey, query]);

  // The hearts for every list but Liked: one question per list shown.
  useEffect(() => {
    if (!results.length || listKey === 'liked') return;
    let cancelled = false;
    const ids = results.map((r) => r.id).filter(Boolean).slice(0, 100);
    userId().then(async (uid) => {
      if (!uid || cancelled) return;
      const { data, error } = await supabase.from('likes').select('post_id').eq('user_id', uid).in('post_id', ids);
      if (cancelled || error || !data) return;
      const on = new Set((data as any[]).map((r) => r.post_id));
      markLiked(ids.filter((pid) => on.has(pid)), true);
      markLiked(ids.filter((pid) => !on.has(pid)), false);
    }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, listKey]);

  // A like made anywhere else — the player, the lock screen — shows here too.
  useEffect(() => subscribeSongLike(({ postId, liked: on }) => markLiked([postId], on)), []);

  // Likes the actual song, with the same write the player's heart makes
  // (lib/songLike): the like, the badge and the artist's notification. Painted at
  // once, and put back if the write did not land.
  async function toggleLike(item: any) {
    const want = !liked.has(item.id);
    markLiked([item.id], want);
    const uid = await userId();
    if (!uid) { markLiked([item.id], !want); return; }
    const landed = await setSongLike(item.id, uid, want, item.user_id ?? item.profiles?.id ?? null);
    if (landed !== want) markLiked([item.id], landed);
  }

  // Switching tab clears the search box: a term typed against the whole catalogue
  // rarely matches inside your own likes, and carrying it over makes a full tab
  // look empty. Purely state — the effect above does the loading.
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
      .select(SONG_SELECT)
      .eq('is_public', true)
      .in('type', ['audio', 'podcast', 'audiobook'])
      .is('publish_at', null)
      .is('archived_at', null)
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

  // RETURNS rows rather than setting state. Every caller is the one effect above,
  // which decides whether the answer is still wanted before painting it.
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

  /**
   * Your own songs, to use on your own post. No reuse-consent filter — the upload
   * is yours. Public ones only: a private song's audio would not play for anyone
   * else watching the post.
   */
  async function loadYours(): Promise<any[]> {
    const uid = await userId();
    if (!uid) return [];
    const { data } = await supabase
      .from('posts')
      .select(SONG_SELECT)
      .eq('user_id', uid)
      .eq('is_public', true)
      .in('type', ['audio', 'podcast', 'audiobook'])
      .is('archived_at', null)
      .is('publish_at', null)
      .order('created_at', { ascending: false })
      .limit(100);
    return data ?? [];
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
    const uid = await userId();
    if (!uid) return [];

    const base = () => supabase
      .from('posts')
      .select(MINE_EMBED_LEGACY)
      .in('type', ['audio', 'podcast', 'audiobook'])
      .is('archived_at', null)
      .is('publish_at', null)
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

  // Your liked or saved songs. One query per list per opening — the lists are small
  // and bounded, so filtering them in memory beats round-tripping every keystroke.
  async function loadLibrary(table: 'likes' | 'saves'): Promise<{ rows: any[]; droppedCount: number }> {
    const uid = await userId();
    if (!uid) return { rows: [], droppedCount: 0 };

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

  // Pure. Local search within a fetched list, over title and artist — the same two
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
    onPick({
      id: item.id,
      title: item.caption || t('songPicker.audioTrack'),
      artist: item.profiles?.display_name || item.profiles?.username || t('songPicker.unknownArtist'),
      artistId: item.profiles?.id || item.user_id,
      cover: item.cover_url ?? null,
    });
  }

  // A list that is empty ONLY because every song in it is reuse-restricted says
  // so, rather than claiming you have no likes — the difference is yours to know.
  const emptyText = listKey === 'all' || query.trim()
    ? t('songPicker.empty')
    : (dropped.current[listKey] ?? 0) > 0
      ? t('songPicker.noneReusable')
      : listKey === 'liked' ? t('songPicker.emptyLiked')
        : listKey === 'saved' ? t('songPicker.emptySaved')
        : t('songPicker.emptyYours');

  return (
    <View style={s.fill}>
      {/* The source. Hidden in music-video mode, where the only valid source is
          your own catalogue. */}
      {!ownOnly && (
        <View style={s.tabs}>
          {TABS.map((tb) => {
            const on = tab === tb;
            return (
              <TouchableOpacity
                key={tb}
                style={[s.tab, on && s.tabOn]}
                onPress={() => switchTab(tb)}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
              >
                <Text style={[s.tabText, on && s.tabTextOn]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
                  {t(`songPicker.tab${tb.charAt(0).toUpperCase()}${tb.slice(1)}`)}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {/* Fixed-height capsule; the clear button is ALWAYS mounted (hidden via
          opacity) so the input never reflows/misaligns when it appears. The icon
          and placeholder use textSecondary, not textTertiary: tertiary measured
          1.94:1 on this field in light mode. */}
      <View style={[s.searchBar, !dark && isLight && themed.searchBarLight]}>
        <Ionicons name="search-outline" size={18} color={soft} />
        <TextInput
          style={s.searchInput}
          placeholder={t('songPicker.searchPlaceholder')}
          placeholderTextColor={soft}
          selectionColor={accent}
          cursorColor={accent}
          keyboardAppearance={dark ? 'dark' : 'default'}
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
          <Ionicons name="close-circle" size={18} color={soft} />
        </TouchableOpacity>
      </View>

      {loading ? (
        dark
          ? <View style={s.center}><ActivityIndicator color="#fff" /></View>
          : <View style={s.skeletonWrap}><TrackListSkeleton rows={8} /></View>
      ) : results.length === 0 ? (
        <View style={s.center}>
          <Text style={s.empty}>{emptyText}</Text>
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={s.list}
          renderItem={({ item }) => {
            const previewing = previewId === item.id;
            const isLiked = liked.has(item.id);
            const chosen = !!selectedId && item.id === selectedId;
            return (
              <TouchableOpacity style={[s.row, chosen && s.rowOn]} onPress={() => pick(item)} activeOpacity={0.8}>
                {item.cover_url ? (
                  <ExpoImage source={{ uri: item.cover_url }} style={s.cover} contentFit="cover" cachePolicy="memory-disk" />
                ) : dark ? (
                  <View style={[s.cover, s.coverBlank]}>
                    <Ionicons name="musical-notes" size={18} color={accent} />
                  </View>
                ) : (
                  <LinearGradient colors={GRADIENTS.primarySoft} style={s.cover}>
                    <Ionicons name="musical-notes" size={18} color={accent} />
                  </LinearGradient>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={[s.rowTitle, (previewing || chosen) && { color: accent }]} numberOfLines={1}>
                    {item.caption || t('songPicker.audioTrack')}
                  </Text>
                  <Text style={s.rowArtist} numberOfLines={1}>
                    {item.profiles?.display_name || item.profiles?.username}
                    {item.stream_count ? ` · ${t('songPicker.plays', { count: formatCount(item.stream_count) })}` : ''}
                  </Text>
                </View>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={isLiked ? t('a11y.unlike') : t('a11y.like')}
                  onPress={() => toggleLike(item)}
                  hitSlop={8}
                >
                  <Ionicons name={isLiked ? 'heart' : 'heart-outline'} size={24} color={isLiked ? colors.like : soft} />
                </TouchableOpacity>
                {/* Softer than colors.text in light mode: a filled circle at #16161A is
                    17:1 on this row, a black blob fighting the orange add for the same
                    attention. On a dark row a white circle does not read heavy. */}
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={previewing ? t('a11y.pause') : t('a11y.play')}
                  onPress={() => togglePreview(item)}
                  hitSlop={8}
                >
                  <Ionicons
                    name={previewing ? 'pause-circle' : 'play-circle'}
                    size={30}
                    color={dark ? '#fff' : isLight ? colors.textSecondary : colors.text}
                  />
                </TouchableOpacity>
                <Ionicons name={chosen ? 'checkmark-circle' : 'add-circle'} size={30} color={accent} />
              </TouchableOpacity>
            );
          }}
        />
      )}
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  fill: { flex: 1 },
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
  searchBar: {
    height: 44,
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.surfaceLight, borderRadius: 22,
    borderWidth: 1, borderColor: colors.borderStrong,
    paddingHorizontal: SPACING.md, marginHorizontal: SPACING.md, marginBottom: SPACING.sm,
  },
  // Light mode: a defined edge, because nothing else can carry one. The field is
  // surfaceLight on a surface sheet — 1.15:1, invisible as a shape — and a fill
  // dark enough to read as a boundary would drop the placeholder under 4.5:1. The
  // border does the work instead: 3.0:1 against the field, 2.6:1 against the sheet.
  searchBarLight: { borderColor: '#948F82' },
  // Intrinsic-height input centered by the fixed-height row — stretching it to
  // the row's full height made iOS top-align the text against the icon.
  searchInput: { flex: 1, paddingVertical: 0, color: colors.text, fontSize: 15, lineHeight: 20 },
  center: { alignItems: 'center', justifyContent: 'center', padding: SPACING.xxl },
  skeletonWrap: { flex: 1, padding: SPACING.md },
  empty: { color: colors.textTertiary, fontSize: 14, textAlign: 'center' },
  list: { padding: SPACING.md, gap: SPACING.sm },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: colors.border, padding: SPACING.sm + 2,
  },
  rowOn: { borderColor: colors.primary },
  cover: { width: 48, height: 48, borderRadius: RADIUS.sm, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  coverBlank: { backgroundColor: colors.surface },
  rowTitle: { color: colors.text, fontSize: 14.5, fontWeight: '700' },
  rowArtist: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
});

// Over video (the studio's music menu): always dark, whatever the theme. Same keys
// as the themed sheet, so one render serves both.
const darkStyles = StyleSheet.create({
  fill: { flex: 1 },
  tabs: { flexDirection: 'row', gap: 8, paddingBottom: 8 },
  tab: {
    flex: 1, paddingVertical: 7, borderRadius: 999,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1, borderColor: 'transparent',
  },
  tabOn: { backgroundColor: 'rgba(250,181,37,0.16)', borderColor: DARK_ACCENT },
  tabText: { color: 'rgba(255,255,255,0.75)', fontSize: 13, fontWeight: '700' },
  tabTextOn: { color: DARK_ACCENT },
  searchBar: {
    height: 40,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 20,
    paddingHorizontal: 12, marginBottom: 8,
  },
  searchBarLight: {},
  searchInput: { flex: 1, paddingVertical: 0, color: '#fff', fontSize: 15, lineHeight: 20 },
  center: { alignItems: 'center', justifyContent: 'center', padding: 24 },
  skeletonWrap: { flex: 1 },
  empty: { color: 'rgba(255,255,255,0.65)', fontSize: 14, textAlign: 'center' },
  list: { gap: 8, paddingBottom: 12 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 12,
    borderWidth: 1, borderColor: 'transparent', padding: 8,
  },
  rowOn: { borderColor: DARK_ACCENT },
  cover: { width: 44, height: 44, borderRadius: 8, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  coverBlank: { backgroundColor: 'rgba(255,255,255,0.12)' },
  rowTitle: { color: '#fff', fontSize: 14, fontWeight: '700' },
  rowArtist: { color: 'rgba(255,255,255,0.65)', fontSize: 12, marginTop: 2 },
});
