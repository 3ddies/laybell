import { useEffect, useRef, useState } from 'react';
import { View, Animated, Easing, StyleSheet, type TextStyle } from 'react-native';
import { formatCount } from '../lib/format';

// A number that FLIPS to its new value: the old value rolls up and out the top while
// the new value rolls up into place (split-flap / odometer feel), clipped to one line.
// Only animates when the value actually changes — never on first mount. Pass
// `abbreviate` for a compact "1.2M", or leave it off for the full "1,200,000".
function withCommas(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function FlipNumber({
  value, fontSize, color, weight = '900', abbreviate = false, fitWidth = false,
}: {
  value: number;
  fontSize: number;
  color: string;
  weight?: TextStyle['fontWeight'];
  abbreviate?: boolean;
  // Shrink the whole number (flip animation and all) just enough to fit the width
  // it's given — never enlarges past `fontSize`, never clips. For fixed-width
  // columns like the three notification stat tiles: stays prevalent, never cut off.
  fitWidth?: boolean;
}) {
  const text = abbreviate ? formatCount(value) : withCommas(value);
  const height = Math.round(fontSize * 1.22);
  const [display, setDisplay] = useState(text);
  const [outgoing, setOutgoing] = useState<string | null>(null);
  const anim = useRef(new Animated.Value(1)).current; // 1 = settled (centered)
  // fitWidth: the column's width, and the number's natural width at full size.
  const [availW, setAvailW] = useState(0);
  const [contentW, setContentW] = useState(0);

  useEffect(() => {
    if (text === display) return;
    setOutgoing(display);
    setDisplay(text);
    anim.setValue(0);
    Animated.timing(anim, { toValue: 1, duration: 520, easing: Easing.out(Easing.cubic), useNativeDriver: true })
      .start(({ finished }) => { if (finished) setOutgoing(null); });
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  const base: TextStyle = { fontSize, fontWeight: weight, color, height, lineHeight: height, letterSpacing: -0.5, textAlign: 'center' };
  const inY = anim.interpolate({ inputRange: [0, 1], outputRange: [height, 0] });       // new rolls up from below
  const outY = anim.interpolate({ inputRange: [0, 1], outputRange: [0, -height] });     // old rolls up and out
  const outOpacity = anim.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });

  const odometer = (
    <View
      style={{ height, overflow: 'hidden', justifyContent: 'center' }}
      onLayout={fitWidth ? (e) => setContentW(e.nativeEvent.layout.width) : undefined}
    >
      {outgoing !== null && (
        <Animated.Text numberOfLines={1} style={[base, styles.abs, { transform: [{ translateY: outY }], opacity: outOpacity }]}>
          {outgoing}
        </Animated.Text>
      )}
      <Animated.Text numberOfLines={1} style={[base, { transform: [{ translateY: inY }] }]}>
        {display}
      </Animated.Text>
    </View>
  );

  if (!fitWidth) return odometer;

  // Measured at full size (onLayout is pre-transform), then the whole odometer is
  // scaled uniformly to fit, with 6px of breathing room so it never kisses the
  // edges. Never scales ABOVE 1, so a number that already fits stays at full size.
  const scale = availW > 0 && contentW > 0 ? Math.min(1, (availW - 6) / contentW) : 1;
  return (
    <View
      style={{ width: '100%', height, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}
      onLayout={(e) => setAvailW(e.nativeEvent.layout.width)}
    >
      <View style={{ transform: [{ scale }] }}>{odometer}</View>
    </View>
  );
}

const styles = StyleSheet.create({ abs: { position: 'absolute', left: 0, right: 0 } });
