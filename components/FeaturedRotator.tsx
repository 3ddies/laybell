import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { MAX_FEATURED, type FeaturedItem } from '../lib/musicFeatured';

// The Featured card at the top of a profile's Music tab: up to four picks shown
// ONE AT A TIME on a slow crossfade, each with its artwork, its name, and the
// artist.
//
// One at a time rather than a rail, because a rail of four small covers is a
// list — and a list of four is exactly the size at which nothing in it stands
// out. A single large card is a claim about one thing, made four times.
//
// NOTHING RE-RENDERS WHILE IT ROTATES. Every pick is mounted and stacked, each
// owning an Animated.Value for its own opacity, and a turn is two native-driven
// fades against each other. The live index lives in a ref that the tap handler
// reads, and the dots are Animated views driven by the same values — so a card
// that turns every few seconds for as long as someone is on the page costs no
// React work at all after the first paint.

const HOLD_MS = 5000;
const FADE_MS = 520;
const ART = 112;

export default function FeaturedRotator({
  items, artist, onPress,
}: {
  items: FeaturedItem[];
  /** Shown under every title — a profile's Featured is all one artist's. */
  artist: string;
  onPress: (item: FeaturedItem) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  // A fixed pool, so the values are stable no matter how the picks change. Only
  // the first `items.length` are ever used.
  const opacity = useRef(
    Array.from({ length: MAX_FEATURED }, (_, i) => new Animated.Value(i === 0 ? 1 : 0)),
  ).current;
  const activeRef = useRef(0);
  const keys = items.map((i) => i.key).join('|');

  useEffect(() => {
    if (items.length === 0) return;
    // Reset INSIDE the cycle effect rather than in one of its own, so the order
    // is guaranteed: the picks changed, so whatever was fading is irrelevant and
    // the first one is showing again before anything new starts.
    activeRef.current = 0;
    opacity.forEach((v, i) => v.setValue(i === 0 ? 1 : 0));
    if (items.length < 2) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      timer = setTimeout(() => {
        if (cancelled) return;
        const from = activeRef.current;
        const to = (from + 1) % items.length;
        activeRef.current = to;   // the tap handler is correct from this instant
        Animated.parallel([
          Animated.timing(opacity[from], { toValue: 0, duration: FADE_MS, useNativeDriver: true }),
          Animated.timing(opacity[to], { toValue: 1, duration: FADE_MS, useNativeDriver: true }),
        ]).start(({ finished }) => { if (finished && !cancelled) step(); });
      }, HOLD_MS);
    };
    step();
    // Only the CHAIN is cancelled; in-flight fades land on their own. Stopping a
    // native-driven animation is a round trip that can resolve after whatever we
    // set next, which strands a card half-faded.
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys]);

  if (items.length === 0) return null;

  return (
    <View>
      <TouchableOpacity
        style={styles.card}
        activeOpacity={0.9}
        onPress={() => onPress(items[activeRef.current] ?? items[0])}
      >
        {items.map((it, i) => (
          <Animated.View key={it.key} style={[styles.layer, { opacity: opacity[i] }]}>
            {it.cover ? (
              <Image source={{ uri: it.cover }} style={styles.art} contentFit="cover" cachePolicy="memory-disk" />
            ) : (
              <View style={[styles.art, styles.artEmpty]}>
                <Ionicons name={it.kind === 'album' ? 'disc' : 'musical-note'} size={30} color={colors.textTertiary} />
              </View>
            )}
            <View style={styles.meta}>
              {/* The kind is said in words. An album and a single look identical
                  at this size once the artwork is square, and "which of these am
                  I about to open" is the one thing a tap needs to be sure of. */}
              <Text style={styles.kind}>{it.kind === 'album' ? 'ALBUM' : 'SONG'}</Text>
              <Text style={styles.title} numberOfLines={2}>{it.title}</Text>
              <Text style={styles.artist} numberOfLines={1}>{artist}</Text>
            </View>
          </Animated.View>
        ))}
      </TouchableOpacity>
      {items.length > 1 && (
        <View style={styles.dots} pointerEvents="none">
          {items.map((it, i) => (
            // Driven by the SAME opacity values as the card, so the dots cannot
            // drift out of step with what is showing — there is no second source
            // of truth for them to disagree with.
            <Animated.View key={it.key} style={[styles.dot, { opacity: opacity[i].interpolate({ inputRange: [0, 1], outputRange: [0.25, 1] }) }]} />
          ))}
        </View>
      )}
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  // Fixed height: every pick has the same shape, so the card can crossfade
  // without the page under it moving a pixel.
  card: {
    height: ART + SPACING.md * 2,
    borderRadius: RADIUS.lg,
    backgroundColor: colors.surfaceLight,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    overflow: 'hidden',
  },
  layer: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md, padding: SPACING.md,
  },
  art: { width: ART, height: ART, borderRadius: RADIUS.md, backgroundColor: colors.surfaceElevated },
  artEmpty: { alignItems: 'center', justifyContent: 'center' },
  meta: { flex: 1, justifyContent: 'center' },
  kind: { color: colors.textTertiary, fontSize: 10.5, fontWeight: '800', letterSpacing: 1, marginBottom: 4 },
  title: { color: colors.text, fontSize: 19, fontWeight: '800', letterSpacing: -0.4, lineHeight: 23 },
  artist: { color: colors.textSecondary, fontSize: 13.5, fontWeight: '600', marginTop: 3 },
  dots: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
    gap: 6, marginTop: SPACING.sm,
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.text },
});
