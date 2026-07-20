import { Text, StyleSheet, Animated, Easing } from 'react-native';
import { useEffect, useRef } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

// A soft "turn your phone for fullscreen" nudge shown in the BLACK letterbox band
// above a horizontal reel while it's being watched in portrait. Landscape
// fullscreen is otherwise undiscoverable — nothing on screen suggests rotating
// works — so this sits in space that's already empty rather than over the video.
//
// Deliberately transient: it fades in, holds a few seconds, then fades out, and
// re-appears on the next horizontal reel. A permanently animating element in the
// viewer's peripheral vision would compete with the video itself.
export default function RotateHint({ visible, top }: { visible: boolean; top: number }) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const fade = useRef(new Animated.Value(0)).current;
  const tilt = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) { fade.stopAnimation(); fade.setValue(0); return; }
    // Show → hold → hide.
    const show = Animated.sequence([
      Animated.timing(fade, { toValue: 1, duration: 380, useNativeDriver: true }),
      Animated.delay(4200),
      Animated.timing(fade, { toValue: 0, duration: 700, useNativeDriver: true }),
    ]);
    // Gentle rock on the icon — reads as "turn me" without shouting.
    const rock = Animated.loop(
      Animated.sequence([
        Animated.timing(tilt, { toValue: 1, duration: 850, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(tilt, { toValue: 0, duration: 850, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    show.start();
    rock.start();
    return () => { show.stop(); rock.stop(); };
  }, [visible]);

  if (!visible) return null;

  const rotate = tilt.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '-20deg'] });

  return (
    <Animated.View style={[styles.wrap, { top, opacity: fade }]} pointerEvents="none">
      <Animated.View style={{ transform: [{ rotate }] }}>
        <Ionicons name="phone-landscape-outline" size={16} color="#fff" />
      </Animated.View>
      <Text style={styles.text}>{t('reel.rotateForFullscreen')}</Text>
    </Animated.View>
  );
}

const makeStyles = (_c: ThemePalette) => StyleSheet.create({
  wrap: {
    position: 'absolute', alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: 7,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.md, paddingVertical: 8,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.18)',
  },
  text: { color: '#fff', fontSize: 12.5, fontWeight: '700', letterSpacing: -0.1 },
});
