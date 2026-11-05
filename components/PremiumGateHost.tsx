import { useEffect, useRef, useState } from 'react';
import { Modal, View, Text, StyleSheet, TouchableOpacity, Animated, Easing, Dimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SPACING, RADIUS, GRADIENTS, PLUS_RED } from '../constants/theme';
import EqBars from './EqBars';
import { subscribePremiumGate, type PremiumGateOpts } from '../lib/premiumGate';

// Lush 3-stop gold for the "earn it at Gold badge" variant (matches the badge emblem gold).
const GOLD = ['#FDE68A', '#F59E0B', '#B45309'];

// The Gold-badge variant's backdrop: a glossy white light-streak that sweeps diagonally
// across the gold (like light catching metal), plus a scatter of twinkling sparkles on
// two opposite phases so the shimmer feels organic rather than ticking in unison.
function GoldShine() {
  const sweep = useRef(new Animated.Value(0)).current;
  const twinkle = useRef(new Animated.Value(0)).current;
  const { width, height } = Dimensions.get('window');
  useEffect(() => {
    const s = Animated.loop(Animated.sequence([
      Animated.timing(sweep, { toValue: 1, duration: 2100, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.delay(1000),
    ]));
    const t = Animated.loop(Animated.sequence([
      Animated.timing(twinkle, { toValue: 1, duration: 1300, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(twinkle, { toValue: 0, duration: 1300, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    s.start(); t.start();
    return () => { s.stop(); t.stop(); };
  }, [sweep, twinkle]);
  const translateX = sweep.interpolate({ inputRange: [0, 1], outputRange: [-width * 1.3, width * 1.3] });
  const onPhase = twinkle.interpolate({ inputRange: [0, 1], outputRange: [0.12, 0.95] });
  const offPhase = twinkle.interpolate({ inputRange: [0, 1], outputRange: [0.95, 0.12] });
  const scaleOn = twinkle.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1.15] });
  const scaleOff = twinkle.interpolate({ inputRange: [0, 1], outputRange: [1.15, 0.7] });
  const spots: [number, number, number][] = [
    [0.17, 0.24, 20], [0.82, 0.19, 14], [0.27, 0.7, 15],
    [0.74, 0.66, 22], [0.5, 0.13, 13], [0.56, 0.82, 18],
  ];
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Animated.View style={{ position: 'absolute', top: -height * 0.3, bottom: -height * 0.3, width: width * 0.45, transform: [{ translateX }, { rotate: '18deg' }] }}>
        <LinearGradient colors={['rgba(255,255,255,0)', 'rgba(255,255,255,0.4)', 'rgba(255,255,255,0)']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ flex: 1 }} />
      </Animated.View>
      {spots.map(([fx, fy, size], i) => (
        <Animated.View key={i} style={{ position: 'absolute', left: width * fx, top: height * fy, opacity: i % 2 ? offPhase : onPhase, transform: [{ scale: i % 2 ? scaleOff : scaleOn }] }}>
          <Ionicons name="sparkles" size={size} color="rgba(255,255,255,0.92)" />
        </Animated.View>
      ))}
    </View>
  );
}

// The app-wide "unlock this feature" page. Any gated feature calls openPremiumGate({
// feature, tier }) and this slides up full-screen in the paywall's own language — the
// rising bubbles over the tier gradient (brand orange for Premium, cinematic red for
// Premium+) — names the feature, and sends the viewer to the paywall to buy. Mounted
// ONCE at the root (app/_layout), a sibling of the app content so it overlays everything.
export default function PremiumGateHost() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [opts, setOpts] = useState<PremiumGateOpts | null>(null);
  const enter = useRef(new Animated.Value(0)).current; // content fade/scale in
  const pulse = useRef(new Animated.Value(0)).current; // badge breathing loop

  useEffect(() => subscribePremiumGate((o) => setOpts(o)), []);

  useEffect(() => {
    if (!opts) return;
    enter.setValue(0);
    Animated.timing(enter, { toValue: 1, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 1500, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0, duration: 1500, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [opts, enter, pulse]);

  if (!opts) return null;
  const plus = opts.tier === 'premiumPlus';
  const gold = opts.badge === 'gold'; // earned-not-bought variant
  const tierName = plus ? 'Premium+' : 'Premium';
  const gradient = (gold ? GOLD : plus ? PLUS_RED : GRADIENTS.primary) as any;
  const ctaColor = (gold ? '#7A3E00' : plus ? PLUS_RED[1] : GRADIENTS.primary[0]) as string; // deep tier color for the white CTA
  const close = () => setOpts(null);
  const act = () => { close(); router.push(gold ? '/badges' : '/premium'); };
  const bodyAnim = { opacity: enter, transform: [{ scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }] };
  const badgeAnim = { transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.09] }) }] };

  return (
    <Modal visible animationType="slide" statusBarTranslucent onRequestClose={close}>
      <View style={styles.full}>
        <LinearGradient colors={gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
        {/* Premium tiers get the music-native equalizer rising from the bottom; the Gold
            BADGE variant gets a glossy shine sweep + twinkle instead (it's an earned
            achievement, not a music feature). Both read as white over the tier gradient. */}
        {gold
          ? <GoldShine />
          : <EqBars color="rgba(255,255,255,0.42)" count={22} height={240} style={styles.eq} />}

        <View style={[styles.content, { paddingTop: insets.top + SPACING.md, paddingBottom: insets.bottom + 270 }]}>
          <TouchableOpacity style={styles.close} onPress={close} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
            <Ionicons name="close" size={28} color="rgba(255,255,255,0.92)" />
          </TouchableOpacity>

          <Animated.View style={[styles.body, bodyAnim]}>
            <Animated.View style={[styles.badge, badgeAnim]}>
              <Ionicons name={gold ? 'trophy' : plus ? 'diamond' : 'star'} size={38} color="#fff" />
            </Animated.View>
            <Text style={styles.eyebrow}>{gold ? 'GOLD BADGE' : `LAYBELL ${tierName.toUpperCase()}`}</Text>
            <Text style={styles.title}>{opts.feature}</Text>
            <Text style={styles.tagline}>{opts.blurb || (gold ? `Unlocks when you reach Gold badge status. Keep creating to earn it.` : `Unlock ${opts.feature} with Laybell ${tierName}.`)}</Text>
          </Animated.View>

          <Animated.View style={{ opacity: enter }}>
            <TouchableOpacity activeOpacity={0.9} onPress={act} style={styles.cta}>
              <Text style={[styles.ctaText, { color: ctaColor }]}>{gold ? 'See how to earn it' : `Get ${tierName}`}</Text>
              <Ionicons name="arrow-forward" size={18} color={ctaColor} />
            </TouchableOpacity>
          </Animated.View>
        </View>

        {/* Pinned to the very bottom, over the equalizer — plain bold white (with a shadow) so
            it stays readable across the bars. */}
        <TouchableOpacity onPress={close} hitSlop={8} style={[styles.laterBtn, { bottom: insets.bottom + SPACING.md }]}>
          <Text style={styles.later}>Maybe later</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  full: { flex: 1 },
  eq: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 240 },
  content: { flex: 1, paddingHorizontal: SPACING.xl },
  close: { alignSelf: 'flex-end', padding: SPACING.xs },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, paddingTop: 60 },
  badge: {
    width: 80, height: 80, borderRadius: 40, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)',
    marginBottom: SPACING.sm,
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 16, shadowOffset: { width: 0, height: 6 },
  },
  eyebrow: { color: 'rgba(255,255,255,0.92)', fontSize: 13, fontWeight: '800', letterSpacing: 2, textShadowColor: 'rgba(0,0,0,0.25)', textShadowRadius: 6 },
  title: { color: '#fff', fontSize: 30, fontWeight: '900', textAlign: 'center', letterSpacing: -0.5, lineHeight: 34, textShadowColor: 'rgba(0,0,0,0.3)', textShadowRadius: 10 },
  tagline: { color: 'rgba(255,255,255,0.95)', fontSize: 15.5, textAlign: 'center', lineHeight: 22, maxWidth: 320, marginTop: SPACING.xs, textShadowColor: 'rgba(0,0,0,0.25)', textShadowRadius: 8 },
  footer: { gap: SPACING.md, alignItems: 'center' },
  cta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: '#fff', borderRadius: RADIUS.full, paddingVertical: 18, paddingHorizontal: SPACING.xl,
    alignSelf: 'stretch',
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 4,
  },
  ctaText: { fontSize: 17, fontWeight: '800', letterSpacing: 0.2 },
  laterBtn: { position: 'absolute', left: 0, right: 0, alignItems: 'center', paddingVertical: 10 },
  later: { color: '#fff', fontSize: 15, fontWeight: '800', textShadowColor: 'rgba(0,0,0,0.45)', textShadowRadius: 6 },
});
