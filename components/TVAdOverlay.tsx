import { View, Text, StyleSheet, TouchableOpacity, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useRef, useState } from 'react';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { AD_SKIP15_MS, type AdMeta } from '../lib/ads';
import AppVideo from './AppVideo';

// A full-screen Laybell TV ad interstitial COVER in the landscape mode.
// Honors the advertiser's skip mode: 'unskippable' plays fully (unlocks the
// sideways swipe only when it finishes), 'skip15' unlocks + shows a Skip button
// after 15s. Draws a video progress bar + a 3-dot Report button.
export default function TVAdOverlay({ item, active, insets, onDone, onSkip, onReport, onCta }: {
  item: any;
  active: boolean;
  insets: { top: number; bottom: number };
  onDone: (id: string) => void;   // played through → host dismisses + advances
  onSkip: () => void;             // skip15 only: user skipped after the countdown
  onReport: () => void;           // open the ad options / report sheet
  onCta: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const ad: AdMeta = item.__ad;
  const isSkip15 = ad?.skipMode === 'skip15';
  const progress = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(0)).current; // gentle fade-in on appear
  useEffect(() => { Animated.timing(fade, { toValue: 1, duration: 200, useNativeDriver: true }).start(); }, []);
  const doneRef = useRef(false);
  const lastPosRef = useRef(0);
  const endTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armedRef = useRef(false);
  // Timers must never call a stale onDone.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const [secsRemaining, setSecsRemaining] = useState(isSkip15 ? Math.ceil(AD_SKIP15_MS / 1000) : 0);
  // Only a 'skip15' sponsor is skippable, and only after its countdown. An
  // 'unskippable' one plays through — it simply never returns once its slot is
  // spent, so there's no need for a re-watch escape hatch.
  const canSkip = isSkip15 && secsRemaining <= 0;
  const showSkipBtn = isSkip15;

  // Fires exactly once, from whichever end-signal lands first.
  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (endTimerRef.current) { clearTimeout(endTimerRef.current); endTimerRef.current = null; }
    onDoneRef.current(item.id);
  };

  // HARD SAFETY: an unskippable sponsor must never be able to trap the viewer.
  // If progress events stall (or never arrive), guarantee an end anyway. Replaced
  // with a tight, duration-accurate timer as soon as we learn the real length.
  useEffect(() => {
    endTimerRef.current = setTimeout(finish, 60_000);
    return () => { if (endTimerRef.current) clearTimeout(endTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // NOTE: pos/dur arrive in MILLISECONDS (AppVideo emits currentTimeMs/durationMs).
  const onProgress = (posMs: number, durMs: number) => {
    if (durMs > 0) progress.setValue(Math.min(1, posMs / durMs));
    // skip15: countdown to the Skip button (unskippable ads have none).
    if (isSkip15) {
      const remain = Math.max(0, Math.ceil((AD_SKIP15_MS - posMs) / 1000));
      setSecsRemaining((prev) => (prev === remain ? prev : remain)); // ~1×/s
    }
    // Once the true duration is known, arm a precise end timer as a backstop.
    if (durMs > 0 && !armedRef.current) {
      armedRef.current = true;
      if (endTimerRef.current) clearTimeout(endTimerRef.current);
      endTimerRef.current = setTimeout(finish, Math.max(600, (durMs - posMs) + 1200));
    }
    // Did it play through? Accept EITHER signal — a single near-end sample is easy
    // to miss at ~4 ticks/sec, and `loop` snaps pos back to 0 at the end, so a
    // BACKWARD jump is the most reliable "a full play completed" marker.
    const wrapped = posMs < lastPosRef.current - 1000;
    lastPosRef.current = posMs;
    if (wrapped || (durMs > 0 && posMs >= durMs - 500)) finish();
  };

  return (
    <Animated.View
      // FILL the parent (the landscape fsOverlay) — do NOT use fixed Dimensions:
      // Dimensions.get('window') is captured at module load in PORTRAIT, so in
      // landscape it sized the cover as a small portrait box (video stuck in the
      // corner). absoluteFill always matches the current landscape screen.
      style={[StyleSheet.absoluteFill, { backgroundColor: '#000', opacity: fade }]}
      // Touch SINK: claim any touch/swipe that isn't on a button so nothing leaks
      // through to the pager underneath (this is what makes the ad unskippable —
      // no pager scroll manipulation needed).
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
    >
      <TouchableOpacity activeOpacity={1} style={StyleSheet.absoluteFill} onPress={() => {}}>
        <AppVideo
          source={{ uri: item.media_url }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          loop
          active={active}
          muted={false}
          poster={item.thumbnail_url ?? undefined}
          posterContentFit="contain"
          // Always from the top: the same creative can appear in more than one
          // slot, and a retained playhead would desync the countdown and make the
          // wrap-detector fire the instant it opened.
          startPositionSec={0}
          onProgress={onProgress}
        />
      </TouchableOpacity>

      {/* Top row: Sponsored + (Skip when eligible) + 3-dot report */}
      <View style={[styles.topRow, { top: insets.top + 10 }]}>
        <View style={styles.sponsoredTag}>
          <Ionicons name="megaphone" size={12} color="#fff" />
          <Text style={styles.sponsoredText}>{t('ad.sponsored')}</Text>
        </View>
        <View style={styles.topRight}>
          {showSkipBtn && (
            <TouchableOpacity style={styles.skipBtn} disabled={!canSkip} onPress={onSkip} activeOpacity={0.8}>
              <Text style={styles.skipText}>{canSkip ? t('reelAd.skip') : t('reelAd.skipIn', { n: Math.max(1, secsRemaining) })}</Text>
              {canSkip && <Ionicons name="play-skip-forward" size={14} color="#fff" />}
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.optBtn} onPress={onReport} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="ellipsis-horizontal" size={20} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>

      <LinearGradient colors={['transparent', 'rgba(0,0,0,0.75)']} style={styles.bottomFade} pointerEvents="none" />
      <View style={[styles.meta, { bottom: insets.bottom + 22 }]}>
        {!!ad?.advertiserName && <Text style={styles.brand} numberOfLines={1}>{ad.advertiserName}</Text>}
        {!!ad?.headline && <Text style={styles.headline} numberOfLines={2}>{ad.headline}</Text>}
        {!!ad?.ctaUrl && (
          <TouchableOpacity style={styles.cta} onPress={onCta} activeOpacity={0.85}>
            <Text style={styles.ctaText}>{ad.ctaLabel || t('reelAd.learnMore')}</Text>
            <Ionicons name="arrow-forward" size={15} color={colors.text} />
          </TouchableOpacity>
        )}
      </View>

      {/* Video progress bar (imperative — never re-renders on tick). */}
      <View style={[styles.progressTrack, { bottom: insets.bottom + 2 }]}>
        <Animated.View style={[styles.progressFill, { width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]} />
      </View>
    </Animated.View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  topRow: {
    position: 'absolute', left: SPACING.md, right: SPACING.md,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  sponsoredTag: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.sm, paddingVertical: 4,
  },
  sponsoredText: { color: '#fff', fontSize: 12, fontWeight: '700', letterSpacing: 0.3 },
  topRight: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  skipBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.md, paddingVertical: 6,
  },
  skipText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  optBtn: {
    width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center', justifyContent: 'center',
  },
  bottomFade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 200 },
  meta: { position: 'absolute', left: SPACING.md, right: SPACING.md, gap: 4 },
  brand: { color: '#fff', fontSize: 16, fontWeight: '800' },
  headline: { color: '#fff', fontSize: 15, fontWeight: '600' },
  cta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: colors.primary, borderRadius: RADIUS.full,
    paddingVertical: SPACING.sm + 2, marginTop: SPACING.xs, alignSelf: 'flex-start',
    paddingHorizontal: SPACING.lg,
  },
  ctaText: { color: colors.text, fontSize: 15, fontWeight: '800' },
  progressTrack: { position: 'absolute', left: 0, right: 0, height: 3, backgroundColor: 'rgba(255,255,255,0.25)' },
  progressFill: { height: 3, backgroundColor: colors.primary },
});
