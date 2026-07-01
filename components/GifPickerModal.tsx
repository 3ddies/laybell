import { View, Text, StyleSheet, TextInput, FlatList, TouchableOpacity, ActivityIndicator, Modal, Pressable, useWindowDimensions } from 'react-native';
import { useEffect, useRef, useState } from 'react';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { searchGifs, gifSearchAvailable, type Gif } from '../lib/gifSearch';
import GifMakerModal from './GifMakerModal';

// GIF / meme search sheet (Tenor-backed). Trending on open; debounced search as
// you type; tap a GIF to attach it. Two-column masonry-ish grid using preview
// GIFs (small, animated) so scrolling stays light. Also hosts the "make a GIF
// from a video" tool, so all GIF paths live behind the one button.
export default function GifPickerModal({
  visible, onClose, onSelect, userId,
}: {
  visible: boolean;
  onClose: () => void;
  onSelect: (g: Gif) => void;
  userId?: string | null;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const colW = (width - SPACING.md * 2 - SPACING.sm) / 2;

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Gif[]>([]);
  const [loading, setLoading] = useState(false);
  const [makerOpen, setMakerOpen] = useState(false);
  const reqRef = useRef(0);

  // Debounced fetch (trending when empty). A monotonic request id guards against
  // out-of-order responses overwriting a newer search.
  useEffect(() => {
    if (!visible) return;
    const id = ++reqRef.current;
    setLoading(true);
    const timer = setTimeout(async () => {
      const gifs = await searchGifs(query);
      if (reqRef.current === id) { setResults(gifs); setLoading(false); }
    }, query.trim() ? 350 : 0);
    return () => clearTimeout(timer);
  }, [query, visible]);

  useEffect(() => { if (!visible) setQuery(''); }, [visible]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.container, { paddingTop: insets.top + SPACING.sm }]}>
        <View style={styles.header}>
          <View style={styles.searchBar}>
            <Ionicons name="search-outline" size={18} color={colors.textTertiary} />
            <TextInput
              style={styles.searchInput}
              placeholder={t('gif.searchPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              value={query}
              onChangeText={setQuery}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
            />
            {query.length > 0 && (
              <TouchableOpacity onPress={() => setQuery('')} hitSlop={8}>
                <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
              </TouchableOpacity>
            )}
          </View>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.cancel}>{t('groups.cancel')}</Text>
          </TouchableOpacity>
        </View>

        {/* Make a GIF from your own video. */}
        <TouchableOpacity style={styles.makeBtn} activeOpacity={0.8} onPress={() => setMakerOpen(true)}>
          <Ionicons name="film-outline" size={18} color={colors.primary} />
          <Text style={styles.makeBtnText}>{t('gif.make.entry')}</Text>
          <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
        </TouchableOpacity>

        {!gifSearchAvailable() ? (
          <View style={styles.center}>
            <Ionicons name="key-outline" size={36} color={colors.textTertiary} />
            <Text style={styles.hintTitle}>{t('gif.noKeyTitle')}</Text>
            <Text style={styles.hintBody}>{t('gif.noKeyBody')}</Text>
          </View>
        ) : loading && results.length === 0 ? (
          <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
        ) : (
          <FlatList
            data={results}
            keyExtractor={(g) => g.id}
            numColumns={2}
            columnWrapperStyle={{ gap: SPACING.sm, paddingHorizontal: SPACING.md }}
            contentContainerStyle={{ gap: SPACING.sm, paddingBottom: insets.bottom + SPACING.xl }}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={
              !loading ? (
                <View style={styles.center}>
                  <Text style={styles.hintBody}>{t('gif.noResults')}</Text>
                </View>
              ) : null
            }
            renderItem={({ item }) => {
              const ratio = item.w && item.h ? item.w / item.h : 1;
              return (
                <TouchableOpacity activeOpacity={0.8} onPress={() => { onSelect(item); onClose(); }}>
                  <Image
                    source={{ uri: item.preview }}
                    style={{ width: colW, height: colW / (ratio || 1), borderRadius: RADIUS.md, backgroundColor: colors.surfaceLight }}
                    contentFit="cover"
                  />
                </TouchableOpacity>
              );
            }}
          />
        )}

        <Text style={styles.attribution}>{t('gif.poweredBy')}</Text>

        <GifMakerModal
          visible={makerOpen}
          userId={userId ?? null}
          onClose={() => setMakerOpen(false)}
          onCreated={(g) => { onSelect({ id: `made-${g.url}`, url: g.url, preview: g.url, w: g.w, h: g.h }); onClose(); }}
        />
      </View>
    </Modal>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm },
  searchBar: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.surfaceElevated, borderRadius: RADIUS.full, paddingHorizontal: SPACING.md,
  },
  searchInput: { flex: 1, paddingVertical: SPACING.sm + 2, color: colors.text, fontSize: 15 },
  cancel: { color: colors.primary, fontSize: 15, fontWeight: '700' },
  makeBtn: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    marginHorizontal: SPACING.md, marginBottom: SPACING.sm,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm + 2,
    backgroundColor: colors.surface, borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  makeBtnText: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, padding: SPACING.xl },
  hintTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  hintBody: { color: colors.textTertiary, fontSize: 14, textAlign: 'center' },
  attribution: { color: colors.textTertiary, fontSize: 11, textAlign: 'center', paddingVertical: SPACING.xs },
});
