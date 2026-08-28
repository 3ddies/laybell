import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useVideoPlayer, VideoView } from 'expo-video';

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
// fields blank, logo replaying from the start, button back to idle. The owner
// read that as a freeze, and he read it correctly — it looks exactly like a
// failed submit. The key cannot go; it is preventing a real data leak between
// accounts. So this covers the handoff instead.
//
// WHAT IT SHOWS. The brand animation, full screen — the owner's own asset,
// finally used the way it was made. Every objection to it as a sign-in
// BACKGROUND (a form unreadable on saturated orange, its LAYBELL wordmark
// colliding with the screen's own wordmark, a hard loop seam) evaporates here,
// because there is no form and it plays exactly once. What was wrong behind a
// login is precisely right as the moment after one.
//
// The asset is the full 6.9s original trimmed to 5.6s and run 1.5× faster:
// note, bell drawing itself, ring, settle, resolve to the wordmark. 3.77s, and
// 107 KB — a flat gradient compresses to almost nothing.
//
// THE MINIMUM HOLD IS A FEATURE, NOT A COST. It waits for the animation to
// finish AND for routing to complete, whichever is later. Sign-in resolves in
// roughly two seconds, so the extra time is the feed mounting and fetching
// behind this — the owner's point exactly: the user watches something
// deliberate instead of a spinner, and lands on a feed that has had a head
// start. Dead time either way; this spends it.

const VIDEO_MS = 3780;
const IN_MS = 200;
const OUT_MS = 420;

// Sampled from the asset's own first frame, so the fallback is the same red the
// video opens on rather than an approximation of it. This shows for the frame
// before the video paints, and stays visible if it never does — a decode failure
// on this screen should look like a brand moment, not a black hole.
const FALLBACK = ['#FF1100', '#FD3700', '#FC5F01'] as const;

const HANDOFF_VIDEO = require('../assets/logo-handoff.mp4');

export default function AuthHandoff({ visible }: { visible: boolean }) {
  // Kept mounted through the fade-out so the reveal is a fade, not a cut.
  const [mounted, setMounted] = useState(visible);
  // The animation has been given its full run. Until then the cover stays up
  // even if routing has already finished.
  const [played, setPlayed] = useState(false);
  const fade = useRef(new Animated.Value(0)).current;

  const player = useVideoPlayer(HANDOFF_VIDEO, (p) => {
    p.loop = false;
    // The asset has no audio track, but muting is also what keeps this away from
    // the audio session — the app holds a persistent player and a sign-in must
    // never interrupt it.
    p.muted = true;
  });

  // Restart from frame 0 on every raise. A player reused across two sign-ins in
  // one app run would otherwise sit on its final frame — the wordmark, already
  // resolved — and the animation would never play again.
  useEffect(() => {
    if (!visible) return;
    setMounted(true);
    setPlayed(false);
    fade.setValue(0);
    try { player.currentTime = 0; player.play(); } catch { /* fallback gradient carries it */ }
    Animated.timing(fade, {
      toValue: 1, duration: IN_MS, easing: Easing.out(Easing.quad), useNativeDriver: true,
    }).start();
    const t = setTimeout(() => setPlayed(true), VIDEO_MS);
    return () => clearTimeout(t);
  }, [visible, fade, player]);

  // Leave only when BOTH are true: routing is done and the animation has run.
  useEffect(() => {
    if (visible || !played || !mounted) return;
    Animated.timing(fade, {
      toValue: 0, duration: OUT_MS, easing: Easing.in(Easing.quad), useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) { setMounted(false); try { player.pause(); } catch {} }
    });
  }, [visible, played, mounted, fade, player]);

  if (!mounted) return null;

  return (
    <Animated.View
      // Swallows taps while it is up: the tree underneath is being rebuilt, and
      // a tap landing on a half-mounted screen is how you get a crash report
      // nobody can reproduce.
      style={[StyleSheet.absoluteFill, styles.fill, { opacity: fade }]}
    >
      <LinearGradient colors={FALLBACK} style={StyleSheet.absoluteFill} />
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        // cover, not contain: the asset is 9:16 and phones are taller, and a
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

const styles = StyleSheet.create({
  // zIndex as well as JSX order — this sits among providers, and order alone
  // would put it behind anything that later gains its own elevation.
  fill: { zIndex: 100 },
});
