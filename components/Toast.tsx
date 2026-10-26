import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, isDarkPalette, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';

type Props = {
  visible: boolean;
  title: string;
  message?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  /** Auto-dismiss delay in ms. */
  duration?: number;
  /** Extra lift above the safe-area inset — clears a bottom bar when present. */
  bottomOffset?: number;
  /** When set, the toast becomes tappable (shows a chevron) and runs this on press. */
  onPress?: () => void;
  onHide: () => void;
};

// iOS-style confirmation banner: a frosted card that springs up from the bottom
// and auto-dismisses. Self-contained (no provider) — render it where you need it
// and drive `visible`. The surface is a real BlurView material (matching the
// mini-player / tab bar) with a continuous-radius corner, a hairline edge and a
// soft diffuse shadow, so it reads as a native notification rather than a flat
// Android card.
export default function Toast({
  visible,
  title,
  message,
  icon = 'checkmark-circle',
  duration = 2600,
  bottomOffset = SPACING.xl,
  onPress,
  onHide,
}: Props) {
  const insets = useSafeAreaInsets();
  const { mode, colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const anim = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!visible) return;
    anim.setValue(0);
    Animated.spring(anim, { toValue: 1, useNativeDriver: true, friction: 9, tension: 60 }).start();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(hide, duration);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  function hide() {
    Animated.timing(anim, { toValue: 0, duration: 200, useNativeDriver: true }).start(({ finished }) => {
      if (finished) onHide();
    });
  }

  if (!visible) return null;
  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [40, 0] });

  const card = (
    // Shadow lives on the outer wrapper so it isn't clipped by the blur's
    // overflow:hidden; the BlurView itself carries the rounded, clipped surface.
    <View style={styles.shadow}>
      <BlurView
        tint={mode === 'light' ? 'systemChromeMaterialLight' : 'systemChromeMaterialDark'}
        intensity={60}
        style={styles.card}
      >
        {/* Legibility tint over the blur — floats over arbitrary feed content, so
            the material alone isn't opaque enough to keep text crisp. */}
        <View pointerEvents="none" style={styles.tint} />
        <Ionicons name={icon} size={23} color={colors.primary} />
        <View style={styles.body}>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          {!!message && <Text style={styles.message} numberOfLines={2}>{message}</Text>}
        </View>
        {!!onPress && <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />}
      </BlurView>
    </View>
  );

  return (
    // No onPress → pointerEvents none so the toast never swallows taps meant for the
    // UI behind it. With onPress → box-none lets the card itself be tapped while
    // empty margins still pass touches through.
    <Animated.View
      pointerEvents={onPress ? 'box-none' : 'none'}
      style={[styles.wrap, { bottom: insets.bottom + bottomOffset, opacity: anim, transform: [{ translateY }] }]}
    >
      {onPress
        ? <Pressable onPress={() => { onPress(); hide(); }} style={({ pressed }) => (pressed ? { opacity: 0.9, transform: [{ scale: 0.99 }] } : null)}>{card}</Pressable>
        : card}
    </Animated.View>
  );
}

const RADIUS_BANNER = 24; // continuous iOS-banner corner, between RADIUS.lg and .xl

const makeStyles = (colors: ThemePalette) => {
  const dark = isDarkPalette(colors);
  return StyleSheet.create({
    wrap: { position: 'absolute', left: SPACING.md, right: SPACING.md, zIndex: 1000 },
    // Carries the soft, diffuse drop shadow (iOS casts it from the rounded bounds;
    // Android uses elevation). No overflow here so the shadow isn't clipped.
    shadow: {
      borderRadius: RADIUS_BANNER,
      shadowColor: '#000',
      shadowOpacity: dark ? 0.4 : 0.16,
      shadowRadius: 22,
      shadowOffset: { width: 0, height: 10 },
      elevation: 12,
    },
    card: {
      flexDirection: 'row', alignItems: 'center', gap: SPACING.sm + 2,
      borderRadius: RADIUS_BANNER, overflow: 'hidden',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.08)',
      // Thicker top/bottom than the old 12px so the banner feels substantial.
      paddingVertical: 18, paddingHorizontal: SPACING.md + 2,
    },
    // Sits over the blur (first child, absolute) and under the content.
    tint: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: dark ? 'rgba(22,22,24,0.55)' : 'rgba(255,255,255,0.6)',
    },
    body: { flex: 1 },
    title: { color: colors.text, fontSize: 15, fontWeight: '600', letterSpacing: -0.3 },
    message: { color: colors.textSecondary, fontSize: 13, fontWeight: '400', marginTop: 2, lineHeight: 18 },
  });
};
