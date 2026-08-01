import { View, Text, StyleSheet, TouchableOpacity, Modal, Dimensions, Animated, PanResponder } from 'react-native';
import { useEffect, useRef } from 'react';
import { Image as ExpoImage } from 'expo-image';
import { createAudioPlayer } from 'expo-audio';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ScreenOrientation from 'expo-screen-orientation';
import { RADIUS, SPACING, type ThemePalette } from '../constants/theme';
import { useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { openAdOptions } from '../contexts/AdOptionsContext';
import { adDestination, type AdMeta } from '../lib/ads';
import { openAdCta } from '../contexts/AdCtaContext';
import AppVideo from './AppVideo';

// Fullscreen, DISMISSABLE viewer for a Laybell TV ad — opened by tapping a
// sponsored card on the TV landing grid. Unlike the woven ads (landscape pager /
// cast), this one is OPTIONAL: the user chose to watch it, so it plays with
// sound and can be closed any time: the × button, or dragging the whole card
// down (story-style — it follows the finger and the grid re-emerges behind).
// Orientation is UNLOCKED while it's open, so a landscape creative can be
// watched fullscreen by simply turning the phone; closing restores the app's
// portrait lock.
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// media_url is null for SIMPLE SHOP ADS (listing cover + preview clip instead
// of a video — song_url carries the audio, thumbnail/cover the art).
export type TVAdViewerItem = { media_url: string | null; thumbnail_url?: string | null; cover_url?: string | null; song_url?: string | null; __ad?: AdMeta };

export default function TVAdViewer({ item, uid, onClose }: {
  item: TVAdViewerItem | null;
  uid: string | null;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const meta = item?.__ad;
  const progress = useRef(new Animated.Value(0)).current;

  // ── Swipe-down to exit ──────────────────────────────────────────────────────
  // The card rides the finger (translateY) while the backdrop thins so the TV
  // grid re-emerges behind; release past the threshold (or a real downward
  // fling) slides it off and closes, otherwise it springs back. Claims only
  // clearly-vertical downward MOVES, so the ×/CTA/report taps are untouched.
  //
  // A downward drag that STARTS in the middle-to-top half of the screen is
  // claimed via the CAPTURE phase so it wins even over the fullscreen video
  // (whose native view would otherwise swallow the touch) — that's the region
  // people naturally flick to toss the ad away. The bottom half is left to the
  // normal (non-capture) path so it never steals from the CTA / meta block.
  const translateY = useRef(new Animated.Value(0)).current;
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const dismissBySwipe = () => {
    Animated.timing(translateY, { toValue: SCREEN_H, duration: 200, useNativeDriver: true })
      .start(() => { translateY.setValue(0); closeRef.current(); });
  };
  const springBack = () =>
    Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
  const isDownSwipe = (g: { dy: number; dx: number }) => g.dy > 10 && g.dy > Math.abs(g.dx) * 1.2;
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    // Intercept top/middle-half downward drags before the video can grab them.
    onMoveShouldSetPanResponderCapture: (_e, g) => g.y0 < SCREEN_H * 0.5 && isDownSwipe(g),
    // Anywhere else, still allow the drag where no child claims it first.
    onMoveShouldSetPanResponder: (_e, g) => isDownSwipe(g),
    onPanResponderMove: (_e, g) => { if (g.dy > 0) translateY.setValue(g.dy); },
    onPanResponderRelease: (_e, g) => {
      if (g.dy > 120 || g.vy > 0.8) dismissBySwipe();
      else springBack();
    },
    onPanResponderTerminate: springBack,
  })).current;
  const backdropOpacity = translateY.interpolate({
    inputRange: [0, 420],
    outputRange: [1, 0.15],
    extrapolate: 'clamp',
  });

  // While open, the phone may rotate freely (TV creatives are usually
  // landscape); closing restores the app-wide portrait lock. Reset any
  // leftover drag offset from a previous viewing too.
  useEffect(() => {
    if (!item) return;
    translateY.setValue(0);
    ScreenOrientation.unlockAsync().catch(() => {});
    return () => { ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {}); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item]);

  // Simple shop ad soundtrack: the viewer is dismissable with no skip gate, so
  // the preview simply loops (like the video path) until closed.
  const isImageAd = !!item && !item.media_url && !!item.song_url;
  useEffect(() => {
    if (!isImageAd || !item?.song_url) return;
    let sub: { remove: () => void } | null = null;
    let player: ReturnType<typeof createAudioPlayer> | null = null;
    try {
      player = createAudioPlayer({ uri: item.song_url }, { updateInterval: 250, keepAudioSessionActive: true });
      player.loop = true;
      sub = player.addListener('playbackStatusUpdate', (st: any) => {
        if (!st?.isLoaded) return;
        const dur = (st.duration ?? 0) * 1000;
        if (dur > 0) progress.setValue(Math.min(1, ((st.currentTime ?? 0) * 1000) / dur));
      });
      player.play();
    } catch {}
    return () => {
      try { sub?.remove(); } catch {}
      const p = player;
      setTimeout(() => { try { p?.remove(); } catch {} }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isImageAd, item?.song_url]);

  const hasDestination = !!meta && !!adDestination({ __ad: meta });
  const onCta = () => { if (meta) openAdCta({ __ad: meta }, 'tv', uid); };
  const onReport = () => {
    if (meta) openAdOptions({ campaignId: meta.campaignId, creativeId: meta.creativeId, advertiserName: meta.advertiserName });
  };

  return (
    <Modal
      visible={!!item}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
      supportedOrientations={['portrait', 'landscape']}
    >
      {/* Backdrop thins as the card is dragged, revealing the grid behind. */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: backdropOpacity }]} />
      <Animated.View style={[styles.root, { transform: [{ translateY }] }]} {...pan.panHandlers}>
        {item?.media_url ? (
          <AppVideo
            source={{ uri: item.media_url }}
            style={StyleSheet.absoluteFill}
            contentFit="contain"
            active
            loop
            muted={false}
            poster={item.thumbnail_url ?? undefined}
            posterContentFit="contain"
            onProgress={(pos, dur) => { if (dur > 0) progress.setValue(Math.min(1, pos / dur)); }}
          />
        ) : isImageAd ? (
          // Simple shop ad: blurred cover backdrop + centered album-style art
          // while the preview clip plays.
          <>
            {!!(item?.thumbnail_url ?? item?.cover_url) && (
              <>
                <ExpoImage source={{ uri: (item!.thumbnail_url ?? item!.cover_url)! }} style={StyleSheet.absoluteFill} contentFit="cover" blurRadius={40} cachePolicy="memory-disk" />
                <View style={styles.simpleScrim} pointerEvents="none" />
                <View style={styles.simpleArtWrap} pointerEvents="none">
                  <ExpoImage source={{ uri: (item!.thumbnail_url ?? item!.cover_url)! }} style={styles.simpleArt} contentFit="cover" cachePolicy="memory-disk" />
                </View>
              </>
            )}
          </>
        ) : null}

        {/* Top bar: Sponsored tag + 3-dot report + close */}
        <View style={[styles.topBar, { top: insets.top + 8 }]}>
          <View style={styles.sponsoredTag}>
            <Ionicons name="megaphone" size={12} color="#fff" />
            <Text style={styles.sponsoredText}>{t('ad.sponsored')}</Text>
          </View>
          <View style={styles.topRight}>
            <TouchableOpacity style={styles.iconBtn} onPress={onReport} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} accessibilityRole="button" accessibilityLabel={t('a11y.moreOptions')}>
              <Ionicons name="ellipsis-horizontal" size={22} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity style={styles.iconBtn} onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} accessibilityRole="button" accessibilityLabel={t('a11y.close')}>
              <Ionicons name="close" size={24} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>

        {/* Bottom: advertiser + headline + CTA */}
        <LinearGradient colors={['transparent', 'rgba(0,0,0,0.8)']} style={styles.bottomFade} pointerEvents="none" />
        <View style={[styles.meta, { bottom: insets.bottom + 24 }]}>
          {!!meta?.advertiserName && <Text style={styles.advertiser} numberOfLines={1}>{meta.advertiserName}</Text>}
          {!!meta?.headline && <Text style={styles.headline} numberOfLines={2}>{meta.headline}</Text>}
          {!!meta?.body && <Text style={styles.body} numberOfLines={2}>{meta.body}</Text>}
          {hasDestination && (
            <TouchableOpacity style={styles.cta} onPress={onCta} activeOpacity={0.85}>
              <Text style={styles.ctaText}>{meta!.ctaLabel || t('reelAd.learnMore')}</Text>
              <Ionicons name="arrow-forward" size={15} color="#FFFFFF" />
            </TouchableOpacity>
          )}
        </View>

        {/* Video progress bar (imperative — no re-render per tick). */}
        <View style={[styles.progressTrack, { bottom: insets.bottom + 2 }]}>
          <Animated.View style={[styles.progressFill, { width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]} />
        </View>
      </Animated.View>
    </Modal>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  backdrop: { backgroundColor: '#000' },
  topBar: {
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
  iconBtn: {
    width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center', justifyContent: 'center',
  },
  progressTrack: { position: 'absolute', left: 0, right: 0, height: 3, backgroundColor: 'rgba(255,255,255,0.25)' },
  progressFill: { height: 3, backgroundColor: colors.primary },
  bottomFade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 240 },
  meta: { position: 'absolute', left: SPACING.md, right: SPACING.md, gap: SPACING.xs, maxWidth: SCREEN_W },
  advertiser: { color: '#fff', fontSize: 15, fontWeight: '800' },
  headline: { color: '#fff', fontSize: 16, fontWeight: '700', marginTop: 2 },
  body: { color: 'rgba(255,255,255,0.85)', fontSize: 13, lineHeight: 18 },
  cta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: colors.primary, borderRadius: RADIUS.full,
    paddingVertical: SPACING.sm + 2, marginTop: SPACING.sm,
  },
  // Fixed white (not colors.text): orange fill over a dark video — light
  // mode's near-black text read wrong there (same treatment as the other ads).
  ctaText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },

  // Simple shop ad staging (percent-sized: the modal rotates freely, so fixed
  // Dimensions would be the portrait capture).
  simpleScrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.35)' },
  simpleArtWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  simpleArt: {
    width: '72%', maxHeight: '62%', aspectRatio: 1, borderRadius: RADIUS.xl,
    backgroundColor: '#111',
    shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 24, shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
});
