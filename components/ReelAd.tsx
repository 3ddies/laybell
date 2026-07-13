import { View, Text, StyleSheet, TouchableOpacity, Dimensions, Image } from 'react-native';
import AppVideo from './AppVideo';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useRef, useState } from 'react';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
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
  insets: { top: number; bottom: number };
  onSkip: () => void;
  onCta: () => void;
  onOptions: () => void;
};

export default function ReelAd({ item, visible, paused, insets, onSkip, onCta, onOptions }: Props) {
  const { colors } = useTheme();
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
  const [secsRemaining, setSecsRemaining] = useState(Math.ceil(AD_SKIP_MS / 1000));

  const canSkip = secsRemaining <= 0;
  const secsLeft = Math.max(1, secsRemaining);

  return (
    <View style={{ width: SCREEN_W, height: SCREEN_H }}>
      <AppVideo
        source={{ uri: item.media_url }}
        style={StyleSheet.absoluteFill}
        contentFit={landscape ? 'contain' : 'cover'}
        loop
        active={visible && !paused}
        poster={poster}
        posterContentFit={landscape ? 'contain' : 'cover'}
        onProgress={(pos) => {
          const d = pos - lastPosRef.current;
          lastPosRef.current = pos;
          if (d > 0 && d < 2000) {
            elapsedRef.current += d;
            const s = Math.max(0, Math.ceil((AD_SKIP_MS - elapsedRef.current) / 1000));
            setSecsRemaining((prev) => (prev === s ? prev : s)); // renders ~1×/s, then never
          }
        }}
      />

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
          <TouchableOpacity style={styles.optionsBtn} onPress={onOptions} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="ellipsis-horizontal" size={20} color="#fff" />
          </TouchableOpacity>
        </View>
        {!!ad?.headline && <Text style={styles.headline} numberOfLines={2}>{ad.headline}</Text>}
        {!!ad?.body && <Text style={styles.body} numberOfLines={2}>{ad.body}</Text>}
        <TouchableOpacity style={styles.cta} onPress={onCta} activeOpacity={0.85}>
          <Text style={styles.ctaText}>{ad?.ctaLabel || t('reelAd.learnMore')}</Text>
          <Ionicons name="arrow-forward" size={15} color={colors.text} />
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
  ctaText: { color: colors.text, fontSize: 15, fontWeight: '800' },
});
