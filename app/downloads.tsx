import {
  View, Text, StyleSheet, TouchableOpacity, FlatList,
  ActivityIndicator, Alert,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { coverFade } from '../lib/coverFade';
import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { useOffline } from '../contexts/OfflineContext';
import { useDownloadAction } from '../hooks/useDownloadAction';
import { useAudio } from '../contexts/AudioContext';
import SwipeBackPager from '../components/SwipeBackPager';
import { clearAllOffline, OFFLINE_BYTE_CAP, type OfflineEntry } from '../lib/offline';
import { formatBytes } from '../lib/format';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';

// Settings → Downloads: manage everything saved for offline playback. The list
// shows the user's pinned tracks (source==='pinned'); a header meter tracks usage
// against the 3 GB device cap and the tier's count allowance. The offline engine
// (lib/offline.ts) is the single source of truth — this screen just renders its
// entries and routes taps through the shared play / remove affordances.
export default function DownloadsScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { t } = useTranslation();
  const { entries, pinnedCount, usageBytes, pinLimit, isOffline, reconcileOnline } = useOffline();
  const { confirmRemove } = useDownloadAction();
  const { play } = useAudio();

  // On open, re-check cached tracks against the server so opted-out / deleted /
  // re-uploaded songs get purged from the list (best-effort; no-ops offline).
  useEffect(() => { reconcileOnline().catch(() => {}); }, [reconcileOnline]);

  const downloads = entries.filter((e) => e.source === 'pinned');
  // Newest first — same recency feel as the rest of the app's lists.
  const sorted = [...downloads].sort((a, b) => b.addedAt - a.addedAt);

  const meterFraction = Math.max(0, Math.min(1, usageBytes / OFFLINE_BYTE_CAP));

  function confirmRemoveAll() {
    Alert.alert(
      t('offline.removeAllConfirmTitle'),
      t('offline.removeAllConfirmBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('offline.removeAction'), style: 'destructive', onPress: () => { clearAllOffline(); } },
      ],
    );
  }

  function renderRow({ item }: { item: OfflineEntry }) {
    const downloading = item.state === 'downloading';
    return (
      <TouchableOpacity
        style={styles.row}
        activeOpacity={0.7}
        disabled={downloading}
        onPress={() => play({ id: item.postId, uri: item.mediaUrl, caption: item.title, artist: item.artist, cover: item.cover })}
      >
        <View style={styles.coverWrap}>
          {item.cover ? (
            <ExpoImage source={{ uri: item.cover }} style={styles.cover} contentFit="cover" cachePolicy="memory-disk" transition={coverFade(item.cover)} />
          ) : (
            <LinearGradient colors={GRADIENTS.primarySoft as any} style={styles.cover}>
              <Ionicons name="musical-notes" size={18} color={colors.primary} />
            </LinearGradient>
          )}
        </View>
        <View style={styles.rowInfo}>
          <Text style={styles.rowName} numberOfLines={1}>{item.title}</Text>
          {downloading ? (
            <View style={styles.downloadingRow}>
              <ActivityIndicator size="small" color={colors.textTertiary} />
              <Text style={styles.rowMeta} numberOfLines={1}>{t('offline.downloading')}</Text>
            </View>
          ) : (
            <Text style={styles.rowMeta} numberOfLines={1}>{item.artist}</Text>
          )}
        </View>
        <TouchableOpacity
          style={styles.removeBtn}
          onPress={() => confirmRemove(item.postId, item.title)}
          hitSlop={6}
          accessibilityLabel={t('offline.remove')}
        >
          <Ionicons name="trash-outline" size={18} color={colors.textTertiary} />
        </TouchableOpacity>
      </TouchableOpacity>
    );
  }

  return (
    // Swipe right anywhere to slide the whole page off — same feel as the rest
    // of the app (route registered as a transparent modal).
    <SwipeBackPager>
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('offline.downloadsTitle')}</Text>
        {isOffline ? (
          <View style={styles.offlineChip} accessibilityLabel={t('offline.offlineBadge')}>
            <Ionicons name="cloud-offline-outline" size={13} color={colors.textTertiary} />
            <Text style={styles.offlineChipText}>{t('offline.offlineBadge')}</Text>
          </View>
        ) : (
          <View style={{ width: 40 }} />
        )}
      </View>

      <FlatList
        data={sorted}
        keyExtractor={(e) => e.postId}
        renderItem={renderRow}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <View style={styles.summaryCard}>
            <View style={styles.summaryTextRow}>
              <Text style={styles.summaryUsage}>{t('offline.storageUsed', { size: formatBytes(usageBytes) })}</Text>
              <Text style={styles.summaryCount}>{t('offline.countOfLimit', { count: pinnedCount, limit: pinLimit })}</Text>
            </View>
            <View
              style={styles.meterTrack}
              accessibilityRole="progressbar"
              accessibilityValue={{ now: Math.round(meterFraction * 100), min: 0, max: 100 }}
            >
              <View style={[styles.meterFill, { width: `${meterFraction * 100}%` }]} />
            </View>
          </View>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="cloud-download-outline" size={48} color={colors.textTertiary} />
            <Text style={styles.emptyTitle}>{t('offline.empty')}</Text>
            <Text style={styles.emptyBody}>{t('offline.emptyBody')}</Text>
          </View>
        }
        ListFooterComponent={
          sorted.length > 0 ? (
            <TouchableOpacity style={styles.removeAllBtn} onPress={confirmRemoveAll} activeOpacity={0.7}>
              <Ionicons name="trash-outline" size={18} color={colors.error} />
              <Text style={styles.removeAllText}>{t('offline.removeAll')}</Text>
            </TouchableOpacity>
          ) : null
        }
      />
    </View>
    </SwipeBackPager>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  offlineChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: SPACING.sm, paddingVertical: 4, borderRadius: RADIUS.full, backgroundColor: colors.surfaceLight },
  offlineChipText: { color: colors.textTertiary, fontSize: 11, fontWeight: '700' },
  content: { padding: SPACING.md, paddingBottom: SPACING.xxl },

  summaryCard: {
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.lg, padding: SPACING.md, gap: SPACING.sm, marginBottom: SPACING.md,
  },
  summaryTextRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.sm },
  summaryUsage: { color: colors.text, fontSize: 14, fontWeight: '700' },
  summaryCount: { color: colors.textTertiary, fontSize: 12 },
  meterTrack: {
    height: 8, borderRadius: RADIUS.full, backgroundColor: colors.border, overflow: 'hidden',
  },
  meterFill: { height: 8, borderRadius: RADIUS.full, backgroundColor: colors.primary },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    paddingVertical: SPACING.sm,
  },
  coverWrap: { width: 48, height: 48, borderRadius: RADIUS.sm, overflow: 'hidden' },
  cover: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceLight },
  rowInfo: { flex: 1 },
  rowName: { color: colors.text, fontSize: 14.5, fontWeight: '700' },
  rowMeta: { color: colors.textTertiary, fontSize: 12, marginTop: 2 },
  downloadingRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, marginTop: 2 },
  removeBtn: { padding: SPACING.xs },

  empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: SPACING.xxl * 2, gap: SPACING.sm },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '700', marginTop: SPACING.sm },
  emptyBody: { color: colors.textTertiary, fontSize: 13, lineHeight: 18, textAlign: 'center', paddingHorizontal: SPACING.lg },

  removeAllBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm,
    marginTop: SPACING.lg, paddingVertical: SPACING.md,
    borderRadius: RADIUS.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceLight,
  },
  removeAllText: { color: colors.error, fontSize: 14, fontWeight: '700' },
});
