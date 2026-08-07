import { View, Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Spinner from './Spinner';
import { useUploadEta, useEncodeEta, formatEta, overallProgress, useSmoothProgress } from './uploadEta';
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

// ── Where it sits ─────────────────────────────────────────────────────────────
// TOP, under the status bar (owner's call). It was briefly bottom-docked with
// the mini player and cast bar, but that edge already carries the tab bar and
// two pieces of chrome; up here the banner has the row to itself and reads as a
// notification rather than another control.
//
// The tab screens DO have chrome up here though — Home's header (logo, LIVE,
// notifications, messages) starts 56px down and runs to roughly 98px, so a
// banner at `insets.top + 8` landed straight across those buttons. They stayed
// tappable (this view is pointerEvents:none) but were hidden, which is its own
// kind of broken. On tab routes the banner therefore clears the header instead
// of overlapping it; pushed screens have no such bar and keep the higher spot.
const TAB_HEADER_BOTTOM = 104; // Home header bottom (~98) + breathing room

export default function UploadProgressBanner({ progress, isFilm, stage, slowLink, durationSec, belowHeader }: {
  /** Compress fraction (preparing), byte progress (uploading), or encode progress (processing) — all 0-1. */
  progress: number;
  isFilm: boolean;
  stage: UploadBannerStage;
  /** Measured throughput says the connection is the bottleneck. */
  slowLink?: boolean;
  /** The post's play length — the prior for the encode-time estimate. */
  durationSec?: number;
  /** True on the main tab screens, which have their own header row up top. */
  belowHeader?: boolean;
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
  // ONE climb across all three stages for a film — the banner and the in-feed
  // card must never disagree about how far along the same upload is.
  const rawOverall = isFilm
    ? overallProgress(stage === 'processing' ? 'processing' : stage, progress, progress * 100)
    : progress;
  // Same smoother as the in-feed card, so the two surfaces move identically.
  const smooth = useSmoothProgress(rawOverall, stage);
  const overall = isFilm ? smooth : rawOverall;
  const right = etaText ?? (overall > 0 ? `${Math.round(overall * 100)}%` : null);

  return (
    <View
      style={[styles.wrap, { top: belowHeader ? TAB_HEADER_BOTTOM : insets.top + 8 }]}
      pointerEvents="none"
    >
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
          <View style={[styles.fill, { width: `${Math.round(Math.min(1, overall) * 100)}%` }]} />
        </View>
      </View>
    </View>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  // zIndex 69 keeps it under the failure banner (70), which takes the same slot
  // when an upload fails, and above ordinary content.
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
