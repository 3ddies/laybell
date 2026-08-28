import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useVideoPlayer, VideoView } from 'expo-video';
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
// WHAT IT SHOWS is the brand animation, full screen: the owner's own asset,
// finally used the way it was made. Every objection to it as a sign-in
// BACKGROUND (a form unreadable on saturated orange, its LAYBELL wordmark
// colliding with the screen's own, a hard loop seam) only held because there was
// a form and because it looped. Here there is neither.
//
// THE MINIMUM HOLD IS A FEATURE. It waits for the animation to finish AND for
// routing, whichever is later. Sign-in resolves in about two seconds, so the
// remainder is the feed mounting and fetching behind this — dead time either
// way, and this spends it.

const VIDEO_MS = 3770;
const OUT_MS = 460;

// Sampled from the asset's own first frame, so the fallback is the same red the
// video opens on rather than an approximation. It shows for the frame before the
// video paints, and stays if it never does — a decode failure here should look
// like a brand moment, not a black hole.
const FALLBACK = ['#FF1100', '#FD3700', '#FC5F01'] as const;

const HANDOFF_VIDEO = require('../assets/logo-handoff.mp4');

export default function AuthHandoff({ visible }: { visible: boolean }) {
  // Kept mounted through the fade-out so the reveal is a fade, not a cut.
  const [mounted, setMounted] = useState(visible);
  // The animation has had its full run. Until then the cover stays up even if
  // routing already finished.
  const [played, setPlayed] = useState(false);
  // Starts OPAQUE. There is deliberately no fade-in: this exists to hide a
  // remount that happens in the same React commit that raises it, so any
  // fade-in is a window straight onto the thing being hidden. The cut from a
  // light screen to brand red is abrupt by design — it reads as "here we go".
  const fade = useRef(new Animated.Value(1)).current;

  // The timer lives in a ref, NOT in the raise effect's cleanup.
  //
  // It was in the cleanup, and that was the "video just stays on the screen"
  // bug: `visible` flips false the moment routing finishes — about two seconds
  // in, well before the animation ends — which re-ran the effect, cleared the
  // pending timer, and left `played` false forever. The cover then had no way
  // out. Cleanup on unmount only.
  const playedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (playedTimer.current) clearTimeout(playedTimer.current); }, []);

  const player = useVideoPlayer(HANDOFF_VIDEO, (p) => {
    p.loop = false;
    // The asset carries no audio track at all, but muting is also what keeps
    // this away from the audio session — the app holds a persistent player and
    // a sign-in must never interrupt it.
    p.muted = true;
  });

  useEffect(() => {
    if (!visible) return;
    setMounted(true);
    setPlayed(false);
    fade.setValue(1);
    // Rewind on every raise. A player reused across two sign-ins in one app run
    // would otherwise sit on its final frame — the wordmark, already resolved —
    // and never play again.
    try { player.currentTime = 0; player.play(); } catch { /* fallback carries it */ }
    if (playedTimer.current) clearTimeout(playedTimer.current);
    playedTimer.current = setTimeout(() => setPlayed(true), VIDEO_MS);
  }, [visible, fade, player]);

  // Leave only when BOTH are true: routing done, and the animation has run.
  useEffect(() => {
    if (visible || !played || !mounted) return;
    Animated.timing(fade, {
      toValue: 0, duration: OUT_MS, easing: Easing.inOut(Easing.quad), useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) { setMounted(false); try { player.pause(); } catch {} }
    });
  }, [visible, played, mounted, fade, player]);

  if (!mounted) return null;

  return (
    <Animated.View
      // Swallows taps while up: the tree underneath is being rebuilt, and a tap
      // landing on a half-mounted screen is how you get a crash nobody can
      // reproduce.
      style={[StyleSheet.absoluteFill, styles.fill, { opacity: fade }]}
    >
      <LinearGradient colors={FALLBACK} style={StyleSheet.absoluteFill} />
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        // cover, not contain: the asset is 9:16 and phones are taller. A
        // letterboxed brand moment is worse than a slightly cropped one.
        contentFit="cover"
        nativeControls={false}
        allowsFullscreen={false}
        allowsPictureInPicture={false}
        accessible={false}
      />
    </Animated.View>
  );
}

/**
 * Silences the app while the cover is up. Renders nothing.
 *
 * The whole point of holding the cover is that the feed mounts and fetches
 * behind it — but a mounted feed AUTOPLAYS. The owner heard a video post's audio
 * starting under the animation and reasonably read it as the animation having a
 * delayed soundtrack. It has no audio track at all; what he heard was the app
 * arriving early.
 *
 * MediaSuspendContext already exists for exactly this (full-screen takeovers
 * pausing background playback) and every video component plus PostMusicContext
 * honours it. It is ref-counted, so this composes with any other suspender.
 *
 * Must be rendered INSIDE the keyed per-user tree — that is where the provider
 * lives, and the provider's count resets with it. Mounting fresh with
 * `active` already true is the normal case and suspends immediately.
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
});
