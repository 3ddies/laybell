import { useEffect, useRef, useState, type ReactNode } from 'react';
import { View, Text, Animated, Easing, TouchableOpacity, StyleSheet, type StyleProp, type TextStyle } from 'react-native';
import { featureKey, type Feature } from '../lib/features';

// The cycling song-card title, used by the bottom mini player AND the full
// Spotify-style player. Two behaviors:
//  • A title (or feature list) that FITS shows on one line, centred on the full
//    player / left-aligned on the bar.
//  • One that OVERFLOWS marquees: scrolls left through the whole name, pauses,
//    snaps back — like other music apps. Feature names stay tappable while
//    scrolling.
//  • Songs >= 20s WITH features flip between the title and the credits every
//    10s (position-driven, so a partial last interval holds to the song's end).
//
// The marquee measures the content's TRUE single-line width in an unconstrained
// off-screen pass, then sizes the visible row to exactly that — otherwise the
// text wraps/truncates inside the bounded card and never overflows to scroll.

const CYCLE_MS = 10_000;
const MIN_DURATION_MS = 20_000;
// Must comfortably exceed the widest a max-length title/feature-list can be at
// the largest card font — otherwise the measurer wraps and the scroll can't
// reveal the whole name. The composer caps titles at 80 chars (~1200px at the
// full-player font), so 4000 leaves a wide margin (and covers long credit rows).
const MEASURE_W = 4000;

// Exported: the TV remote reuses this for long video titles (scroll-through,
// pause, snap back — same behavior as the song card).
export function Marquee({ centered, children }: { centered?: boolean; children: ReactNode }) {
  const [boxW, setBoxW] = useState(0);
  const [contentW, setContentW] = useState(0);
  const x = useRef(new Animated.Value(0)).current;
  // Content is held INVISIBLE until both measurements land, then faded in at
  // its final position. Without this, every fresh mount (= every song change,
  // since the title is keyed) painted the first frames unmeasured: short
  // titles appeared left-aligned then SNAPPED to center, and long titles
  // wrapped to multiple lines then collapsed to the single marquee row —
  // the sideways/vertical title lurch visible on song transitions.
  const reveal = useRef(new Animated.Value(0)).current;
  const overflow = Math.max(0, contentW - boxW);
  const fits = boxW > 0 && overflow <= 2;
  const measured = boxW > 0 && contentW > 0;

  useEffect(() => {
    if (measured) {
      Animated.timing(reveal, { toValue: 1, duration: 160, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
    }
  }, [measured, reveal]);

  useEffect(() => {
    x.stopAnimation();
    x.setValue(0);
    if (boxW <= 0 || overflow <= 2) return;
    const dist = overflow + 8;
    const dur = dist * 42; // ~42ms/px — an unhurried read
    const loop = Animated.loop(Animated.sequence([
      Animated.delay(1400),
      Animated.timing(x, { toValue: -dist, duration: dur, easing: Easing.linear, useNativeDriver: true }),
      Animated.delay(900),
      Animated.timing(x, { toValue: 0, duration: Math.min(dur, 480), easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [overflow, boxW, x]);

  return (
    <View
      style={[styles.clip, centered && fits && styles.clipCentered]}
      onLayout={(e) => setBoxW(e.nativeEvent.layout.width)}
    >
      {/* Off-screen measurer with unbounded width → children never wrap, so the
          inner row reports the true single-line content width. */}
      <View style={styles.measurer} pointerEvents="none">
        <View style={styles.measureInner} onLayout={(e) => setContentW(e.nativeEvent.layout.width)}>
          {children}
        </View>
      </View>
      {/* Visible content, sized to its true width so it lays out on one line and
          overflows the clip (scrolled by translateX). Pre-measure it gets the
          measurer's unbounded width — hidden anyway, but it keeps the row a
          single line tall so the surrounding layout never jumps vertically. */}
      <Animated.View
        style={[
          styles.row,
          { width: contentW || MEASURE_W },
          { transform: [{ translateX: x }], opacity: measured ? reveal : 0 },
        ]}
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

  // A fresh Marquee instance per side (keyed) so measurement re-runs cleanly on
  // the flip and on song changes.
  return (
    // alignSelf:stretch so the title always fills the available width and has a
    // real box to overflow against. The bottom bar already stretches (its parent
    // stretches children); the full player's `meta` centres children, which
    // otherwise shrink-wraps this to the text and kills the overflow → no scroll.
    <Animated.View style={[styles.root, { opacity: fade }]}>
      {showFeatures ? (
        <Marquee key={'f:' + features.map(featureKey).join(',')} centered={centered}>
          <Text style={[fStyle, styles.featLabel]}>feat. </Text>
          {/* A credit with no id is someone who is not on Laybell: their name
              shows, but there is no profile to open, so it renders as plain text
              rather than a control that goes nowhere. Keyed by featureKey — every
              off-platform credit has a null id and would otherwise collide. */}
          {features.map((f, i) => {
            const label = `${f.name}${i < features.length - 1 ? ', ' : ''}`;
            return f.id ? (
              <TouchableOpacity key={featureKey(f)} onPress={() => onOpenProfile(f.id!)} hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}>
                <Text style={[fStyle, styles.featName]}>{label}</Text>
              </TouchableOpacity>
            ) : (
              <Text key={featureKey(f)} style={[fStyle, styles.featName, styles.featPlain]}>{label}</Text>
            );
          })}
        </Marquee>
      ) : (
        <Marquee key={'t:' + title} centered={centered}>
          <Text style={titleStyle}>{title}</Text>
        </Marquee>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { alignSelf: 'stretch' },
  clip: { overflow: 'hidden', flexDirection: 'row' },
  clipCentered: { justifyContent: 'center' },
  measurer: { position: 'absolute', left: 0, top: 0, opacity: 0, width: MEASURE_W },
  measureInner: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center' },
  featLabel: { opacity: 0.7 },
  featName: { fontWeight: '700', textDecorationLine: 'underline' },
  // The underline IS the affordance — it says "this opens a profile". A credit
  // with nowhere to go must not wear it, or it reads as a link that does
  // nothing, which is worse than a plain name.
  featPlain: { textDecorationLine: 'none' },
});
