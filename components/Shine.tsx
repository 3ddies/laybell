import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Animated, Easing, AccessibilityInfo } from 'react-native';

// A highlight that travels across whatever it's dropped into, then rests.
// The parent must set `overflow: 'hidden'` and pass its measured width.
//
// The rest between passes is the whole point: a continuous sweep reads as a
// loading bar, and on chrome you look at all day anything that never stops
// moving becomes something to tune out.
//
// Native driver only — nothing here touches the JS thread once started.

export default function Shine({
  width, active = true, sweepMs = 1400, restMs = 7800, band = 26, tilt = '18deg',
  color = 'rgba(255,255,255,0.30)',
}: {
  /** Measured width of the host. Nothing renders until this is known. */
  width: number;
  /** Gate for callers that only want it under certain conditions. */
  active?: boolean;
  sweepMs?: number;
  restMs?: number;
  band?: number;
  tilt?: string;
  color?: string;
}) {
  const [reduceMotion, setReduceMotion] = useState(false);
  const sweep = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => { if (alive) setReduceMotion(on); })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { alive = false; sub?.remove?.(); };
  }, []);

  const run = active && !reduceMotion && width > 0;

  useEffect(() => {
    if (!run) return;
    sweep.setValue(0);
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(sweep, { toValue: 1, duration: sweepMs, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.delay(restMs),
    ]));
    loop.start();
    // Reset as well as stop: a stopped value holds where it was, which would
    // strand the highlight mid-host when the gate closes.
    return () => { loop.stop(); sweep.setValue(0); };
  }, [run, sweep, sweepMs, restMs]);

  if (!run) return null;

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.band,
        {
          width: band,
          backgroundColor: color,
          transform: [
            { translateX: sweep.interpolate({ inputRange: [0, 1], outputRange: [-width * 0.6, width * 1.3] }) },
            { rotate: tilt },
          ],
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  // Over-tall so the tilt still covers the host top to bottom.
  band: { position: 'absolute', top: -20, bottom: -20 },
});
