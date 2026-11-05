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
  value, fontSize, color, weight = '900', abbreviate = false,
}: {
  value: number;
  fontSize: number;
  color: string;
  weight?: TextStyle['fontWeight'];
  abbreviate?: boolean;
}) {
  const text = abbreviate ? formatCount(value) : withCommas(value);
  const height = Math.round(fontSize * 1.22);
  const [display, setDisplay] = useState(text);
  const [outgoing, setOutgoing] = useState<string | null>(null);
  const anim = useRef(new Animated.Value(1)).current; // 1 = settled (centered)

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

  return (
    <View style={{ height, overflow: 'hidden', justifyContent: 'center' }}>
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
}

const styles = StyleSheet.create({ abs: { position: 'absolute', left: 0, right: 0 } });
