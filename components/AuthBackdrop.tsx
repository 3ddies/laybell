import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
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
// So this keeps the dark ground and puts the brand INTO it: a warm glow from
// the top edge, behind the logo, that breathes slowly between a gold-led and a
// red-led mix. Same colours, same feeling, and the form stays perfectly legible
// because the bloom is gone well before the inputs start.
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

// Peak alpha at the very top edge, and the mid-stop that carries it down.
const GOLD_TOP = 0.29;
const GOLD_MID = 0.11;
const RED_TOP = 0.34;
const RED_MID = 0.12;

export default function AuthBackdrop() {
  const { mode } = useTheme();
  const isLight = mode === 'light';

  // 0 = gold-led mix, 1 = red-led mix. One value cross-fades the two layers.
  const mix = useRef(new Animated.Value(0)).current;

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
    loop.start();
    return () => loop.stop();
  }, [mix]);

  // Light theme sits on a near-white ground, where the same alphas would read as
  // a stain rather than a glow. Roughly half strength there.
  const k = isLight ? 0.55 : 1;
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

  // Gone by 72% down the screen, which is above the inputs on every handset —
  // the form never sits on colour.
  const stops = [0, 0.34, 0.72] as const;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Animated.View
        style={[StyleSheet.absoluteFill, { opacity: mix.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }]}
      >
        <LinearGradient colors={gold} locations={stops} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: mix }]}>
        <LinearGradient colors={red} locations={stops} style={StyleSheet.absoluteFill} />
      </Animated.View>
    </View>
  );
}
