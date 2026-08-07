import { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import TVVideoList from '../components/TVVideoList';
import { fetchFilms } from '../lib/tv';
import { useProfile } from '../contexts/ProfileContext';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { useCast } from '../contexts/CastContext';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';

// The Films destination — everything the Laybell TV shelf only teases.
//
// It deliberately reuses TVVideoList rather than reimplementing a grid: tile
// geometry, the runtime chip, tap-to-play, long-press options, cast and delete
// all already live there and must behave identically in both places. Passing
// the films through `featured`/`posts` would render them as ordinary TV videos,
// so they go through `films` — the wide poster treatment IS the point.

export default function FilmsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { profile } = useProfile();
  const cast = useCast();

  const [films, setFilms] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      // A generous limit: this is the full catalogue view, not a shelf.
      setFilms(await fetchFilms(profile?.id ?? null, 60));
    } catch { /* offline — keep whatever is on screen */ }
  }, [profile?.id]);

  useEffect(() => { load().finally(() => setLoading(false)); }, [load]);

  return (
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
        <View style={styles.titleWrap}>
          <View style={styles.titleIcon}>
            <Ionicons name="film" size={15} color={colors.primary} />
          </View>
          <Text style={styles.title}>{t('tv.films')}</Text>
        </View>
        {/* Balances the back chevron so the title stays optically centred. */}
        <View style={styles.headerSpacer} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      ) : films.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="film-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyText}>{t('films.empty')}</Text>
        </View>
      ) : (
        <TVVideoList
          posts={[]}
          featured={[]}
          films={films}
          currentUserId={profile?.id ?? null}
          refreshing={refreshing}
          onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
          bottomPad={insets.bottom + SPACING.lg}
          emptyText={t('films.empty')}
          castActive={cast.connected}
          castingId={cast.current?.id ?? null}
          onPostDeleted={(id) => setFilms((prev) => prev.filter((p) => p.id !== id))}
        />
      )}
    </View>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
  },
  titleWrap: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  titleIcon: {
    width: 26, height: 26, borderRadius: 13,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.primary + '1F',
  },
  title: { color: c.text, fontSize: 20, fontWeight: '900', letterSpacing: 0.2 },
  headerSpacer: { width: 26 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, padding: SPACING.xl },
  emptyText: { color: c.textSecondary, fontSize: 14, textAlign: 'center' },
});
