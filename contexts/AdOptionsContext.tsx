import { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Pressable, Modal,
  Platform, Animated, Easing, Dimensions,
} from 'react-native';
import { PanGestureHandler, State, GestureHandlerRootView } from 'react-native-gesture-handler';
import { FullWindowOverlay } from 'react-native-screens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, useThemedStyles } from './ThemeContext';
import { useTranslation } from './LanguageContext';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { reportAd } from '../lib/ads';

// Polished themed action sheet for the ad 3-dot button (feed + reels), replacing
// the old system Alert. Slides up, drag the handle down to dismiss — mirrors the
// report sheet's motion (constant SCREEN_H + stable useRef'd nodes). Triggered
// imperatively via openAdOptions() so any ad surface can open it.
const { height: SCREEN_H } = Dimensions.get('window');

type AdOptionsRequest = { campaignId: string; creativeId?: string | null; advertiserName?: string };

let handler: ((req: AdOptionsRequest) => void) | null = null;
export function openAdOptions(req: AdOptionsRequest) { handler?.(req); }

type Mode = 'menu' | 'why' | 'done';

export function AdOptionsProvider({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [mounted, setMounted] = useState(false);
  const [mode, setMode] = useState<Mode>('menu');
  const reqRef = useRef<AdOptionsRequest | null>(null);
  const closingRef = useRef(false);

  const translateY = useRef(new Animated.Value(SCREEN_H)).current;
  const dragY = useRef(new Animated.Value(0)).current;
  const dragClamped = useRef(
    dragY.interpolate({ inputRange: [0, SCREEN_H], outputRange: [0, SCREEN_H], extrapolate: 'clamp' }),
  ).current;
  const sheetY = useRef(Animated.add(translateY, dragClamped)).current;
  const backdropOpacity = useRef(
    translateY.interpolate({ inputRange: [0, SCREEN_H], outputRange: [1, 0], extrapolate: 'clamp' }),
  ).current;
  const onDragEvent = useRef(
    Animated.event([{ nativeEvent: { translationY: dragY } }], { useNativeDriver: true }),
  ).current;

  useEffect(() => {
    handler = (req) => {
      reqRef.current = req;
      setMode('menu');
      closingRef.current = false;
      setMounted(true);
      dragY.setValue(0);
      translateY.setValue(SCREEN_H);
      Animated.timing(translateY, { toValue: 0, duration: 300, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    };
    return () => { handler = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function close(after?: () => void) {
    if (closingRef.current) return;
    closingRef.current = true;
    Animated.timing(translateY, { toValue: SCREEN_H, duration: 230, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(() => {
      if (!closingRef.current) return;
      setMounted(false);
      reqRef.current = null;
      after?.();
    });
  }

  function springBack() {
    Animated.spring(dragY, { toValue: 0, speed: 18, bounciness: 0, useNativeDriver: true }).start();
  }
  function onDragState(e: any) {
    const { state, translationY, velocityY } = e.nativeEvent;
    if (state === State.END) {
      if (translationY > 90 || velocityY > 800) close();
      else springBack();
    } else if (state === State.CANCELLED || state === State.FAILED) {
      springBack();
    }
  }

  function doReport() {
    const req = reqRef.current;
    if (req) reportAd(req.campaignId, req.creativeId ?? null).catch(() => {});
    setMode('done');
  }
  function goSettings() {
    close(() => router.push('/settings'));
  }

  const brand = reqRef.current?.advertiserName || t('ad.sponsoredAd');

  const inner = (
    <GestureHandlerRootView style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => close()} />
      </Animated.View>

      <View style={styles.anchor} pointerEvents="box-none">
        <Animated.View style={[styles.sheet, { paddingBottom: insets.bottom + SPACING.md, transform: [{ translateY: sheetY }] }]}>
          <PanGestureHandler onGestureEvent={onDragEvent} onHandlerStateChange={onDragState} activeOffsetY={6} failOffsetX={[-20, 20]}>
            <View style={styles.grabZone}><View style={styles.handle} /></View>
          </PanGestureHandler>

          {mode === 'done' ? (
            <View style={styles.doneWrap}>
              <Ionicons name="checkmark-circle" size={44} color={colors.primary} />
              <Text style={styles.doneTitle}>{t('ad.reportThanksTitle')}</Text>
              <Text style={styles.doneBody}>{t('ad.reportThanksBody')}</Text>
              <TouchableOpacity style={styles.primaryBtn} onPress={() => close()} activeOpacity={0.85}>
                <Text style={styles.primaryBtnText}>{t('report.done')}</Text>
              </TouchableOpacity>
            </View>
          ) : mode === 'why' ? (
            <>
              <View style={styles.header}>
                <TouchableOpacity onPress={() => setMode('menu')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Ionicons name="chevron-back" size={24} color={colors.text} />
                </TouchableOpacity>
                <Text style={styles.headerTitle}>{t('ad.whyTitle')}</Text>
                <View style={{ width: 24 }} />
              </View>
              <Text style={styles.whyBody}>{t('ad.whyBody')}</Text>
              <TouchableOpacity style={styles.primaryBtn} onPress={() => close()} activeOpacity={0.85}>
                <Text style={styles.primaryBtnText}>{t('report.done')}</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.title} numberOfLines={1}>{brand}</Text>
              <Text style={styles.subtitle}>{t('ad.sponsored')}</Text>

              <Pressable onPress={doReport} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
                <Ionicons name="flag-outline" size={20} color={colors.error} />
                <Text style={[styles.rowText, { color: colors.error }]}>{t('ad.report')}</Text>
              </Pressable>
              <Pressable onPress={() => setMode('why')} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
                <Ionicons name="help-circle-outline" size={20} color={colors.text} />
                <Text style={styles.rowText}>{t('ad.why')}</Text>
              </Pressable>
              <Pressable onPress={goSettings} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
                <Ionicons name="options-outline" size={20} color={colors.text} />
                <Text style={styles.rowText}>{t('ad.settings')}</Text>
              </Pressable>

              <TouchableOpacity style={styles.cancelBtn} onPress={() => close()} activeOpacity={0.7}>
                <Text style={styles.cancelText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
            </>
          )}
        </Animated.View>
      </View>
    </GestureHandlerRootView>
  );

  const layer = Platform.OS === 'ios'
    ? (mounted ? inner : null)
    : (
      <Modal visible={mounted} transparent animationType="none" onRequestClose={() => close()} statusBarTranslucent>
        {inner}
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
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  anchor: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: c.surfaceElevated,
    borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl,
    borderWidth: 1, borderColor: c.border,
    paddingHorizontal: SPACING.lg, paddingBottom: SPACING.md,
  },
  grabZone: { paddingTop: SPACING.sm, paddingBottom: SPACING.sm, alignItems: 'center' },
  handle: { width: 40, height: 5, borderRadius: 3, backgroundColor: c.border },

  title: { color: c.text, fontSize: 16, fontWeight: '800', letterSpacing: -0.2 },
  subtitle: { color: c.textSecondary, fontSize: 12, marginTop: 1, marginBottom: SPACING.sm },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    paddingVertical: SPACING.md, paddingHorizontal: SPACING.sm, borderRadius: RADIUS.md,
  },
  rowPressed: { backgroundColor: c.surfaceLight },
  rowText: { color: c.text, fontSize: 15, fontWeight: '600' },

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: SPACING.sm },
  headerTitle: { color: c.text, fontSize: 16, fontWeight: '800' },
  whyBody: { color: c.textSecondary, fontSize: 14, lineHeight: 21, paddingBottom: SPACING.sm },

  primaryBtn: {
    alignSelf: 'stretch', backgroundColor: c.primary, borderRadius: RADIUS.full,
    alignItems: 'center', justifyContent: 'center', paddingVertical: SPACING.md, marginTop: SPACING.sm,
  },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '800' },

  cancelBtn: { alignItems: 'center', paddingVertical: SPACING.md, marginTop: SPACING.xs },
  cancelText: { color: c.textSecondary, fontSize: 15, fontWeight: '700' },

  doneWrap: { alignItems: 'center', paddingVertical: SPACING.lg, gap: SPACING.sm },
  doneTitle: { color: c.text, fontSize: 18, fontWeight: '800', marginTop: SPACING.xs },
  doneBody: { color: c.textSecondary, fontSize: 14, textAlign: 'center', lineHeight: 20, paddingHorizontal: SPACING.md },
});
