import {
  View, Text, StyleSheet, Modal, FlatList, TextInput,
  TouchableOpacity, Image, Keyboard,
} from 'react-native';
import { useEffect, useState } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
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
    if (visible) { setQuery(''); runSearch(''); }
    else stopPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => runSearch(query), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

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
            <TouchableOpacity
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
            <View style={styles.center}><Text style={styles.empty}>{t('songPicker.empty')}</Text></View>
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
                      <Image source={{ uri: item.cover_url }} style={styles.cover} />
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
                    <TouchableOpacity onPress={() => togglePreview(item)} hitSlop={8}>
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
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.lg, paddingVertical: SPACING.md },
  title: { color: colors.text, fontSize: 17, fontWeight: '800' },
  searchBar: {
    height: 44,
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.surfaceLight, borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
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
