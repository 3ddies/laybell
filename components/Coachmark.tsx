import { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, Easing, Dimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SPACING, RADIUS, GRADIENTS } from '../constants/theme';
import type { CoachTarget } from '../lib/coachmarks';

// The app's two coachmark looks. Each takes the COLOR of the feature it explains (pass
// `gradient` + `accent`) so a tip reads as part of that feature, not a generic orange
// banner. Keep copy to a line — nobody reads a paragraph on a tooltip.
//   <CoachmarkCard title=… body=… gradient={…} accent="#…" onDismiss={tip.markSeen} />   // full-screen
//   <CoachmarkPointer target={target} title=… gradient={…} onDismiss={tip.markSeen} />   // arrow at an element

// A full-screen page in the feature's color: big icon, a title, ONE line, a single
// button. Same shape as the premium gate, so every overview feels like one family.
export function CoachmarkCard({
  title, body, ctaLabel, onDismiss, icon, gradient = GRADIENTS.primary, accent,
}: {
  title: string;
  body?: string;
  ctaLabel?: string;
  onDismiss: () => void;
  icon?: string;
  gradient?: readonly string[];
  accent?: string; // deep feature color for the white button's text
}) {
  const insets = useSafeAreaInsets();
  const enter = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(enter, { toValue: 1, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 1500, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0, duration: 1500, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [enter, pulse]);
  const bodyAnim = { opacity: enter, transform: [{ scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }] };
  const badgeAnim = { transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] }) }] };
  const ctaColor = accent || (gradient[0] as string);
  return (
    <View style={styles.full}>
      <LinearGradient colors={gradient as any} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      <View style={[styles.cardContent, { paddingTop: insets.top + SPACING.md, paddingBottom: insets.bottom + SPACING.xl }]}>
        <TouchableOpacity style={styles.close} onPress={onDismiss} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
          <Ionicons name="close" size={28} color="rgba(255,255,255,0.92)" />
        </TouchableOpacity>
        <Animated.View style={[styles.cardBody, bodyAnim]}>
          {!!icon && (
            <Animated.View style={[styles.badge, badgeAnim]}>
              <Ionicons name={icon as any} size={40} color="#fff" />
            </Animated.View>
          )}
          <Text style={styles.title}>{title}</Text>
          {!!body && <Text style={styles.sub}>{body}</Text>}
        </Animated.View>
        <Animated.View style={{ opacity: enter, alignSelf: 'stretch' }}>
          <TouchableOpacity activeOpacity={0.9} onPress={onDismiss} style={styles.cta}>
            <Text style={[styles.ctaText, { color: ctaColor }]}>{ctaLabel || 'Got it'}</Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </View>
  );
}

// A small card with a caret aimed at a measured element, in the feature's color.
// Tapping it (or waiting out autoDismissMs) dismisses; onPress fires first so it can
// also navigate.
export function CoachmarkPointer({
  target, title, body, onDismiss, onPress, autoDismissMs, gradient = GRADIENTS.primary,
}: {
  target: CoachTarget;
  title?: string;
  body?: string;
  onDismiss: () => void;
  onPress?: () => void;
  autoDismissMs?: number;
  gradient?: readonly string[];
}) {
  const enter = useRef(new Animated.Value(0)).current;
  const rect = target.rect;
  useEffect(() => {
    if (rect) Animated.timing(enter, { toValue: 1, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [rect, enter]);
  useEffect(() => {
    if (!autoDismissMs) return;
    const id = setTimeout(() => onDismiss(), autoDismissMs);
    return () => clearTimeout(id);
  }, [autoDismissMs, onDismiss]);

  if (!rect) return null; // wait until the target has been measured
  const caretColor = gradient[gradient.length - 1] as string;
  const { width: screenW, height: screenH } = Dimensions.get('window');
  const cx = rect.x + rect.w / 2;
  const below = rect.y + rect.h / 2 < screenH * 0.5; // target in top half → card below it
  const rightSide = cx > screenW / 2;
  const cardAnim = {
    opacity: enter,
    transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: below ? [-6, 0] : [6, 0] }) }],
  };
  const card = (
    <Animated.View style={[styles.ptrWrap, { alignSelf: rightSide ? 'flex-end' : 'flex-start' }, below ? { marginTop: 10 } : { marginBottom: 10 }, cardAnim]}>
      <TouchableOpacity activeOpacity={0.92} onPress={() => { onPress?.(); onDismiss(); }}>
        <LinearGradient colors={gradient as any} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.ptrCard}>
          {!!title && <Text style={styles.ptrTitle}>{title}</Text>}
          {!!body && <Text style={styles.ptrBody}>{body}</Text>}
        </LinearGradient>
      </TouchableOpacity>
    </Animated.View>
  );
  const caret = <View style={[styles.caret, below ? { top: 0, borderBottomWidth: 10, borderBottomColor: caretColor } : { bottom: 0, borderTopWidth: 10, borderTopColor: caretColor }, { left: cx - 9 }]} />;
  const containerStyle = below
    ? { position: 'absolute' as const, left: 0, right: 0, top: rect.y + rect.h + 6, zIndex: 60 }
    : { position: 'absolute' as const, left: 0, right: 0, bottom: screenH - rect.y + 6, zIndex: 60 };
  return (
    <View pointerEvents="box-none" style={containerStyle}>
      {below ? <>{caret}{card}</> : <>{card}{caret}</>}
    </View>
  );
}

const styles = StyleSheet.create({
  // ── Full-screen card ──
  full: { ...StyleSheet.absoluteFillObject, zIndex: 60 },
  cardContent: { flex: 1, paddingHorizontal: SPACING.xl },
  close: { alignSelf: 'flex-end', padding: SPACING.xs },
  cardBody: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm },
  badge: {
    width: 84, height: 84, borderRadius: 42, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)',
    marginBottom: SPACING.sm,
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 16, shadowOffset: { width: 0, height: 6 },
  },
  title: { color: '#fff', fontSize: 30, fontWeight: '900', textAlign: 'center', letterSpacing: -0.5, textShadowColor: 'rgba(0,0,0,0.3)', textShadowRadius: 10 },
  sub: { color: 'rgba(255,255,255,0.95)', fontSize: 16, textAlign: 'center', lineHeight: 22, maxWidth: 320, marginTop: SPACING.xs, textShadowColor: 'rgba(0,0,0,0.25)', textShadowRadius: 8 },
  cta: {
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#fff', borderRadius: RADIUS.full, paddingVertical: 18, paddingHorizontal: SPACING.xl, alignSelf: 'stretch',
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 4,
  },
  ctaText: { fontSize: 17, fontWeight: '800', letterSpacing: 0.2 },

  // ── Pointer ──
  ptrWrap: { maxWidth: 290, marginHorizontal: 12 },
  ptrCard: {
    borderRadius: 12, paddingVertical: 10, paddingHorizontal: 13, gap: 2,
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 6,
  },
  ptrTitle: { color: '#fff', fontSize: 13.5, fontWeight: '800' },
  ptrBody: { color: 'rgba(255,255,255,0.92)', fontSize: 11.5 },
  caret: { position: 'absolute', width: 0, height: 0, borderLeftWidth: 9, borderRightWidth: 9, borderLeftColor: 'transparent', borderRightColor: 'transparent' },
});
