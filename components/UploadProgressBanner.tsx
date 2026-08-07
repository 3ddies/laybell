import { View, Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Spinner from './Spinner';
import { useUploadEta, useEncodeEta, formatEta } from './uploadEta';
import { RADIUS, SPACING, type ThemePalette } from '../constants/theme';
import { useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

// Persistent upload status, visible ANYWHERE in the app while a video is still
// leaving the phone. The in-feed pending card only helps if you're looking at
// the top of the feed; a film uploads for tens of minutes while the user
// scrolls, and an invisible upload reads as no upload. This is also the
// stay-here warning: leaving the app pauses the upload (the post survives as
// a draft + the transferred bytes are resumable, but "keep it open" is the
// happy path).
//
// Deliberately not dismissible — it IS the status, and it removes itself the
// moment the upload finishes. pointerEvents="none" so it never eats a tap.
export type UploadBannerStage = 'preparing' | 'uploading' | 'processing';

export default function UploadProgressBanner({ progress, isFilm, stage, slowLink, durationSec }: {
  /** Compress fraction (preparing), byte progress (uploading), or encode progress (processing) — all 0-1. */
  progress: number;
  isFilm: boolean;
  stage: UploadBannerStage;
  /** Measured throughput says the connection is the bottleneck. */
  slowLink?: boolean;
  /** The post's play length — the prior for the encode-time estimate. */
  durationSec?: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  // Upload runs on measured byte throughput; encode runs on a length-based
  // prior that measured speed can only lengthen (see uploadEta.ts) — with an
  // "Almost done…" tail instead of a number pct can't back up. The preparing
  // stage is device-bound and fairly linear: a percent is honest enough.
  const uploadEtaSec = useUploadEta(progress, stage === 'uploading');
  const encodeEtaSec = useEncodeEta(progress, stage === 'processing', durationSec ?? 0);
  const etaText = stage === 'processing'
    ? (progress >= 0.95 || (encodeEtaSec != null && encodeEtaSec < 60)
        ? t('upload.almostDone')
        : formatEta(t, encodeEtaSec))
    : stage === 'uploading' ? formatEta(t, uploadEtaSec) : null;
  const title = stage === 'processing'
    ? t('upload.processingFilm')
    : stage === 'preparing'
      ? t('upload.preparingFilm')
      : t(isFilm ? 'upload.bannerFilm' : 'upload.bannerVideo');
  const right = etaText ?? (progress > 0 ? `${Math.round(progress * 100)}%` : null);

  return (
    <View style={[styles.wrap, { top: insets.top + 8 }]} pointerEvents="none">
      <View style={styles.card}>
        <View style={styles.row}>
          <Spinner size={16} thickness={2} />
          <Text style={styles.text} numberOfLines={1}>{title}</Text>
          {right && <Text style={styles.eta}>{right}</Text>}
        </View>
        {stage === 'uploading' && slowLink && (
          <Text style={styles.slow} numberOfLines={1}>{t('upload.slowLink')}</Text>
        )}
        {/* Real progress as a hairline along the card's bottom edge — the same
            language the pending card speaks. */}
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${Math.round(Math.min(1, progress) * 100)}%` }]} />
        </View>
      </View>
    </View>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  wrap: { position: 'absolute', left: SPACING.md, right: SPACING.md, zIndex: 69 },
  card: {
    backgroundColor: c.surfaceElevated,
    borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: c.border,
    overflow: 'hidden',
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 8,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md,
  },
  text: { flex: 1, color: c.text, fontSize: 13.5, fontWeight: '600' },
  eta: { color: c.textSecondary, fontSize: 12.5, fontWeight: '600' },
  slow: { color: c.textSecondary, fontSize: 12, paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm, marginTop: -2 },
  // White fill (owner call 2026-08-05); the mid-grey track keeps it readable on
  // the light theme's pale card, where pure white alone would vanish.
  track: { height: 2, backgroundColor: 'rgba(125,125,125,0.35)' },
  fill: { height: 2, backgroundColor: '#fff' },
});
