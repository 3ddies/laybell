import { useEffect, useRef, useState } from 'react';
import { View, Text, Animated, Easing, TouchableOpacity, StyleSheet, type StyleProp, type TextStyle } from 'react-native';
import type { Feature } from '../lib/features';

// The cycling bottom-song-card title. Two behaviors:
//  • Long titles that overflow the bar MARQUEE (scroll left, pause, reset).
//  • Songs ≥ 20s WITH features flip between the title and the collaborator
//    credits every 10s (driven by playback position, so it's frame-accurate
//    and naturally "extends the current display to the end" on a partial last
//    interval). Tapping a credited name opens that artist's profile.

const CYCLE_MS = 10_000;
const MIN_DURATION_MS = 20_000;

function Marquee({ text, style }: { text: string; style: StyleProp<TextStyle> }) {
  const [boxW, setBoxW] = useState(0);
  const [textW, setTextW] = useState(0);
  const x = useRef(new Animated.Value(0)).current;
  const overflow = Math.max(0, textW - boxW);

  useEffect(() => {
    x.stopAnimation();
    x.setValue(0);
    if (overflow <= 4) return; // fits (or nearly) → static
    const dist = overflow + 6;
    const dur = dist * 42; // ~42ms/px — an unhurried read
    const loop = Animated.loop(Animated.sequence([
      Animated.delay(1400),
      Animated.timing(x, { toValue: -dist, duration: dur, easing: Easing.linear, useNativeDriver: true }),
      Animated.delay(900),
      Animated.timing(x, { toValue: 0, duration: Math.min(dur, 500), easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [overflow, text, x]);

  return (
    <View style={styles.clip} onLayout={(e) => setBoxW(e.nativeEvent.layout.width)}>
      <Animated.Text
        numberOfLines={1}
        style={[style, styles.marqueeText, { transform: [{ translateX: x }] }]}
        onLayout={(e) => setTextW(e.nativeEvent.layout.width)}
      >
        {text}
      </Animated.Text>
    </View>
  );
}

export default function SongCardTitle({
  title, features, positionMs, durationMs, titleStyle, featStyle, onOpenProfile,
}: {
  title: string;
  features: Feature[];
  positionMs: number;
  durationMs: number;
  titleStyle: StyleProp<TextStyle>;
  featStyle?: StyleProp<TextStyle>;
  onOpenProfile: (id: string) => void;
}) {
  const canCycle = durationMs >= MIN_DURATION_MS && features.length > 0;
  const showFeatures = canCycle && Math.floor(positionMs / CYCLE_MS) % 2 === 1;

  // Crossfade whenever the displayed side flips.
  const fade = useRef(new Animated.Value(1)).current;
  const prev = useRef(showFeatures);
  useEffect(() => {
    if (prev.current === showFeatures) return;
    prev.current = showFeatures;
    fade.setValue(0);
    Animated.timing(fade, { toValue: 1, duration: 260, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }, [showFeatures, fade]);

  return (
    <Animated.View style={{ opacity: fade }}>
      {showFeatures ? (
        <View style={styles.featRow}>
          <Text style={[featStyle ?? titleStyle, styles.featLabel]} numberOfLines={1}>feat. </Text>
          <View style={styles.featNames}>
            {features.map((f, i) => (
              <TouchableOpacity key={f.id} onPress={() => onOpenProfile(f.id)} hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}>
                <Text style={[featStyle ?? titleStyle, styles.featName]} numberOfLines={1}>
                  {f.name}{i < features.length - 1 ? ', ' : ''}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      ) : (
        <Marquee text={title} style={titleStyle} />
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden', flexDirection: 'row' },
  marqueeText: { flexShrink: 0 },
  featRow: { flexDirection: 'row', alignItems: 'center' },
  featLabel: { opacity: 0.7, flexShrink: 0 },
  featNames: { flex: 1, flexDirection: 'row', overflow: 'hidden' },
  featName: { fontWeight: '700', textDecorationLine: 'underline', flexShrink: 0 },
});
