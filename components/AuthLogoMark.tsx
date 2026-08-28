import { useEffect } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { RADIUS } from '../constants/theme';

// The Laybell mark, drawing itself in, on the sign-in and sign-up screens.
//
// WHAT THIS IS. The owner's brand animation (#LogoAnimation_03-Vertical.MP4):
// a note appears, a bell draws itself around it, it rings, and it settles. The
// source runs 6.9s at 1080x1920 and then cuts to the LAYBELL wordmark; this
// asset is the first 3.8s only — the bell half — square-cropped to 288x288 and
// stripped of its audio track. 35 KB.
//
// WHY NOT THE FULL VIDEO AS A BACKGROUND, which is what was asked for first:
//   • It is a saturated red-to-orange gradient edge to edge. The auth form is
//     white text over dark inputs, so it would need darkening to roughly a
//     quarter brightness to stay legible — paying a video's cost to display a
//     dark orange smudge.
//   • It ENDS on the LAYBELL wordmark, which would sit directly behind the
//     "Laybell" wordmark this screen already renders. Two wordmarks, stacked.
//   • It ends on the wordmark and starts on empty gradient, so a loop is a hard
//     cut every 7 seconds — on the first screen a new user ever sees.
// Contained in the logo tile it has none of those problems and keeps the motion.
//
// WHY IT DOES NOT LOOP. It plays once and holds on the finished bell, which is
// very nearly assets/icon.png. Looping would make the mark vanish and redraw
// every 3.8 seconds in the corner of someone's eye while they type a password.
// A logo that draws itself on arrival reads as craft; one that keeps redrawing
// reads as a GIF. To change it, set `loop = true` below — nothing else.
//
// The still icon underneath is not decoration: it is the fallback. It renders
// at identical size and framing, so if the video fails to decode, is still
// loading, or the platform refuses the view, what is left behind is exactly the
// logo this screen showed before — never a hole.

const MARK_VIDEO = require('../assets/logo-mark.mp4');
const MARK_STILL = require('../assets/icon.png');

/**
 * How long the mark takes to draw itself in, in ms — the real duration of
 * assets/logo-mark.mp4, so it moves if the asset is ever re-cut.
 *
 * Exported because other things on these screens have to WAIT for it.
 * AuthSubmitButton holds its sheen back until this is over: the owner's note was
 * that a button flashing while the bell is still ringing is overstimulating, and
 * he is right — two animations at once on the first screen means the eye has
 * nowhere to settle and neither one lands.
 */
export const MARK_ANIMATION_MS = 3800;

type Props = { size?: number };

export default function AuthLogoMark({ size = 72 }: Props) {
  const player = useVideoPlayer(MARK_VIDEO, (p) => {
    p.loop = false;
    // No audio track exists in the asset, but muting is also what keeps this
    // from touching the audio session at all — this app holds a persistent
    // player elsewhere and nothing here should ever interrupt it.
    p.muted = true;
    p.play();
  });

  // Belt and braces: the setup callback runs once when the player is created,
  // and a remount that reuses a paused player would otherwise sit on frame 0.
  useEffect(() => {
    try { player.play(); } catch { /* fallback still shows the mark */ }
  }, [player]);

  return (
    <View style={[styles.tile, { width: size, height: size }]}>
      <Image source={MARK_STILL} style={StyleSheet.absoluteFill} resizeMode="cover" />
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        nativeControls={false}
        allowsFullscreen={false}
        allowsPictureInPicture={false}
        accessible={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // overflow:hidden is what gives the video the same rounded tile the still had.
  tile: { borderRadius: RADIUS.xl, overflow: 'hidden' },
});
