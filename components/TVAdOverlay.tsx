import { View, Text, StyleSheet, TouchableOpacity, Animated } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { createAudioPlayer } from 'expo-audio';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useRef, useState } from 'react';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { adDestination, adSkipAfterMs, type AdMeta } from '../lib/ads';
import AppVideo from './AppVideo';

// A full-screen Laybell TV ad interstitial COVER in the landscape mode.
// Honors the advertiser's skip mode: 'unskippable' plays fully (unlocks the
// sideways swipe only when it finishes), 'skip15' unlocks + shows a Skip button
// after 15s, 'skip10' (simple shop ads) after 10s. Draws a progress bar + a
// 3-dot Report button.
//
// Two creative shapes: a landscape VIDEO, or a SIMPLE SHOP AD — the listing
// cover letterboxed like album art over a blurred backdrop, with the listing's
// preview clip as the soundtrack on a dedicated expo-audio player.
export default function TVAdOverlay({ item, active, insets, onDone, onSkip, onReport, onCta }: {
  item: any;
  active: boolean;
  insets: { top: number; bottom: number };
  onDone: (id: string) => void;   // played through → host dismisses + advances
  onSkip: () => void;             // skippable modes only: user skipped after the countdown
  onReport: () => void;           // open the ad options / report sheet
  onCta: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const ad: AdMeta = item.__ad;
  // Simple shop ad: reelItemFor/tvItemFor null media_url and carry the preview
  // in song_url; the cover art lives in thumbnail/cover_url.
  const isImageAd = !item.media_url && !!item.song_url;
  const poster = item.thumbnail_url ?? item.cover_url ?? null;
  // TV gate: Infinity (unskippable, the default) | 11s ('skip15') | 10s ('skip10').
  const gateMs = adSkipAfterMs('tv', ad?.skipMode);
  const skippable = Number.isFinite(gateMs);
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
  const [secsRemaining, setSecsRemaining] = useState(skippable ? Math.ceil((gateMs as number) / 1000) : 0);
  // Only a skippable sponsor shows the button, and only after its countdown. An
  // 'unskippable' one plays through — it simply never returns once its slot is
  // spent, so there's no need for a re-watch escape hatch.
  const canSkip = skippable && secsRemaining <= 0;
  const showSkipBtn = skippable;

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
  // Shared by the video's onProgress and the simple-ad audio player's ticks.
  const onProgress = (posMs: number, durMs: number) => {
    if (durMs > 0) progress.setValue(Math.min(1, posMs / durMs));
    // Skippable modes: countdown to the Skip button (unskippable ads have none).
    if (skippable) {
      const remain = Math.max(0, Math.ceil(((gateMs as number) - posMs) / 1000));
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
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;

  // ── Simple shop ad soundtrack ────────────────────────────────────────────────
  // Dedicated expo-audio player for the listing preview (there's no video to
  // carry sound). Same status→onProgress flow as the video path, so the
  // countdown, progress bar, end timer and wrap detection all just work.
  const audioPlayerRef = useRef<ReturnType<typeof createAudioPlayer> | null>(null);
  useEffect(() => {
    if (!isImageAd) return;
    let sub: { remove: () => void } | null = null;
    try {
      const player = createAudioPlayer({ uri: item.song_url }, { updateInterval: 250, keepAudioSessionActive: true });
      audioPlayerRef.current = player;
      sub = player.addListener('playbackStatusUpdate', (st: any) => {
        if (!st?.isLoaded) return;
        if (st.didJustFinish) { finish(); return; }
        onProgressRef.current((st.currentTime ?? 0) * 1000, (st.duration ?? 0) * 1000);
      });
      player.play();
    } catch {}
    return () => {
      try { sub?.remove(); } catch {}
      const p = audioPlayerRef.current;
      audioPlayerRef.current = null;
      // Silence synchronously; release next tick (a lagging remove() must
      // never leave ad audio running after the cover is dismissed).
      try { p?.pause(); } catch {}
      setTimeout(() => { try { p?.remove(); } catch {} }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isImageAd, item.id]);
  // Pause/resume with the cover's `active` flag (screen blur while it's up).
  useEffect(() => {
    const p = audioPlayerRef.current;
    if (!p) return;
    try { if (active) p.play(); else p.pause(); } catch {}
  }, [active]);

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
        {isImageAd ? (
          // Simple shop ad: blurred cover fills the landscape screen, crisp
          // cover centered like album art; the preview clip carries the sound.
          <>
            {!!poster && (
              <ExpoImage source={{ uri: poster }} style={StyleSheet.absoluteFill} contentFit="cover" blurRadius={40} cachePolicy="memory-disk" />
            )}
            <View style={styles.simpleScrim} pointerEvents="none" />
            {!!poster && (
              <View style={styles.simpleArtWrap} pointerEvents="none">
                <ExpoImage source={{ uri: poster }} style={styles.simpleArt} contentFit="cover" cachePolicy="memory-disk" />
              </View>
            )}
          </>
        ) : (
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
        )}
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
          <TouchableOpacity style={styles.optBtn} onPress={onReport} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} accessibilityRole="button" accessibilityLabel={t('a11y.moreOptions')}>
            <Ionicons name="ellipsis-horizontal" size={20} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>

      <LinearGradient colors={['transparent', 'rgba(0,0,0,0.75)']} style={styles.bottomFade} pointerEvents="none" />
      <View style={[styles.meta, { bottom: insets.bottom + 22 }]}>
        {!!ad?.advertiserName && <Text style={styles.brand} numberOfLines={1}>{ad.advertiserName}</Text>}
        {!!ad?.headline && <Text style={styles.headline} numberOfLines={2}>{ad.headline}</Text>}
        {/* Gate on the resolved DESTINATION, not ctaUrl — profile/shop/product
            ads have no URL, so their button never rendered here. */}
        {!!adDestination(item) && (
          <TouchableOpacity style={styles.cta} onPress={onCta} activeOpacity={0.85}>
            <Text style={styles.ctaText}>{ad.ctaLabel || t('reelAd.learnMore')}</Text>
            <Ionicons name="arrow-forward" size={15} color="#FFFFFF" />
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
  // Fixed white (not colors.text): orange fill over a dark video — light
  // mode's near-black text read wrong there.
  ctaText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  progressTrack: { position: 'absolute', left: 0, right: 0, height: 3, backgroundColor: 'rgba(255,255,255,0.25)' },
  progressFill: { height: 3, backgroundColor: colors.primary },

  // Simple shop ad staging (blurred backdrop + centered album-style art).
  // Sized by percentage of the PARENT (absoluteFill) — Dimensions.get here
  // would be the portrait capture (see the component's own sizing note).
  simpleScrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.35)' },
  simpleArtWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  simpleArt: {
    height: '62%', aspectRatio: 1, borderRadius: RADIUS.xl,
    backgroundColor: '#111',
    shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 24, shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
});
