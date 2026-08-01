import { View, Text, TouchableOpacity, StyleSheet, Animated, Platform } from 'react-native';
// expo-image: memory-caches decoded covers so the bar art paints instantly.
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { feedChrome } from '../lib/feedChrome';
import { useEffect, useRef, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { useAudio, useAudioPosition } from '../contexts/AudioContext';
import { adDestination, AUDIO_AD_SKIP_MS } from '../lib/ads';
import { openAdCta } from '../contexts/AdCtaContext';
import { fetchFeatures, type Feature } from '../lib/features';
import SongCardTitle from './SongCardTitle';
import { useListenMode } from '../contexts/ListenModeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { SPACING, RADIUS, GRADIENTS, SHADOWS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useCast } from '../contexts/CastContext';
import { Ionicons } from '@expo/vector-icons';
import Scrubber from './Scrubber';

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// 'bar'     — the normal bottom-docked player.
// 'compact' — Create tab: small top-right card (1.5s dwell, per spec).
// 'side'    — story camera: simplified right-edge chip (cover + play/pause
//             only) so the viewfinder stays clear while the song rides along.
type PlayerVariant = 'bar' | 'compact' | 'side';

export default function MiniPlayer({ variant = 'bar', bottomDock = false }: { variant?: PlayerVariant; bottomDock?: boolean }) {
  const { colors, mode } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { currentTrack, isPlaying, isBuffering, pause, resume, stop, seekTo, expanded, expand, adState, skipAudioAd } = useAudio();
  const { positionMs, durationMs } = useAudioPosition(); // tick subscription (4×/sec) — small tree, cheap
  const insets = useSafeAreaInsets();
  // When a Laybell TV session is live, the CastBar takes the now-playing slot
  // (see CastBar's barBottom) and the song bar STACKS above it. The CastBar card
  // is ~74px tall, so lift the song bar by that + a gap so the two never
  // overlap — on both tab screens (both in the slot) and docked screens (both
  // shift down together, so the same offset holds).
  const castLift = useCast().connected ? 84 : 0;
  const { listenMode } = useListenMode();
  const router = useRouter();

  // Song collaborators ("features") for the currently-playing track — fetched
  // (and cached) when the track changes, so the card can flip title ↔ credits.
  // Never fetched for ads (they aren't posts).
  const [features, setFeatures] = useState<Feature[]>([]);
  const trackId = !adState ? currentTrack?.id ?? null : null;
  useEffect(() => {
    if (!trackId) { setFeatures([]); return; }
    let alive = true;
    setFeatures([]);
    fetchFeatures(trackId).then((f) => { if (alive) setFeatures(f); }).catch(() => {});
    return () => { alive = false; };
  }, [trackId]);

  // Listen mode: the tab bar fades away, so the player glides down into the
  // space it vacated (the 68px bar height), staying flush above the home bar.
  // Hooks run before the early return below, so the value stays mounted.
  //
  // Gated on !bottomDock — the Listen drop applies ONLY while the card is docked
  // to the tab bar (a (tabs) screen). Tapping an artist's name in the full player
  // pushes their profile WITHOUT exiting Listen mode, and on that pushed screen
  // `dockSlide` below already drops the card the full 68px to the true bottom.
  // Left ungated, the Listen offset stacked on top (136px total) and shoved the
  // card off the bottom edge. Because the two slides are now mutually exclusive,
  // their SUM is always "drop 68 when the tab bar is absent" — so the card sits at
  // the bottom of whatever screen the listener lands on. Same 300ms curve as
  // dockSlide keeps that sum constant through the Music→profile hand-off (both
  // flip on the same `bottomDock` change), so the card doesn't budge as it happens.
  const listenSlide = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(listenSlide, {
      toValue: listenMode && !bottomDock ? 68 : 0,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [listenMode, bottomDock, listenSlide]);

  // Routes WITHOUT the bottom tab bar (another user's profile, pushed screens):
  // the bar drops by the tab-bar height (68) so it rests at the true bottom of
  // the screen instead of floating where the absent tab bar would be. Native-
  // driven translate, mirroring listenSlide; initialized so a song that starts
  // while already on such a screen appears docked (no first-frame jump).
  const dockSlide = useRef(new Animated.Value(bottomDock ? 68 : 0)).current;
  useEffect(() => {
    Animated.timing(dockSlide, {
      toValue: bottomDock ? 68 : 0,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [bottomDock, dockSlide]);

  // Home's reactive chrome: when the tab bar condenses into chips (and the
  // chips drop toward the screen edge), the music bar rides the SAME value
  // down so it always hugs the bottom elements instead of floating where the
  // full bar used to be. Zero everywhere else (chrome resets on tab change).
  //
  // Normal (bar visible): full `+ 6` travel so the card rides all the way down to
  // hug the condensed circle buttons. When the bar is HIDDEN (Listen mode / a
  // pushed screen) the card is already docked at the bottom, so the same travel
  // would drive its rounded corners into the screen's curved edge — there we stop
  // ~14px sooner (`- 8`) to keep the bottom boundary clear. Same feel either way.
  const barHidden = listenMode || bottomDock;
  const chromeSlide = feedChrome.interpolate({
    inputRange: [0, 1],
    outputRange: [0, (insets.bottom > 0 ? insets.bottom - 2 : 12) + (barHidden ? -8 : 6)],
  });

  // Overlay variants (Create tab card / camera side chip): the player waits
  // out a short dwell on the tab before fading in — a quick swipe-through
  // never flashes it; leaving the tab resets the dwell. The Create card keeps
  // its spec'd 1.5s; the camera chip arrives quicker.
  const isBar = variant === 'bar';
  const compactAnim = useRef(new Animated.Value(0)).current;
  const [overlayReady, setOverlayReady] = useState(false);
  useEffect(() => {
    if (!isBar) {
      compactAnim.setValue(0);
      const t = setTimeout(() => {
        setOverlayReady(true);
        Animated.timing(compactAnim, { toValue: 1, duration: 350, useNativeDriver: true }).start();
      }, variant === 'compact' ? 1500 : 600);
      return () => clearTimeout(t);
    }
    setOverlayReady(false);
    compactAnim.setValue(0);
  }, [variant, isBar, compactAnim]);

  // The BOTTOM BAR fades out/in as the variant flips instead of hard
  // unmounting — rapid swipes across the Create/camera tabs used to make it
  // vanish and pop back instantly, which read as a glitch.
  const barFade = useRef(new Animated.Value(isBar ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(barFade, {
      toValue: isBar ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [isBar, barFade]);

  // Appearance/exit: when a song STARTS (no track → track), the card fades in
  // with a gentle rise instead of popping up; when playback ENDS (track →
  // none, via the ×, queue end, or stop) it fades back out the same way
  // before unmounting. Track-to-track changes (queue advance) don't re-fade.
  const appearAnim = useRef(new Animated.Value(0)).current;
  const hadTrackRef = useRef(false);
  const [barShown, setBarShown] = useState(false);
  // Last track kept for the fade-out frames (currentTrack is already null).
  const lastTrackRef = useRef(currentTrack);
  if (currentTrack) lastTrackRef.current = currentTrack;
  useEffect(() => {
    const has = !!currentTrack;
    if (has && !hadTrackRef.current) {
      setBarShown(true);
      appearAnim.setValue(0);
      Animated.timing(appearAnim, { toValue: 1, duration: 380, useNativeDriver: true }).start();
    } else if (!has && hadTrackRef.current) {
      Animated.timing(appearAnim, { toValue: 0, duration: 260, useNativeDriver: true })
        .start(({ finished }) => { if (finished) setBarShown(false); });
    }
    hadTrackRef.current = has;
  }, [currentTrack, appearAnim]);
  const appearRise = appearAnim.interpolate({ inputRange: [0, 1], outputRange: [14, 0] });

  const track = currentTrack ?? lastTrackRef.current;
  if ((!currentTrack && !barShown) || !track || expanded) return null;

  // Audio ad: while a playlist break plays, the bar shows the ad like a song
  // (cover + sponsored brand + headline + progress), tappable to open the full
  // ad view — the user moves between mini bar and full player freely. Skip is
  // locked until AUDIO_AD_SKIP_MS; there's no close (the ad can't be dismissed).
  if (adState) {
    const bottomOffset = 68 + insets.bottom + 6 + castLift;
    // Elapsed/duration come from the position channel (useAudioPosition above) —
    // during an ad it carries the ad player's ticks, so only THIS bar re-renders
    // per tick instead of every useAudio() consumer app-wide.
    // Countdown from the ad's ACTUAL skip gate (skip10/skip15/default), not the
    // 10s constant — a skip15 ad's label used to hit 0 a second early.
    const gateMs = Number.isFinite(adState.skipAfterMs) ? adState.skipAfterMs : AUDIO_AD_SKIP_MS;
    const unskippable = adState.skipAfterMs === Infinity;
    const secsLeft = Math.max(1, Math.ceil((gateMs - positionMs) / 1000));
    const adProgress = durationMs > 0 ? positionMs / durationMs : 0;
    const adDest = adDestination(adState);
    return (
      <Animated.View style={[styles.container, { bottom: bottomOffset, transform: [{ translateY: Animated.add(Animated.add(listenSlide, dockSlide), chromeSlide) }] }]}>
        {/* Progress fill (non-interactive — ads aren't seekable). */}
        <View style={styles.scrubWrap}>
          <View style={styles.adProgressTrack}>
            <View style={[styles.adProgressFill, { width: `${Math.round(adProgress * 100)}%` }]} />
          </View>
        </View>
        <View style={styles.inner}>
          {/* Cover — tap to open the full ad view (just like a song). */}
          <TouchableOpacity
          style={styles.coverWrap}
          onPress={() => expand()}
          accessibilityRole="button"
          accessibilityLabel={t('a11y.openPlayer')}
        >
            {adState.cover ? (
              <ExpoImage source={{ uri: adState.cover }} style={styles.cover} contentFit="cover" cachePolicy="memory-disk" />
            ) : (
              <LinearGradient colors={GRADIENTS.primarySoft} style={styles.cover}>
                <Ionicons name="megaphone" size={16} color={colors.primary} />
              </LinearGradient>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={styles.adTextCol} activeOpacity={0.7} onPress={() => expand()}>
            <Text style={styles.adSponsored} numberOfLines={1}>{t('player.sponsoredWith', { name: adState.advertiserName })}</Text>
            <Text style={styles.caption} numberOfLines={1}>{adState.headline || t('player.advertisement')}</Text>
          </TouchableOpacity>
          {/* CTA goes through the shared objective router (openAdCta) — the
              old direct linkGuard call only worked for website ads, so
              profile/shop/product breaks had a dead button here. */}
          {!!adDest && (
            <TouchableOpacity
              style={styles.adCta}
              onPress={() => openAdCta(adState, 'audio', adState.viewerId)}
            >
              <Text style={styles.adCtaText} numberOfLines={1}>{adState.ctaLabel}</Text>
            </TouchableOpacity>
          )}
          {!unskippable && (
            <TouchableOpacity
              style={styles.adSkip}
              disabled={!adState.canSkip}
              onPress={skipAudioAd}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('a11y.skipAd')}
              accessibilityState={{ disabled: !adState.canSkip }}
            >
              <Text style={styles.adSkipText}>{adState.canSkip ? t('player.skip') : secsLeft}</Text>
            </TouchableOpacity>
          )}
        </View>
      </Animated.View>
    );
  }

  // Camera side chip — minimal: cover (tap to open the full player) and
  // play/pause. No title, no scrubber, no close — the camera stays the focus.
  if (variant === 'side' && overlayReady) {
    return (
      <Animated.View
        style={[
          styles.sideChip,
          {
            opacity: compactAnim,
            transform: [{ translateX: compactAnim.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }],
          },
        ]}
      >
        <TouchableOpacity
          style={styles.compactCoverWrap}
          onPress={() => expand()}
          accessibilityRole="button"
          accessibilityLabel={t('a11y.openPlayer')}
        >
          {track.cover ? (
            <ExpoImage source={{ uri: track.cover }} style={styles.compactCover} contentFit="cover" cachePolicy="memory-disk" transition={200} />
          ) : (
            <LinearGradient colors={GRADIENTS.primarySoft} style={styles.compactCover}>
              <Ionicons name="musical-notes" size={13} color={colors.primary} />
            </LinearGradient>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => (isPlaying ? pause() : resume())}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={isPlaying ? t('a11y.pause') : t('a11y.play')}
        >
          <Ionicons
            name={isBuffering ? 'hourglass' : isPlaying ? 'pause-circle' : 'play-circle'}
            size={28} color={colors.primary}
          />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.compactClose}
          onPress={stop}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('a11y.stopPlayback')}
        >
          <Ionicons name="close" size={13} color={colors.textSecondary} />
        </TouchableOpacity>
      </Animated.View>
    );
  }

  if (variant === 'compact' && overlayReady) {
    return (
      <Animated.View
        style={[
          styles.compactCard,
          {
            top: insets.top + 54, // just below the "New post" header row
            opacity: compactAnim,
            transform: [{ translateY: compactAnim.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }],
          },
        ]}
      >
        <TouchableOpacity
          style={styles.compactCoverWrap}
          onPress={() => expand()}
          accessibilityRole="button"
          accessibilityLabel={t('a11y.openPlayer')}
        >
          {track.cover ? (
            <ExpoImage source={{ uri: track.cover }} style={styles.compactCover} contentFit="cover" cachePolicy="memory-disk" transition={200} />
          ) : (
            <LinearGradient colors={GRADIENTS.primarySoft} style={styles.compactCover}>
              <Ionicons name="musical-notes" size={13} color={colors.primary} />
            </LinearGradient>
          )}
        </TouchableOpacity>
        <TouchableOpacity style={styles.compactBody} activeOpacity={0.7} onPress={() => expand()}>
          <Text style={styles.compactTitle} numberOfLines={1}>{track.caption || t('player.audioTrack')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.compactBtn}
          onPress={() => (isPlaying ? pause() : resume())}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={isPlaying ? t('a11y.pause') : t('a11y.play')}
        >
          <Ionicons
            name={isBuffering ? 'hourglass' : isPlaying ? 'pause-circle' : 'play-circle'}
            size={26} color={colors.primary}
          />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.compactClose}
          onPress={stop}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={t('a11y.stopPlayback')}
        >
          <Ionicons name="close" size={13} color={colors.textSecondary} />
        </TouchableOpacity>
      </Animated.View>
    );
  }

  // Sit just above the tab bar (68 + bottom inset), clearing the ~4px the center
  // "+" button now protrudes above it (its pop-up was reduced in the tab bar).
  // castLift raises it over the Laybell TV cast bar while a session is live.
  const bottomOffset = 68 + insets.bottom + 6 + castLift;

  const progress = durationMs > 0 ? positionMs / durationMs : 0;

  // Rendered in bar mode AND during an overlay dwell (fading out via barFade)
  // — never hard-removed on a tab flip, so fast swipes look smooth.
  return (
    <Animated.View
      pointerEvents={isBar ? 'auto' : 'none'}
      style={[styles.container, Platform.OS === 'ios' && styles.containerGlass, {
        bottom: bottomOffset,
        opacity: Animated.multiply(barFade, appearAnim),
        transform: [{ translateY: Animated.add(Animated.add(Animated.add(listenSlide, dockSlide), appearRise), chromeSlide) }],
      }]}
    >
      {/* iOS: real frosted material behind the persistent player, matching the
          tab bar it sits directly above. */}
      {Platform.OS === 'ios' && (
        <BlurView
          tint={mode === 'light' ? 'systemChromeMaterialLight' : 'systemChromeMaterialDark'}
          intensity={50}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      )}
      <View style={styles.scrubWrap}>
        <Scrubber
          progress={progress}
          onSeek={r => durationMs > 0 && seekTo(Math.floor(r * durationMs))}
          height={16} trackHeight={4} thumbSize={12}
        />
      </View>

      <View style={styles.inner}>
        {/* Album cover — tap to open the full now-playing screen */}
        <TouchableOpacity
          style={styles.coverWrap}
          onPress={() => expand()}
          accessibilityRole="button"
          accessibilityLabel={t('a11y.openPlayer')}
        >
          {/* transition: cross-dissolve when the track (and so the source)
              changes under this mounted view — smooths song-to-song swaps. */}
          {track.cover ? (
            <ExpoImage source={{ uri: track.cover }} style={styles.cover} contentFit="cover" cachePolicy="memory-disk" transition={200} />
          ) : (
            <LinearGradient colors={GRADIENTS.primarySoft} style={styles.cover}>
              <Ionicons name="musical-notes" size={16} color={colors.primary} />
            </LinearGradient>
          )}
        </TouchableOpacity>

        {/* Tapping the bar (except the controls) expands the now-playing screen */}
        <TouchableOpacity style={styles.body} activeOpacity={0.7} onPress={() => expand()}>
          <View style={styles.trackInfo}>
            <SongCardTitle
              title={track.caption || t('player.audioTrack')}
              features={features}
              positionMs={positionMs}
              durationMs={durationMs}
              titleStyle={styles.caption}
              onOpenProfile={(id) => router.push(`/profile/${id}`)}
            />
            <Text style={styles.artist} numberOfLines={1}>{track.artist}</Text>
          </View>
          <Text style={styles.timeText}>
            {formatMs(positionMs)}{durationMs > 0 ? ` / ${formatMs(durationMs)}` : ''}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.playBtn}
          onPress={() => (isPlaying ? pause() : resume())}
          accessibilityRole="button"
          accessibilityLabel={isPlaying ? t('a11y.pause') : t('a11y.play')}
        >
          {isBuffering ? (
            <Ionicons name="hourglass" size={18} color={colors.primary} />
          ) : (
            <Ionicons name={isPlaying ? 'pause-circle' : 'play-circle'} size={34} color={colors.primary} />
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.stopBtn}
          onPress={stop}
          accessibilityRole="button"
          accessibilityLabel={t('a11y.stopPlayback')}
        >
          <Ionicons name="close" size={15} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: {
    position: 'absolute', left: SPACING.sm, right: SPACING.sm,
    backgroundColor: colors.surfaceElevated,
    borderRadius: RADIUS.lg, overflow: 'hidden',
    borderWidth: 0.5, borderColor: colors.primaryLight + '55',
    // iOS: overflow:'hidden' clips the layer shadow — it drew NOTHING here but
    // still forced alpha-based shadow work on a bar that moves with every
    // scroll. Android elevation is unaffected, so keep the shadow there.
    ...(Platform.OS === 'ios' ? {} : SHADOWS.md),
    zIndex: 100,
  },
  // iOS: drop the solid fill so the BlurView behind provides a real frosted surface.
  containerGlass: { backgroundColor: 'transparent' },
  scrubWrap: { paddingHorizontal: SPACING.sm, paddingTop: SPACING.xs },
  inner: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm, paddingTop: SPACING.xs, gap: SPACING.sm,
  },
  coverWrap: { width: 38, height: 38, borderRadius: RADIUS.sm, overflow: 'hidden' },
  cover: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  trackInfo: { flex: 1 },
  caption: { color: colors.text, fontSize: 13, fontWeight: '600' },
  artist: { color: colors.textSecondary, fontSize: 11, marginTop: 1 },
  timeText: { color: colors.textTertiary, fontSize: 11, fontVariant: ['tabular-nums'] },
  // Borderless filled-circle glyph (same as Today's Pick) — fixed box keeps
  // the bar layout stable between the play/pause/buffering states.
  playBtn: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  stopBtn: {
    width: 30, height: 30, borderRadius: RADIUS.full,
    backgroundColor: colors.surfaceElevated, alignItems: 'center', justifyContent: 'center',
  },

  // ── Audio-ad bar (rendered like the song bar) ──
  adProgressTrack: {
    height: 4, borderRadius: 2, backgroundColor: colors.border, overflow: 'hidden',
  },
  adProgressFill: { height: '100%', borderRadius: 2, backgroundColor: colors.primary },
  // Column (stacked) text block. minWidth:0 lets the headline truncate instead of
  // pushing the CTA/skip buttons off — without it a long headline collides with them.
  adTextCol: { flex: 1, minWidth: 0, justifyContent: 'center' },
  adSponsored: { color: colors.primaryLight, fontSize: 10, fontWeight: '800', letterSpacing: 0.3 },
  adCta: {
    backgroundColor: colors.primary, borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.md, paddingVertical: 6, maxWidth: 110,
  },
  adCtaText: { color: colors.text, fontSize: 12, fontWeight: '800' },
  adSkip: {
    minWidth: 34, height: 28, borderRadius: RADIUS.full, paddingHorizontal: SPACING.sm,
    borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center',
  },
  adSkipText: { color: colors.textSecondary, fontSize: 12, fontWeight: '700' },

  // ── Compact card (Create tab) — small pill pinned top-right, below the
  // "New post" header so it never covers the Next arrow. ──
  compactCard: {
    position: 'absolute', right: SPACING.sm, maxWidth: 210,
    flexDirection: 'row', alignItems: 'center', gap: SPACING.xs + 2,
    backgroundColor: colors.surfaceElevated,
    borderRadius: RADIUS.full,
    borderWidth: 0.5, borderColor: colors.primaryLight + '55',
    paddingVertical: 5, paddingLeft: 5, paddingRight: SPACING.sm,
    ...SHADOWS.md,
    zIndex: 100,
  },
  compactCoverWrap: { width: 28, height: 28, borderRadius: 14, overflow: 'hidden' },
  compactCover: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  compactBody: { flexShrink: 1, maxWidth: 96 },
  compactTitle: { color: colors.text, fontSize: 12, fontWeight: '600' },
  compactBtn: { alignItems: 'center', justifyContent: 'center' },
  compactClose: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: colors.surfaceLight, alignItems: 'center', justifyContent: 'center',
  },

  // ── Side chip (story camera) — vertical pill hugging the right edge at
  // mid-height, clear of the top camera controls and the bottom shutter. ──
  sideChip: {
    position: 'absolute', right: 8, top: '42%',
    alignItems: 'center', gap: 8,
    backgroundColor: colors.surfaceElevated,
    borderRadius: RADIUS.full,
    borderWidth: 0.5, borderColor: colors.primaryLight + '55',
    paddingVertical: 8, paddingHorizontal: 6,
    ...SHADOWS.md,
    zIndex: 100,
  },
});
