import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '../contexts/ThemeContext';

// A slow warm bloom behind the auth screens, so they are not flat.
//
// WHAT THE OWNER ASKED FOR was a background fading from white into the Laybell
// gradient. The intent — make the first screen feel alive and branded — is
// right; that particular execution fights the screen three ways:
//   • The app is dark-first. Starting white and landing in a dark app is a jolt
//     at the exact moment a new user is forming an impression.
//   • The form is white text on dark inputs. There is no point along a
//     white → orange sweep where white text is legible, so the text and inputs
//     would have to animate too — a lot of moving parts on the first screen.
//   • It would run at the same time as the logo drawing itself in
//     (components/AuthLogoMark). Two motions competing makes both read cheaper.
//
// So this keeps the theme's own ground and puts the brand INTO it: a warm wash
// from the top edge, behind the logo, doing two independent things at once —
// drifting between a gold-led and a red-led mix, and BREATHING from nearly
// absent up to full and back. The second one is what makes it read as an effect
// rather than as wallpaper; without it the amount of colour never changed and
// the eye stopped seeing it. Same brand colours either way, and the form stays
// legible because what reaches the inputs is a tint rather than a colour.
//
// PACE IS THE WHOLE POINT. Slow enough that it never pulls the eye while someone
// is typing a password — it is felt rather than watched. See CYCLE_MS below for
// the current value and the floor it should not go under.
//
// Costs nothing meaningful: two static gradients, one opacity driven on the
// native driver. No layout, no re-render, no image to decode.

// Tuning lives here — the owner iterates on these on the dev client, so they are
// one place rather than scattered through the JSX.
//
// Was 11000 / 0.20 / 0.24 on the first pass; the owner asked for "a little
// stronger and faster" after seeing it on device, which is what these are.
// Still slow enough to be felt rather than watched, which is the constraint that
// matters next to a password field — do not take this much below ~6s.
const CYCLE_MS = 7500;

// Intensity pulse — the change that made this actually visible.
//
// The first two versions only cross-faded gold against red, so total strength
// was near-constant: the HUE moved but the amount of colour never did, and the
// eye reads a constant wash as part of the wallpaper. The owner asked for it to
// "fade more into orange, and back to white", which is exactly the missing
// dimension. Now the whole bloom breathes from nearly-absent up to full and
// back, so it visibly arrives and leaves.
//
// Deliberately a DIFFERENT period from the hue cycle. Two loops on the same
// clock lock together and read as one mechanical pulse; drifting against each
// other means the screen never repeats the same combination twice in a row and
// the whole thing feels alive rather than looped.
const PULSE_MS = 5200;
const PULSE_MIN = 0.28;

// Peak alpha at the very top edge, and the mid-stop that carries it down.
// Raised alongside the pulse — these are now the TOP of a breath rather than a
// constant, so the average on screen is lower than these numbers suggest.
const GOLD_TOP = 0.46;
const GOLD_MID = 0.20;
const RED_TOP = 0.54;
const RED_MID = 0.23;

export default function AuthBackdrop() {
  const { mode } = useTheme();
  const isLight = mode === 'light';

  // 0 = gold-led mix, 1 = red-led mix. One value cross-fades the two layers.
  const mix = useRef(new Animated.Value(0)).current;
  // How MUCH colour there is at all, independent of which colour. Starts at full
  // so the screen is already warm on arrival — see the no-entrance-fade note.
  const pulse = useRef(new Animated.Value(1)).current;

  // There is deliberately NO entrance fade. The first version eased the bloom in
  // over 900ms; the owner asked for the screen to simply BE that colour on
  // arrival. He is right — the fade drew attention to the background at the one
  // moment the eye should be going to the logo and the form, and it made a
  // static screen look like it was still loading.
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(mix, {
          toValue: 1, duration: CYCLE_MS, easing: Easing.inOut(Easing.sin), useNativeDriver: true,
        }),
        Animated.timing(mix, {
          toValue: 0, duration: CYCLE_MS, easing: Easing.inOut(Easing.sin), useNativeDriver: true,
        }),
      ]),
    );
    const breathe = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: PULSE_MIN, duration: PULSE_MS, easing: Easing.inOut(Easing.sin), useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1, duration: PULSE_MS, easing: Easing.inOut(Easing.sin), useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    breathe.start();
    return () => { loop.stop(); breathe.stop(); };
  }, [mix, pulse]);

  // Light theme still runs softer — the same alphas on a near-white ground read
  // as a stain rather than a glow — but less softly than before. It was 0.55,
  // and the owner (who runs Light) asked for more, so the damping is lighter now
  // that the pulse takes the peaks away again on its own.
  const k = isLight ? 0.76 : 1;
  const a = (v: number) => Math.round(v * k * 100) / 100;

  const gold = [
    `rgba(250,181,37,${a(GOLD_TOP)})`,
    `rgba(242,101,34,${a(GOLD_MID)})`,
    'rgba(242,101,34,0)',
  ] as const;
  const red = [
    `rgba(232,64,28,${a(RED_TOP)})`,
    `rgba(242,101,34,${a(RED_MID)})`,
    'rgba(242,101,34,0)',
  ] as const;

  // Reaches further down than it used to (was 0.72) so the warmth is a wash over
  // the screen rather than a band across the top — but the middle stop stays low,
  // so what arrives at the form is a tint and not a colour. Do not push the last
  // stop past ~0.85: below that the fields start sitting ON the bloom instead of
  // in front of it, and legibility is the one thing here that is not negotiable.
  const stops = [0, 0.36, 0.84] as const;

  return (
    // The pulse wraps BOTH layers, so it changes how much colour there is
    // without disturbing which colour is winning — the two effects stay
    // independent and can be tuned separately.
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: pulse }]}>
      <Animated.View
        style={[StyleSheet.absoluteFill, { opacity: mix.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }]}
      >
        <LinearGradient colors={gold} locations={stops} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: mix }]}>
        <LinearGradient colors={red} locations={stops} style={StyleSheet.absoluteFill} />
      </Animated.View>
    </Animated.View>
  );
}
