import { View, Text, StyleSheet, TouchableOpacity, FlatList, Alert, useWindowDimensions } from 'react-native';
import { useCallback, useEffect, useState } from 'react';
import { useRouter, useFocusEffect } from 'expo-router';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabase';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { fetchUserGifs, removeUserGif, type UserGif } from '../lib/userGifs';
import SwipeBackPager from '../components/SwipeBackPager';
import ImageViewerModal from '../components/ImageViewerModal';
import { GridSkeleton } from '../components/Skeleton';

// "My GIFs" library — every Laybell GIF the user saved or created, in one grid.
// Tap to preview full-screen; created GIFs (made from a Laybell video) show a
// "go to original video" badge; long-press to remove from the library.
export default function GifsScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const colW = (width - SPACING.md * 2 - SPACING.sm) / 2;

  const [gifs, setGifs] = useState<UserGif[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);

  const load = useCallback(async (uid: string) => {
    setGifs(await fetchUserGifs(uid));
  }, []);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) { setUserId(user.id); await load(user.id); }
      setLoading(false);
    })();
  }, [load]);

  // Re-pull on focus so removing/adding elsewhere is reflected on return.
  useFocusEffect(useCallback(() => { if (userId) load(userId); }, [userId, load]));

  function confirmRemove(g: UserGif) {
    Alert.alert(t('gif.removeTitle'), t('gif.removeBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('gif.remove'), style: 'destructive', onPress: async () => { await removeUserGif(g.id); setGifs(prev => prev.filter(x => x.id !== g.id)); } },
    ]);
  }

  return (
    <SwipeBackPager>
      <View style={styles.container}>
        <View style={[styles.header, { paddingTop: Math.max(insets.top, SPACING.md) }]}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="chevron-back" size={26} color={colors.primary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('account.gifs')}</Text>
          <View style={styles.headerSpacer} />
        </View>

        {loading ? (
          <GridSkeleton columns={2} count={8} gap={SPACING.sm} padding={SPACING.md} />
        ) : (
          <FlatList
            data={gifs}
            keyExtractor={(g) => g.id}
            numColumns={2}
            columnWrapperStyle={styles.col}
            contentContainerStyle={styles.grid}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Ionicons name="happy-outline" size={40} color={colors.textTertiary} />
                <Text style={styles.emptyTitle}>{t('gif.library.emptyTitle')}</Text>
                <Text style={styles.emptyText}>{t('gif.library.emptyBody')}</Text>
              </View>
            }
            renderItem={({ item }) => {
              const ratio = item.w && item.h ? item.w / item.h : 1;
              return (
                <TouchableOpacity
                  activeOpacity={0.85}
                  onPress={() => setViewerUrl(item.url)}
                  onLongPress={() => confirmRemove(item)}
                  delayLongPress={300}
                >
                  <Image source={{ uri: item.url }} style={{ width: colW, height: colW / (ratio || 1), borderRadius: RADIUS.md, backgroundColor: colors.surfaceLight }} contentFit="cover" />
                  {item.sourcePostId ? (
                    <TouchableOpacity
                      style={styles.videoBadge}
                      onPress={() => router.push({ pathname: '/reel/[id]', params: { id: item.sourcePostId! } })}
                      hitSlop={8}
                    >
                      <Ionicons name="film" size={13} color="#fff" />
                      <Text style={styles.videoBadgeText}>{t('gif.tap.goToVideoShort')}</Text>
                    </TouchableOpacity>
                  ) : null}
                </TouchableOpacity>
              );
            }}
          />
        )}

        <ImageViewerModal url={viewerUrl} onClose={() => setViewerUrl(null)} />
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

  col: { gap: SPACING.sm, paddingHorizontal: SPACING.md },
  grid: { gap: SPACING.sm, paddingTop: SPACING.md, paddingBottom: SPACING.xl, flexGrow: 1 },

  videoBadge: {
    position: 'absolute', left: 6, bottom: 6, flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: RADIUS.full, paddingHorizontal: 8, paddingVertical: 4,
  },
  videoBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, paddingTop: SPACING.xxl },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  emptyText: { color: colors.textTertiary, fontSize: 14, textAlign: 'center', paddingHorizontal: SPACING.xl },
});
