import { View, Text, StyleSheet, TouchableOpacity, Dimensions, Image } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import ReelVideo, { type ReelVideoHandle } from './ReelVideo';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { aspectToNumber } from '../lib/aspectRatio';
import { AD_SKIP_MS, type AdMeta } from '../lib/ads';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// A full-screen reel ad woven into the reel feed (lib/ads weaveReelAds). EXACTLY
// SCREEN_H tall so the reel FlatList's getItemLayout/paging stay valid. Shows a
// "Sponsored" label + advertiser, a CTA button, and a Skip button that unlocks
// after AD_SKIP_MS of genuine ad playback (countdown driven by the ad video's
// own position, so a buffering ad still requires the full 5s).

type Props = {
  item: any; // reel ad item: { media_url, aspect_ratio, thumbnail_url, __ad }
  visible: boolean;
  paused: boolean;
  // Same settle/linger/warm gating as ReelPage (reel/[id] renderItem): the
  // pooled player mounts only at rest or as the pre-buffered NEXT page —
  // never mid-swipe.
  mountPlayer: boolean;
  insets: { top: number; bottom: number };
  onSkip: () => void;
  onCta: () => void;
  onOptions: () => void;
  // Fired when the skip countdown crosses zero (canSkip flips) so the host can
  // release the reel swipe-lock at the exact moment the Skip button unlocks.
  onSkippableChange?: (canSkip: boolean) => void;
  // True when this ad was already watched/scrolled past — Skip is available
  // immediately and the countdown never runs (no restart on scroll-back).
  startSkippable?: boolean;
  // The creative played all the way through and the viewer never hit Skip — the
  // host rolls on to the next reel. This is a COMPLETION, not a user skip.
  onComplete?: () => void;
};

export default function ReelAd({ item, visible, paused, mountPlayer, insets, onSkip, onCta, onOptions, onSkippableChange, startSkippable = false, onComplete }: Props) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const ad: AdMeta = item.__ad;
  const landscape = aspectToNumber(item.aspect_ratio, 9 / 16) >= 1;
  const poster = item.thumbnail_url ?? item.cover_url ?? null;
  // Accumulated genuine playback (not instantaneous position) — the creative is
  // looping, so a clip shorter than 5s would otherwise wrap to 0 and never let
  // Skip unlock. Sum positive deltas; ignore the negative jump on loop-wrap.
  // Accumulates in a REF; state only changes when the DISPLAYED second flips —
  // the old per-tick setState re-rendered the ad subtree 4×/s, including during
  // the swipe frames into/out of the ad page.
  const elapsedRef = useRef(0);
  const lastPosRef = useRef(0);
  // Fires once when the creative wraps (= it played all the way through).
  const completedRef = useRef(false);
  // Already-seen ads start at 0 (Skip ready, no countdown); fresh ads count down.
  const [secsRemaining, setSecsRemaining] = useState(startSkippable ? 0 : Math.ceil(AD_SKIP_MS / 1000));

  const canSkip = secsRemaining <= 0;
  const secsLeft = Math.max(1, secsRemaining);

  // Tell the host when Skip unlocks (releases the swipe-lock in reel/[id]).
  useEffect(() => { onSkippableChange?.(canSkip); }, [canSkip]);

  // EVERY appearance of a sponsor restarts at 0. The player is pooled and the
  // same creative can fill more than one slot, so a second showing could hand
  // back a retained playhead — which desynced the skip countdown (elapsed no
  // longer matched what was on screen) and made the wrap-detector fire
  // immediately, auto-skipping the ad the moment it appeared.
  const videoRef = useRef<ReelVideoHandle>(null);
  useEffect(() => {
    if (!visible) return;
    try { videoRef.current?.seek(0); } catch {}
    lastPosRef.current = 0;
    elapsedRef.current = 0;
    completedRef.current = false;
    if (!startSkippable) setSecsRemaining(Math.ceil(AD_SKIP_MS / 1000));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, item.id]);
  // Un-warmed arrival (fast swipe onto the ad): the pooled player mounts at the
  // SETTLE, after the reset above ran against a null ref — so a same-creative
  // entry could hand back a retained mid-clip playhead and "complete" early.
  // Re-zero the playhead the moment the player exists. Deliberately does NOT
  // touch the countdown refs — genuine watched time keeps accruing.
  useEffect(() => {
    if (!visible || !mountPlayer) return;
    try { videoRef.current?.seek(0); } catch {}
    lastPosRef.current = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mountPlayer, visible]);

  return (
    <View style={{ width: SCREEN_W, height: SCREEN_H, backgroundColor: '#000' }}>
      {/* Poster ALWAYS underneath; the pooled surface stays opacity-0 until
          readyToPlay (still → motion, no black flash). POOLED player (reelPool):
          the old AppVideo CREATED an AVPlayer the moment this page entered the
          FlatList render window — i.e. mid-swipe while the previous reel was
          playing. That main-thread creation freeze is exactly what made reels
          "break" from the first ad position (page 3) onward. */}
      {poster ? (
        <ExpoImage
          source={{ uri: poster }}
          style={StyleSheet.absoluteFill}
          contentFit={landscape ? 'contain' : 'cover'}
          cachePolicy="memory-disk"
        />
      ) : null}
      {mountPlayer && !!item.media_url && (
        <ReelVideo
          ref={videoRef}
          id={item.id}
          uri={item.media_url}
          play={visible && !paused}
          muted={false}
          loop
          contentFit={landscape ? 'contain' : 'cover'}
          onProgress={(pos) => {
            const d = pos - lastPosRef.current;
            lastPosRef.current = pos;
            // A BACKWARD jump means the creative wrapped — it played all the way
            // through. The viewer never hit Skip, so roll on by ourselves instead
            // of leaving them parked on a looping ad. Counts as a COMPLETION.
            if (d < -500 && !completedRef.current) {
              completedRef.current = true;
              onComplete?.();
              return;
            }
            // Seen ad → Skip is already unlocked; never run the countdown again.
            if (startSkippable) return;
            if (d > 0 && d < 2000) {
              elapsedRef.current += d;
              const s = Math.max(0, Math.ceil((AD_SKIP_MS - elapsedRef.current) / 1000));
              setSecsRemaining((prev) => (prev === s ? prev : s)); // renders ~1×/s, then never
            }
          }}
        />
      )}

      {/* Sponsored label (top-left, below the back button area) */}
      <View style={[styles.sponsoredTag, { top: insets.top + 12 }]}>
        <Ionicons name="megaphone" size={11} color="#fff" />
        <Text style={styles.sponsoredText}>{t('ad.sponsored')}</Text>
      </View>

      {/* Skip (top-right) */}
      <TouchableOpacity
        style={[styles.skipBtn, { top: insets.top + 8 }]}
        onPress={onSkip}
        disabled={!canSkip}
        activeOpacity={0.8}
      >
        <Text style={styles.skipText}>{canSkip ? t('reelAd.skip') : t('reelAd.skipIn', { n: secsLeft })}</Text>
        {canSkip && <Ionicons name="play-skip-forward" size={14} color="#fff" />}
      </TouchableOpacity>

      <LinearGradient colors={['transparent', 'rgba(0,0,0,0.75)']} style={styles.bottomFade} pointerEvents="none" />

      {/* Brand + headline + CTA */}
      <View style={[styles.meta, { bottom: insets.bottom + 28 }]}>
        <View style={styles.brandRow}>
          {ad?.avatarUrl ? (
            <Image source={{ uri: ad.avatarUrl }} style={styles.brandAvatar} />
          ) : (
            <View style={styles.brandAvatar}><Text style={styles.brandInitial}>{(ad?.advertiserName || 'S').charAt(0).toUpperCase()}</Text></View>
          )}
          <Text style={styles.brandName} numberOfLines={1}>{ad?.advertiserName || t('ad.sponsored')}</Text>
          <TouchableOpacity style={styles.optionsBtn} onPress={onOptions} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} accessibilityRole="button" accessibilityLabel={t('a11y.moreOptions')}>
            <Ionicons name="ellipsis-horizontal" size={20} color="#fff" />
          </TouchableOpacity>
        </View>
        {!!ad?.headline && <Text style={styles.headline} numberOfLines={2}>{ad.headline}</Text>}
        {!!ad?.body && <Text style={styles.body} numberOfLines={2}>{ad.body}</Text>}
        <TouchableOpacity style={styles.cta} onPress={onCta} activeOpacity={0.85}>
          <Text style={styles.ctaText}>{ad?.ctaLabel || t('reelAd.learnMore')}</Text>
          <Ionicons name="arrow-forward" size={15} color="#FFFFFF" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  sponsoredTag: {
    position: 'absolute', left: SPACING.md,
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.sm, paddingVertical: 4,
  },
  sponsoredText: { color: '#fff', fontSize: 11, fontWeight: '700', letterSpacing: 0.3 },

  skipBtn: {
    position: 'absolute', right: SPACING.md,
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.md, paddingVertical: 7,
  },
  skipText: { color: '#fff', fontSize: 13, fontWeight: '700' },

  bottomFade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 260 },

  meta: { position: 'absolute', left: SPACING.md, right: SPACING.md, gap: SPACING.xs },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  brandAvatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  brandInitial: { color: '#fff', fontSize: 14, fontWeight: '800' },
  brandName: { color: '#fff', fontSize: 15, fontWeight: '700', flexShrink: 1 },
  optionsBtn: { marginLeft: 'auto', padding: 4 },
  headline: { color: '#fff', fontSize: 16, fontWeight: '800', marginTop: 2 },
  body: { color: 'rgba(255,255,255,0.85)', fontSize: 13, lineHeight: 18 },
  cta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: colors.primary, borderRadius: RADIUS.full,
    paddingVertical: SPACING.sm + 2, marginTop: SPACING.sm,
  },
  // Fixed white (not colors.text): the button sits on the orange brand fill
  // over a dark video — light mode's near-black text read wrong there.
  ctaText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
});
