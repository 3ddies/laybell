import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, RefreshControl, Dimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import SwipeBackPager from '../components/SwipeBackPager';
import VideoThumb from '../components/VideoThumb';
import { fetchFilmCatalog } from '../lib/tv';
import { useProfile } from '../contexts/ProfileContext';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';

// The Films catalogue.
//
// It does NOT reuse TVVideoList: that component is a shelf-plus-grid built for
// Laybell TV, so on this page it drew its own "Films / See all" header and then
// an empty-grid message underneath — a duplicate title and a "No films yet"
// sitting directly below actual films. What belongs here is a different shape
// entirely: several horizontal rows over one catalogue.
//
// Rows render only when they have something in them, so a small catalogue looks
// deliberate instead of broken.

const SCREEN_W = Dimensions.get('window').width;
const H_PADDING = SPACING.md;
const TILE_W = Math.round((SCREEN_W - H_PADDING * 2) * 0.62);
const TILE_H = Math.round(TILE_W * (9 / 16));
// The catch-all grid mirrors Laybell TV's two-column geometry exactly, so
// "everything else" looks like the browsing surface people already know.
const GRID_GAP = SPACING.sm;
const COL_W = (SCREEN_W - H_PADDING * 2 - GRID_GAP) / 2;
const COL_H = Math.round(COL_W * (9 / 16));

function fmtRuntime(sec?: number | null): string {
  const s = Math.max(0, Math.round(sec ?? 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`;
}

export default function FilmsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { profile } = useProfile();

  const [rows, setRows] = useState<{
    recommended: any[]; trending: any[]; short: any[]; long: any[]; more: any[];
  }>({ recommended: [], trending: [], short: [], long: [], more: [] });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try { setRows(await fetchFilmCatalog(profile?.id ?? null)); }
    catch { /* offline — keep whatever is on screen */ }
  }, [profile?.id]);

  useEffect(() => { load().finally(() => setLoading(false)); }, [load]);

  const openFilm = (p: any, e?: any) => {
    const ne = e?.nativeEvent;
    const src = ne
      ? JSON.stringify({ x: ne.pageX - ne.locationX, y: ne.pageY - ne.locationY, width: TILE_W, height: TILE_H })
      : undefined;
    router.push({ pathname: '/reel/[id]', params: { id: p.id, post: JSON.stringify(p), ...(src ? { src } : {}) } });
  };

  const Row = ({ title, data }: { title: string; data: any[] }) => {
    if (!data.length) return null; // an empty row is worse than no row
    return (
      <View style={styles.row}>
        <Text style={styles.rowTitle}>{title}</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rowScroll}>
          {data.map((p) => (
            <TouchableOpacity
              key={p.id}
              style={styles.tile}
              activeOpacity={0.9}
              onPress={(e) => openFilm(p, e)}
            >
              <VideoThumb thumbnailUrl={p.thumbnail_url} mediaUrl={p.media_url} style={styles.thumb} />
              <View style={styles.playBadge}><Ionicons name="play" size={12} color="#fff" /></View>
              {/* A film leads with its NAME, its author second — the opposite of
                  an ordinary post card. */}
              <LinearGradient colors={['transparent', 'rgba(0,0,0,0.85)']} style={styles.overlay}>
                <Text style={styles.filmName} numberOfLines={1}>
                  {p.film_title || p.caption || p.profiles?.display_name || p.profiles?.username || ''}
                </Text>
                {!!p.profiles?.username && (
                  <Text style={styles.filmUser} numberOfLines={1}>@{p.profiles.username}</Text>
                )}
              </LinearGradient>
              <View style={styles.runtime}>
                <Text style={styles.runtimeText}>{fmtRuntime(p.duration_seconds)}</Text>
              </View>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    );
  };

  const hasRows = !!(rows.recommended.length || rows.trending.length || rows.short.length || rows.long.length);
  const isEmpty = !hasRows && !rows.more.length;

  return (
    <SwipeBackPager>
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => router.back()}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={t('a11y.back')}
          >
            <Ionicons name="chevron-back" size={26} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.title}>{t('tv.films')}</Text>
          {/* Balances the back chevron so the title stays optically centred. */}
          <View style={styles.headerSpacer} />
        </View>

        {loading ? (
          <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
        ) : isEmpty ? (
          <View style={styles.center}>
            <Ionicons name="film-outline" size={40} color={colors.textTertiary} />
            <Text style={styles.emptyText}>{t('films.empty')}</Text>
          </View>
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: insets.bottom + SPACING.xxl }}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
                tintColor={colors.primary}
              />
            }
          >
            <Row title={t('films.recommended')} data={rows.recommended} />
            <Row title={t('films.trending')} data={rows.trending} />
            <Row title={t('films.short')} data={rows.short} />
            <Row title={t('films.long')} data={rows.long} />

            {/* Everything no category earned. Only labelled "All films" when
                rows exist above it — on a small catalogue this IS the page, and
                a heading over the only content is noise. */}
            {rows.more.length > 0 && (
              <View style={styles.row}>
                {hasRows && <Text style={styles.rowTitle}>{t('films.all')}</Text>}
                <View style={styles.grid}>
                  {rows.more.map((p) => (
                    <TouchableOpacity
                      key={p.id}
                      style={styles.gridTile}
                      activeOpacity={0.9}
                      onPress={(e) => openFilm(p, e)}
                    >
                      <VideoThumb thumbnailUrl={p.thumbnail_url} mediaUrl={p.media_url} style={styles.thumb} />
                      <View style={styles.playBadge}><Ionicons name="play" size={12} color="#fff" /></View>
                      <LinearGradient colors={['transparent', 'rgba(0,0,0,0.85)']} style={styles.overlay}>
                        <Text style={styles.gridName} numberOfLines={1}>
                          {p.film_title || p.caption || p.profiles?.display_name || p.profiles?.username || ''}
                        </Text>
                      </LinearGradient>
                      <View style={styles.runtime}>
                        <Text style={styles.runtimeText}>{fmtRuntime(p.duration_seconds)}</Text>
                      </View>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}
          </ScrollView>
        )}
      </View>
    </SwipeBackPager>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
  },
  title: { color: c.text, fontSize: 26, fontWeight: '900', letterSpacing: -0.5 },
  headerSpacer: { width: 26 },

  row: { marginTop: SPACING.lg },
  // Smaller than the page title on purpose: these are shelves WITHIN Films, and
  // competing with the wordmark above would flatten the hierarchy.
  rowTitle: {
    color: c.text, fontSize: 19, fontWeight: '800', letterSpacing: -0.2,
    paddingHorizontal: H_PADDING, marginBottom: SPACING.sm,
  },
  rowScroll: { gap: SPACING.sm, paddingHorizontal: H_PADDING },

  tile: {
    width: TILE_W, height: TILE_H, borderRadius: RADIUS.md,
    overflow: 'hidden', backgroundColor: c.surfaceLight,
  },
  thumb: { width: '100%', height: '100%' },
  playBadge: {
    position: 'absolute', top: SPACING.sm, left: SPACING.sm,
    width: 26, height: 26, borderRadius: 13,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  overlay: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.lg, paddingBottom: SPACING.sm,
  },
  grid: {
    flexDirection: 'row', flexWrap: 'wrap',
    gap: GRID_GAP, paddingHorizontal: H_PADDING,
  },
  gridTile: {
    width: COL_W, height: COL_H, borderRadius: RADIUS.md,
    overflow: 'hidden', backgroundColor: c.surfaceLight,
  },
  gridName: { color: '#fff', fontSize: 13, fontWeight: '800' },
  filmName: { color: '#fff', fontSize: 15, fontWeight: '800' },
  filmUser: { color: 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: '600' },
  runtime: {
    position: 'absolute', top: SPACING.sm, right: SPACING.sm,
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: RADIUS.sm,
    paddingHorizontal: 6, paddingVertical: 2,
  },
  runtimeText: { color: '#fff', fontSize: 11, fontWeight: '700' },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, padding: SPACING.xl },
  emptyText: { color: c.textSecondary, fontSize: 14, textAlign: 'center' },
});
