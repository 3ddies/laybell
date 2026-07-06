import { useEffect, useRef, useState, type ReactNode } from 'react';
import { View, Text, Animated, Easing, TouchableOpacity, StyleSheet, type StyleProp, type TextStyle } from 'react-native';
import type { Feature } from '../lib/features';

// The cycling song-card title, used by the bottom mini player AND the full
// Spotify-style player. Two behaviors:
//  • Anything that overflows the card (a long title OR a long feature list)
//    MARQUEES: scrolls left, pauses, snaps back — like other music apps.
//  • Songs >= 20s WITH features flip between the title and the collaborator
//    credits every 10s (position-driven, so a partial last interval naturally
//    holds to the song's end). Tapping a credited name (even mid-scroll) opens
//    that artist's profile.
// `centered` (full player) centres content that fits; the bottom bar left-aligns.

const CYCLE_MS = 10_000;
const MIN_DURATION_MS = 20_000;

// Marquees any row content when it overflows its box. Measures the content
// (an inner row) vs the clip; only animates past a small threshold.
function Marquee({ centered, children }: { centered?: boolean; children: ReactNode }) {
  const [boxW, setBoxW] = useState(0);
  const [contentW, setContentW] = useState(0);
  const x = useRef(new Animated.Value(0)).current;
  const overflow = Math.max(0, contentW - boxW);
  const fits = overflow <= 4;

  useEffect(() => {
    x.stopAnimation();
    x.setValue(0);
    if (fits) return;
    const dist = overflow + 6;
    const dur = dist * 42; // ~42ms/px — an unhurried read
    const loop = Animated.loop(Animated.sequence([
      Animated.delay(1400),
      Animated.timing(x, { toValue: -dist, duration: dur, easing: Easing.linear, useNativeDriver: true }),
      Animated.delay(900),
      Animated.timing(x, { toValue: 0, duration: Math.min(dur, 480), easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [overflow, fits, x]);

  return (
    <View
      style={[styles.clip, centered && fits && styles.clipCentered]}
      onLayout={(e) => setBoxW(e.nativeEvent.layout.width)}
    >
      <Animated.View
        style={[styles.row, { transform: [{ translateX: x }] }]}
        onLayout={(e) => setContentW(e.nativeEvent.layout.width)}
      >
        {children}
      </Animated.View>
    </View>
  );
}

export default function SongCardTitle({
  title, features, positionMs, durationMs, titleStyle, featStyle, onOpenProfile, centered = false,
}: {
  title: string;
  features: Feature[];
  positionMs: number;
  durationMs: number;
  titleStyle: StyleProp<TextStyle>;
  featStyle?: StyleProp<TextStyle>;
  onOpenProfile: (id: string) => void;
  centered?: boolean;
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

  const fStyle = featStyle ?? titleStyle;

  return (
    <Animated.View style={{ opacity: fade }}>
      {showFeatures ? (
        <Marquee centered={centered}>
          <Text style={[fStyle, styles.featLabel]}>feat. </Text>
          {features.map((f, i) => (
            <TouchableOpacity key={f.id} onPress={() => onOpenProfile(f.id)} hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}>
              <Text style={[fStyle, styles.featName]}>
                {f.name}{i < features.length - 1 ? ', ' : ''}
              </Text>
            </TouchableOpacity>
          ))}
        </Marquee>
      ) : (
        <Marquee centered={centered}>
          <Text style={[titleStyle, styles.noShrink]}>{title}</Text>
        </Marquee>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden', flexDirection: 'row' },
  clipCentered: { justifyContent: 'center' },
  // The scrolling content is a single inline row sized to its content (never
  // shrinks), so it can exceed the clip and be marqueed.
  row: { flexDirection: 'row', alignItems: 'center', flexShrink: 0 },
  noShrink: { flexShrink: 0 },
  featLabel: { opacity: 0.7, flexShrink: 0 },
  featName: { fontWeight: '700', textDecorationLine: 'underline', flexShrink: 0 },
});
