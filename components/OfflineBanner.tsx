import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { useOffline } from '../contexts/OfflineContext';

// App-wide connectivity pill. Mounted once in the root layout, so every screen
// gets it without opting in.
//
// Deliberately a floating pill rather than a full-width bar pinned to the top:
// a bar either pushes every screen's header down (a layout jump on a state the
// user didn't cause) or covers it. The pill reads as a notification, overlays
// harmlessly, and is `pointerEvents: none` throughout — it can never swallow a
// tap meant for the UI underneath.
//
// It also confirms RECOVERY. Showing only the failure leaves people unsure
// whether it's safe to retry; a brief "Back online" closes the loop and then
// gets out of the way.
const BACK_ONLINE_MS = 1800;

export default function OfflineBanner() {
  const { isOffline } = useOffline();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const [mode, setMode] = useState<'hidden' | 'offline' | 'back'>('hidden');
  const anim = useRef(new Animated.Value(0)).current;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Launching while already online must NOT flash "Back online" — only a real
  // offline→online transition counts as a recovery.
  const wasOfflineRef = useRef(false);

  useEffect(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (isOffline) {
      wasOfflineRef.current = true;
      setMode('offline');
    } else if (wasOfflineRef.current) {
      wasOfflineRef.current = false;
      setMode('back');
      timerRef.current = setTimeout(() => { timerRef.current = null; setMode('hidden'); }, BACK_ONLINE_MS);
    }
    return () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } };
  }, [isOffline]);

  useEffect(() => {
    const showing = mode !== 'hidden';
    Animated.spring(anim, {
      toValue: showing ? 1 : 0,
      useNativeDriver: true,
      friction: 9,
      tension: 60,
    }).start();
  }, [mode, anim]);

  if (mode === 'hidden') return null;

  const back = mode === 'back';
  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [-24, 0] });

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.wrap,
        { top: insets.top + SPACING.sm, opacity: anim, transform: [{ translateY }] },
      ]}
    >
      <Animated.View style={styles.pill}>
        <Ionicons
          name={back ? 'checkmark-circle' : 'cloud-offline'}
          size={15}
          color={back ? colors.success : colors.textSecondary}
        />
        <Text style={styles.label} numberOfLines={1}>
          {back ? t('net.backOnline') : t('net.offline')}
        </Text>
      </Animated.View>
    </Animated.View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  // left/right 0 + centered children keeps the pill hugging its text at any
  // language length instead of stretching edge to edge.
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 2000 },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    maxWidth: '90%',
    backgroundColor: colors.surfaceElevated, borderRadius: RADIUS.full,
    borderWidth: 1, borderColor: colors.border,
    paddingVertical: 7, paddingHorizontal: SPACING.md,
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
    elevation: 10,
  },
  label: { color: colors.text, fontSize: 13, fontWeight: '700', letterSpacing: -0.1, flexShrink: 1 },
});
