import { View, Text, StyleSheet, TextInput, FlatList, TouchableOpacity, ActivityIndicator, Modal, Alert, Platform, useWindowDimensions } from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SPACING, RADIUS, SHADOWS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { searchGifs, gifSearchAvailable, type Gif } from '../lib/gifSearch';
import { fetchUserGifs, addUserGif, removeUserGif, type UserGif } from '../lib/userGifs';

// GIF picker with two tabs: Giphy Search and the user's own "My GIFs" library
// (saved GIFs + ones they created from Laybell videos). Tap a GIF to attach it;
// long-press a search result to save it to My GIFs, or a library GIF to remove it.
type Tab = 'search' | 'library';

export default function GifPickerModal({
  visible, onClose, onSelect, userId, inOverlay,
}: {
  visible: boolean;
  onClose: () => void;
  // `src` (original Laybell video post id) is carried for library GIFs the user
  // created, so a sent GIF can offer "go to the original video".
  onSelect: (g: Gif & { src?: string }) => void;
  userId?: string | null;
  // Render into its own FullWindowOverlay (iOS) when opened from the Now Playing
  // overlay, where a nested <Modal> would deadlock.
  inOverlay?: boolean;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const colW = (width - SPACING.md * 2 - SPACING.sm) / 2;

  const [tab, setTab] = useState<Tab>('search');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Gif[]>([]);
  const [loading, setLoading] = useState(false);
  const [library, setLibrary] = useState<UserGif[]>([]);
  const [libLoading, setLibLoading] = useState(false);
  const reqRef = useRef(0);

  useEffect(() => {
    if (!visible || tab !== 'search') return;
    const id = ++reqRef.current;
    setLoading(true);
    const timer = setTimeout(async () => {
      const gifs = await searchGifs(query);
      if (reqRef.current === id) { setResults(gifs); setLoading(false); }
    }, query.trim() ? 350 : 0);
    return () => clearTimeout(timer);
  }, [query, visible, tab]);

  const loadLibrary = useCallback(async () => {
    if (!userId) { setLibrary([]); return; }
    setLibLoading(true);
    setLibrary(await fetchUserGifs(userId));
    setLibLoading(false);
  }, [userId]);

  useEffect(() => { if (visible && tab === 'library') loadLibrary(); }, [visible, tab, loadLibrary]);
  useEffect(() => { if (!visible) { setQuery(''); setTab('search'); } }, [visible]);

  async function saveSearchGif(g: Gif) {
    if (!userId) return;
    const err = await addUserGif(userId, { url: g.url, w: g.w, h: g.h, kind: 'saved' });
    Alert.alert(err ? t('gif.saveToLibraryFailed') : t('gif.savedToLibraryTitle'), err || t('gif.savedToLibraryBody'));
  }
  async function removeLibraryGif(g: UserGif) {
    Alert.alert(t('gif.removeTitle'), t('gif.removeBody'), [
      { text: t('groups.cancel'), style: 'cancel' },
      { text: t('gif.remove'), style: 'destructive', onPress: async () => { await removeUserGif(g.id); setLibrary(prev => prev.filter(x => x.id !== g.id)); } },
    ]);
  }

  const body = (
    <View style={[styles.container, { paddingTop: insets.top + SPACING.sm }]}>
        {/* Tabs + cancel */}
        <View style={styles.topRow}>
          <View style={styles.tabRow}>
            {(['search', 'library'] as Tab[]).map((k) => {
              const active = tab === k;
              return (
                <TouchableOpacity key={k} style={[styles.tab, active && styles.tabActive]} onPress={() => setTab(k)} activeOpacity={0.85}>
                  <Text style={[styles.tabText, active && styles.tabTextActive]}>{t(k === 'search' ? 'gif.tab.search' : 'gif.tab.library')}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.cancel}>{t('groups.cancel')}</Text>
          </TouchableOpacity>
        </View>

        {tab === 'search' && (
          <View style={styles.searchWrap}>
            <View style={styles.searchBar}>
              <Ionicons name="search-outline" size={18} color={colors.textTertiary} />
              <TextInput
                style={styles.searchInput}
                placeholder={t('gif.searchPlaceholder')}
                placeholderTextColor={colors.textTertiary}
                value={query}
                onChangeText={setQuery}
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
          </View>
        )}

        {tab === 'search' ? (
          !gifSearchAvailable() ? (
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
              columnWrapperStyle={styles.col}
              contentContainerStyle={styles.grid}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={!loading ? <View style={styles.center}><Text style={styles.hintBody}>{t('gif.noResults')}</Text></View> : null}
              renderItem={({ item }) => {
                const ratio = item.w && item.h ? item.w / item.h : 1;
                return (
                  <TouchableOpacity activeOpacity={0.8} onPress={() => { onSelect(item); onClose(); }} onLongPress={() => saveSearchGif(item)} delayLongPress={300}>
                    <Image source={{ uri: item.preview }} style={{ width: colW, height: colW / (ratio || 1), borderRadius: RADIUS.md, backgroundColor: colors.surfaceLight }} contentFit="cover" />
                  </TouchableOpacity>
                );
              }}
            />
          )
        ) : (
          libLoading ? (
            <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
          ) : (
            <FlatList
              data={library}
              keyExtractor={(g) => g.id}
              numColumns={2}
              columnWrapperStyle={styles.col}
              contentContainerStyle={styles.grid}
              ListEmptyComponent={
                <View style={styles.center}>
                  <Ionicons name="albums-outline" size={36} color={colors.textTertiary} />
                  <Text style={styles.hintTitle}>{t('gif.library.emptyTitle')}</Text>
                  <Text style={styles.hintBody}>{t('gif.library.emptyBody')}</Text>
                </View>
              }
              renderItem={({ item }) => {
                const ratio = item.w && item.h ? item.w / item.h : 1;
                return (
                  <TouchableOpacity activeOpacity={0.8} onPress={() => { onSelect({ id: item.id, url: item.url, preview: item.url, w: item.w, h: item.h, src: item.sourcePostId }); onClose(); }} onLongPress={() => removeLibraryGif(item)} delayLongPress={300}>
                    <Image source={{ uri: item.url }} style={{ width: colW, height: colW / (ratio || 1), borderRadius: RADIUS.md, backgroundColor: colors.surfaceLight }} contentFit="cover" />
                  </TouchableOpacity>
                );
              }}
            />
          )
        )}

        {tab === 'search' && <Text style={styles.attribution}>{t('gif.poweredBy')}</Text>}
    </View>
  );

  // Inside the iOS Now Playing FullWindowOverlay a nested <Modal> deadlocks, so
  // render into its own FullWindowOverlay instead (like the other sheets).
  if (inOverlay && Platform.OS === 'ios') {
    return visible ? <FullWindowOverlay>{body}</FullWindowOverlay> : null;
  }
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {body}
    </Modal>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm },
  tabRow: { flex: 1, flexDirection: 'row', backgroundColor: colors.surface, borderRadius: RADIUS.full, padding: 3, gap: 3 },
  tab: { flex: 1, paddingVertical: 8, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  tabActive: { backgroundColor: colors.text, ...SHADOWS.sm },
  tabText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  tabTextActive: { color: colors.background, fontWeight: '700' },
  cancel: { color: colors.primary, fontSize: 15, fontWeight: '700' },
  searchWrap: { paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm },
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.surfaceElevated, borderRadius: RADIUS.full, paddingHorizontal: SPACING.md,
  },
  searchInput: { flex: 1, paddingVertical: SPACING.sm + 2, color: colors.text, fontSize: 15 },
  col: { gap: SPACING.sm, paddingHorizontal: SPACING.md },
  grid: { gap: SPACING.sm, paddingBottom: SPACING.xl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, padding: SPACING.xl },
  hintTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  hintBody: { color: colors.textTertiary, fontSize: 14, textAlign: 'center' },
  attribution: { color: colors.textTertiary, fontSize: 11, textAlign: 'center', paddingVertical: SPACING.xs },
});
