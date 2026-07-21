import { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Pressable, Modal, Platform, Animated, Easing,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { useListenMode, setLeaveConfirmHandler } from '../contexts/ListenModeContext';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';

// Themed replacement for the system Alert that used to gate leaving Listen mode
// for an immersive surface (a reel / livestream). Same centered confirm-card
// family as BlockConfirm / the "leaving Laybell" interstitial — fade + scale
// entrance, tap-the-backdrop to cancel. It registers itself as the handler the
// ListenModeContext bridge calls, so `confirmLeaveListen(proceed)` opens THIS
// card. Mounted once in the app overlays (app/_layout), low enough that toggling
// it never re-renders the provider tree.

export default function ListenLeaveConfirm() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { setListenMode } = useListenMode();

  const [mounted, setMounted] = useState(false);
  const proceedRef = useRef<(() => void) | null>(null);
  const closingRef = useRef(false);
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    setLeaveConfirmHandler((proceed) => {
      proceedRef.current = proceed;
      closingRef.current = false;
      setMounted(true);
      anim.setValue(0);
      Animated.timing(anim, { toValue: 1, duration: 190, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    });
    return () => setLeaveConfirmHandler(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function close() {
    if (closingRef.current) return;
    closingRef.current = true;
    Animated.timing(anim, { toValue: 0, duration: 150, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(() => {
      if (!closingRef.current) return;
      setMounted(false);
      proceedRef.current = null;
    });
  }

  // Accept → leave Listen mode FIRST (so the destination never renders a frame
  // with the mode still on), then run the held navigation. The card fades out on
  // its own overlay behind the transition.
  function onWatch() {
    const proceed = proceedRef.current;
    setListenMode(false);
    close();
    proceed?.();
  }

  const content = (
    <View style={styles.root}>
      <Animated.View style={[styles.backdrop, { opacity: anim }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} />
      </Animated.View>

      <Animated.View
        style={[
          styles.card,
          { opacity: anim, transform: [{ scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }] },
        ]}
      >
        <View style={styles.icon}><Ionicons name="headset" size={26} color={colors.primary} /></View>
        <Text style={styles.title}>{t('music.leaveListenTitle')}</Text>
        <Text style={styles.body}>{t('music.leaveListenBody')}</Text>

        <TouchableOpacity style={styles.watchBtn} onPress={onWatch} activeOpacity={0.85}>
          <LinearGradient
            colors={GRADIENTS.primary as any}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.watchGrad}
          >
            <Text style={styles.watchText}>{t('music.leaveListenConfirm')}</Text>
          </LinearGradient>
        </TouchableOpacity>
        <TouchableOpacity style={styles.cancelBtn} onPress={close} activeOpacity={0.7}>
          <Text style={styles.cancelText}>{t('common.cancel')}</Text>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );

  // Mounted inside app/_layout's `overlays`, which on iOS ALREADY sits in a
  // FullWindowOverlay (above pushed native screens) — so render a plain view
  // there and lean on that ambient overlay, exactly like NowPlaying does. (A
  // nested FullWindowOverlay, or a <Modal> inside one, deadlocks on iOS.)
  // Android has no such overlay around `overlays`, so it uses a real Modal.
  return Platform.OS === 'ios'
    ? (mounted ? content : null)
    : (
      <Modal visible={mounted} transparent animationType="none" onRequestClose={close} statusBarTranslucent>
        {content}
      </Modal>
    );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  root: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', padding: SPACING.lg },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)' },
  card: {
    width: '100%', maxWidth: 360,
    backgroundColor: c.surfaceElevated,
    borderRadius: RADIUS.xl, borderWidth: 1, borderColor: c.border,
    padding: SPACING.lg, alignItems: 'center',
  },
  icon: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: c.primary + '22', alignItems: 'center', justifyContent: 'center',
    marginBottom: SPACING.sm,
  },
  title: { color: c.text, fontSize: 18, fontWeight: '800', textAlign: 'center', letterSpacing: -0.3 },
  body: { color: c.textSecondary, fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: SPACING.xs },

  watchBtn: { alignSelf: 'stretch', borderRadius: RADIUS.full, overflow: 'hidden', marginTop: SPACING.md },
  watchGrad: { alignItems: 'center', justifyContent: 'center', paddingVertical: SPACING.md },
  watchText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  cancelBtn: { alignSelf: 'stretch', alignItems: 'center', paddingVertical: SPACING.sm + 2, marginTop: SPACING.xs },
  cancelText: { color: c.textSecondary, fontSize: 15, fontWeight: '700' },
});
