import { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Pressable, Modal,
  Platform, Animated, Easing, ActivityIndicator,
} from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, useThemedStyles } from './ThemeContext';
import { useTranslation } from './LanguageContext';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { blockUser, setBlockHandler, type BlockRequest } from '../lib/blocks';

// Polished themed block confirmation, replacing the old system Alert. A centered
// confirm card (same family as the "leaving Laybell" interstitial — the right
// shape for a destructive yes/no) with a fade + scale entrance. Triggered through
// the blocks bridge, so confirmBlockUser's callers (the 3-dot menu) are unchanged.

export function BlockConfirmProvider({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);

  const [mounted, setMounted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const reqRef = useRef<BlockRequest | null>(null);
  const closingRef = useRef(false);
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    setBlockHandler((req) => {
      reqRef.current = req;
      setBusy(false);
      setError(false);
      closingRef.current = false;
      setMounted(true);
      anim.setValue(0);
      Animated.timing(anim, { toValue: 1, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    });
    return () => setBlockHandler(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function close() {
    if (closingRef.current) return;
    closingRef.current = true;
    Animated.timing(anim, { toValue: 0, duration: 150, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(() => {
      if (!closingRef.current) return;
      setMounted(false);
      reqRef.current = null;
    });
  }

  async function onBlock() {
    const req = reqRef.current;
    if (!req || busy) return;
    setBusy(true);
    setError(false);
    const ok = await blockUser(req.userId);
    if (ok) {
      const onBlocked = req.onBlocked;
      close();
      onBlocked?.();
    } else {
      setBusy(false);
      setError(true);
    }
  }

  const handle = reqRef.current?.username ? `@${reqRef.current.username}` : t('block.thisUser');

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
        <View style={styles.icon}><Ionicons name="ban" size={28} color={colors.error} /></View>
        <Text style={styles.title}>{t('block.confirmTitle', { handle })}</Text>
        <Text style={styles.body}>{t('block.confirmBody', { handle })}</Text>

        {error && <Text style={styles.error}>{t('block.error')}</Text>}

        <TouchableOpacity style={styles.blockBtn} onPress={onBlock} disabled={busy} activeOpacity={0.85}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.blockBtnText}>{t('block.action')}</Text>}
        </TouchableOpacity>
        <TouchableOpacity style={styles.cancelBtn} onPress={close} disabled={busy} activeOpacity={0.7}>
          <Text style={styles.cancelText}>{t('common.cancel')}</Text>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );

  // iOS: a <Modal> inside a FullWindowOverlay deadlocks, and block can be
  // confirmed from the player/overlay chrome — so host it in its own overlay and
  // render a plain view (mirrors PostOptions / LinkGuard). Android uses a Modal.
  const layer = Platform.OS === 'ios'
    ? (mounted ? content : null)
    : (
      <Modal visible={mounted} transparent animationType="none" onRequestClose={close} statusBarTranslucent>
        {content}
      </Modal>
    );

  return (
    <>
      {children}
      {Platform.OS === 'ios' ? <FullWindowOverlay>{layer}</FullWindowOverlay> : layer}
    </>
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
    backgroundColor: c.error + '22', alignItems: 'center', justifyContent: 'center',
    marginBottom: SPACING.sm,
  },
  title: { color: c.text, fontSize: 18, fontWeight: '800', textAlign: 'center', letterSpacing: -0.3 },
  body: { color: c.textSecondary, fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: SPACING.xs },
  error: { color: c.error, fontSize: 13, fontWeight: '600', textAlign: 'center', marginTop: SPACING.sm },

  blockBtn: {
    alignSelf: 'stretch', backgroundColor: c.error, borderRadius: RADIUS.full,
    alignItems: 'center', justifyContent: 'center', paddingVertical: SPACING.md,
    marginTop: SPACING.md,
  },
  blockBtnText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  cancelBtn: { alignSelf: 'stretch', alignItems: 'center', paddingVertical: SPACING.sm + 2, marginTop: SPACING.xs },
  cancelText: { color: c.textSecondary, fontSize: 15, fontWeight: '700' },
});
