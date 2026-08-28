import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useMediaSuspend } from '../contexts/MediaSuspendContext';

// The bridge between signing in and the app appearing.
//
// WHY THIS HAS TO EXIST, and it is not a cosmetic reason.
//
// app/_layout.tsx keys the whole per-user tree on the user id, deliberately —
// without it, a second account signing in on the same device inherits the
// previous one's cached profile, stories and now-playing for a beat. On sign-in
// that key changes from 'signed-out' to the id, so React unmounts and rebuilds
// everything under it. Including the sign-in screen the user is still looking at.
//
// So between tapping Log in and the feed arriving, the form VISIBLY RESET:
// fields blank, logo replaying, button back to idle. That looks exactly like a
// failed submit. The key cannot go — it prevents a real data leak between
// accounts — so this covers the handoff instead.
//
//
// WHY THIS IS DRAWN AND NOT A VIDEO.
//
// It was the brand animation played full screen, and it looked soft and banded
// no matter how it was encoded. Re-encoding could not fix it, because nothing
// can: the source is a ~2 Mbps H.264 at 1080×1920, a phone screen is TALLER than
// 9:16 so `cover` upscales it before cropping, and a smooth gradient is the
// worst case for block-transform compression — banding reads as "low
// resolution" far more than softness does. Every version of that trade was
// upscaling something already lossy.
//
// So the animation is rebuilt here from its parts instead:
//
//   • The gradient is a real LinearGradient. GPU-rendered at native resolution,
//     perfectly smooth at any screen size, and it cannot band because it is
//     never compressed. This is most of the screen area and most of the fix.
//   • The mark and the wordmark are white-on-transparent PNGs at 400×448 and
//     608×116, DOWNSCALED on screen rather than up — the one direction that
//     cannot soften. 22 KB together, against 433 KB of video.
//   • The motion is Animated, on the native driver, so it is frame-perfect
//     rather than sampled at whatever frame rate the asset was exported at.
//
// The wordmark is lifted from the original's own final frame (keyed off the blue
// channel: the mark is pure white, the ground has no blue in it), so it is the
// real brand typeface rather than a system font pretending. The mark comes from
// android-icon-foreground.png, which is vector-derived and cleaner than any
// frame of the video ever was.
//
//
// THE MINIMUM HOLD IS A FEATURE. The cover waits for the animation AND for
// routing, whichever is later. Sign-in resolves in about two seconds, so the
// remainder is the feed mounting and fetching behind it — dead time either way,
// and this spends it.

// Beats, in order. They sum to SEQ_MS; HOLD_MS is the wordmark's moment before
// the cover is allowed to leave.
const IN_MS = 620;      // the mark arrives, with a slight overshoot
const SETTLE_MS = 110;
const RING_MS = 520;    // it rings — the wobble the original animation has
const PAUSE_MS = 150;
const RESOLVE_MS = 500; // mark gives way to the wordmark
const HOLD_MS = 620;
const SEQ_MS = IN_MS + SETTLE_MS + RING_MS + PAUSE_MS + RESOLVE_MS;
const MIN_MS = SEQ_MS + HOLD_MS;

const OUT_MS = 460;

// The brand ground, sampled from the original animation's own frames so this is
// the same red it opens on rather than an approximation of it.
const FILL = ['#FF1100', '#FD3700', '#FC5F01'] as const;

const MARK = require('../assets/logo-mark-white.png');
const WORDMARK = require('../assets/logo-wordmark-white.png');

export default function AuthHandoff({ visible }: { visible: boolean }) {
  // Kept mounted through the fade-out so the reveal is a fade, not a cut.
  const [mounted, setMounted] = useState(visible);
  // The sequence has had its full run. Until then the cover stays up even if
  // routing already finished.
  const [played, setPlayed] = useState(false);

  // Starts OPAQUE. There is deliberately no fade-in: this exists to hide a
  // remount that happens in the same React commit that raises it, so a fade-in
  // is a window straight onto the thing being hidden. The cut from a light
  // screen to brand red is abrupt by design — it reads as "here we go".
  const fade = useRef(new Animated.Value(1)).current;
  const enter = useRef(new Animated.Value(0)).current;    // mark scales + fades in
  const ring = useRef(new Animated.Value(0)).current;      // the wobble
  const resolve = useRef(new Animated.Value(0)).current;   // 0 = mark, 1 = wordmark

  // The timer lives in a ref, NOT in the raise effect's cleanup.
  //
  // It was in the cleanup, and that was the "it just stays on the screen" bug:
  // `visible` flips false the moment routing finishes — about two seconds in,
  // well before the animation ends — which re-ran the effect, cleared the
  // pending timer, and left `played` false forever, so the cover had no exit at
  // all. A cleanup that cancels the thing it is waiting for is easy to write and
  // hard to see. Cleared on unmount only.
  const playedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (playedTimer.current) clearTimeout(playedTimer.current); }, []);

  useEffect(() => {
    if (!visible) return;
    setMounted(true);
    setPlayed(false);
    fade.setValue(1);
    // Reset every beat: a second sign-in in one app run must replay from the
    // start rather than beginning on the already-resolved wordmark.
    enter.setValue(0); ring.setValue(0); resolve.setValue(0);

    const seq = Animated.sequence([
      // back() overshoots slightly, which is what gives the mark a pop rather
      // than an inflate.
      Animated.timing(enter, { toValue: 1, duration: IN_MS, easing: Easing.out(Easing.back(1.7)), useNativeDriver: true }),
      Animated.delay(SETTLE_MS),
      Animated.timing(ring, { toValue: 1, duration: RING_MS, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.delay(PAUSE_MS),
      Animated.timing(resolve, { toValue: 1, duration: RESOLVE_MS, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }),
    ]);
    seq.start();

    if (playedTimer.current) clearTimeout(playedTimer.current);
    playedTimer.current = setTimeout(() => setPlayed(true), MIN_MS);
    return () => seq.stop();
  }, [visible, fade, enter, ring, resolve]);

  // Leave only when BOTH are true: routing done, and the sequence has run.
  useEffect(() => {
    if (visible || !played || !mounted) return;
    Animated.timing(fade, {
      toValue: 0, duration: OUT_MS, easing: Easing.inOut(Easing.quad), useNativeDriver: true,
    }).start(({ finished }) => { if (finished) setMounted(false); });
  }, [visible, played, mounted, fade]);

  if (!mounted) return null;

  const markOpacity = Animated.multiply(
    enter,
    resolve.interpolate({ inputRange: [0, 0.45], outputRange: [1, 0], extrapolate: 'clamp' }),
  );
  const markScale = Animated.multiply(
    enter.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }),
    resolve.interpolate({ inputRange: [0, 1], outputRange: [1, 0.86] }),
  );
  // Four stops for a damped swing — over, back, a smaller over, rest.
  const markTilt = ring.interpolate({
    inputRange: [0, 0.25, 0.55, 0.8, 1],
    outputRange: ['0deg', '5deg', '-4deg', '2deg', '0deg'],
  });

  const wordOpacity = resolve.interpolate({ inputRange: [0.35, 1], outputRange: [0, 1], extrapolate: 'clamp' });
  const wordScale = resolve.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] });

  return (
    <Animated.View
      // Swallows taps while up: the tree underneath is being rebuilt, and a tap
      // landing on a half-mounted screen is how you get a crash nobody can
      // reproduce.
      style={[StyleSheet.absoluteFill, styles.fill, { opacity: fade }]}
    >
      <LinearGradient colors={FILL} style={StyleSheet.absoluteFill} />
      <Animated.View
        style={[styles.center, { opacity: markOpacity, transform: [{ scale: markScale }, { rotate: markTilt }] }]}
      >
        <Image source={MARK} style={styles.mark} resizeMode="contain" />
      </Animated.View>
      <Animated.View style={[styles.center, { opacity: wordOpacity, transform: [{ scale: wordScale }] }]}>
        <Image source={WORDMARK} style={styles.wordmark} resizeMode="contain" />
      </Animated.View>
    </Animated.View>
  );
}

/**
 * Silences the app while the cover is up. Renders nothing.
 *
 * The whole point of holding the cover is that the feed mounts and fetches
 * behind it — but a mounted feed AUTOPLAYS. The owner heard a video post's audio
 * starting under the animation and reasonably read it as the animation having a
 * delayed soundtrack. There was never an audio track; what he heard was the app
 * arriving early.
 *
 * MediaSuspendContext already exists for exactly this (full-screen takeovers
 * pausing background playback) and every video component plus PostMusicContext
 * honours it. Ref-counted, so this composes with any other suspender.
 *
 * Must render INSIDE the keyed per-user tree — that is where the provider lives,
 * and its count resets with it. Mounting fresh with `active` already true is the
 * normal case and suspends immediately.
 */
export function SuspendMediaWhile({ active }: { active: boolean }) {
  const { suspend, resume } = useMediaSuspend();
  useEffect(() => {
    if (!active) return;
    suspend();
    return () => resume();
  }, [active, suspend, resume]);
  return null;
}

const styles = StyleSheet.create({
  // zIndex as well as JSX order — this sits among providers, and order alone
  // would put it behind anything that later gains its own elevation.
  fill: { zIndex: 100 },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  // Both are shown well below their source size, which is the whole point: a
  // downscale cannot soften, and these never touch a compressor.
  mark: { width: 150, height: 168 },
  wordmark: { width: 264, height: 50 },
});
