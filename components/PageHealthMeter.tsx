import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, Pressable, Animated, Easing } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { computePageHealth, healthLevel, healthColor, type PageHealth, type HealthKey } from '../lib/pageHealth';
import { RADIUS, SPACING, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { selection } from '../lib/haptics';

// The private "Page Health" meter — a subtle tab on the profile's right edge, up at
// the slot above the Shop button. Tap it and a vertical meter slides out; tap the
// meter for the breakdown. It has NO blocking backdrop — instead the profile collapses
// it (via the ref's collapse()) from a passive onTouchStart, so a scroll/swipe
// dismisses it AND still registers as a scroll/swipe. Only the owner mounts this.

export type PageHealthMeterHandle = { collapse: () => void };

const COMPONENT_ICON: Record<HealthKey, keyof typeof Ionicons.glyphMap> = {
  status: 'ribbon',
  engagement: 'heart',
  consistency: 'calendar',
};

function compColor(pct: number): string {
  if (pct >= 66) return '#22C55E';
  if (pct >= 33) return '#FAB525';
  return '#F26522';
}

// Fixed theme colour per category (green / yellow / red) used to tint the confirm
// dialog's icon badge and action button, plus the legible text colour on each.
const CATEGORY_COLOR: Record<HealthKey, string> = { status: '#22C55E', consistency: '#FAB525', engagement: '#EF4444' };
const CATEGORY_ON: Record<HealthKey, string> = { status: '#FFFFFF', consistency: '#FFFFFF', engagement: '#FFFFFF' };

const METER_W = 64;
const SHINE_W = 54; // horizontal shimmer band
const SHINE_H = 44; // vertical shimmer band (expanded meter)
const GAUGE_SHINE_H = 18; // shimmer band for the idle handle gauge
const SHINE_COLORS = ['rgba(255,255,255,0)', 'rgba(255,255,255,0.6)', 'rgba(255,255,255,0)'] as const;

const PageHealthMeter = forwardRef<PageHealthMeterHandle, { userId?: string | null; badgeTier?: string | null }>(
  function PageHealthMeter({ userId, badgeTier }, ref) {
    const { colors } = useTheme();
    const styles = useThemedStyles(makeStyles);
    const { t } = useTranslation();
    const router = useRouter();
    const [health, setHealth] = useState<PageHealth | null>(null);
    const [expanded, setExpanded] = useState(false);
    const [open, setOpen] = useState(false);
    const expandedRef = useRef(false);
    const slide = useRef(new Animated.Value(0)).current; // 0 collapsed → 1 expanded
    const shine = useRef(new Animated.Value(0)).current; // looping bar shimmer
    const sheetAnim = useRef(new Animated.Value(0)).current; // breakdown sheet: 0 closed → 1 open
    const [bigFillW, setBigFillW] = useState(0);
    const [vFillH, setVFillH] = useState(0);
    const [gaugeH, setGaugeH] = useState(0);
    const [recIdx, setRecIdx] = useState(0);
    const recFade = useRef(new Animated.Value(1)).current;
    const [sheetH, setSheetH] = useState(500);
    const [confirmKey, setConfirmKey] = useState<HealthKey | null>(null);
    const confirmAnim = useRef(new Animated.Value(0)).current; // 0 hidden → 1 shown

    useFocusEffect(useCallback(() => {
      if (!userId) return;
      let live = true;
      computePageHealth(userId, badgeTier).then((h) => { if (live) setHealth(h); }).catch(() => {});
      // Looping white shimmer that sweeps the main bar (with a gap between sweeps).
      const shimmer = Animated.loop(Animated.sequence([
        Animated.timing(shine, { toValue: 1, duration: 1100, easing: Easing.linear, useNativeDriver: true }),
        Animated.delay(1500),
      ]));
      shimmer.start();
      return () => { live = false; shimmer.stop(); };
    }, [userId, badgeTier, shine]));

    const expand = () => {
      selection();
      expandedRef.current = true;
      setExpanded(true);
      Animated.spring(slide, { toValue: 1, useNativeDriver: true, friction: 8, tension: 70 }).start();
    };
    const collapse = useCallback(() => {
      if (!expandedRef.current) return;
      expandedRef.current = false;
      Animated.timing(slide, { toValue: 0, duration: 180, useNativeDriver: true }).start(() => setExpanded(false));
    }, [slide]);
    // The profile calls this from a passive onTouchStart on any touch outside the meter.
    useImperativeHandle(ref, () => ({ collapse }), [collapse]);

    // Breakdown sheet: the backdrop FADES while the sheet SLIDES up (driven by one
    // value) — so the dark tint no longer slides in as a separate block.
    const openSheet = () => {
      setOpen(true);
      setRecIdx(0);
      recFade.setValue(1);
      sheetAnim.setValue(0);
      Animated.timing(sheetAnim, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    };
    const closeSheet = () => {
      Animated.timing(sheetAnim, { toValue: 0, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(() => setOpen(false));
    };

    // The one rotating field leads with a recommendation and returns to the intro blurb
    // after each — rec · intro · rec2 · intro · rec3 · intro · … — recs ordered
    // weakest-first (what would lift the score most); if everything's strong, celebrate.
    const slides = useMemo(() => {
      const weak = (health?.components ?? []).filter((c) => c.pct < 85).sort((a, b) => a.pct - b.pct).map((c) => c.key as string);
      const recs = weak.length ? weak : ['great'];
      return recs.flatMap((r) => [r, 'intro']); // always ≥2 slides, so it rotates
    }, [health]);
    useEffect(() => {
      if (!open || slides.length <= 1) return;
      const id = setInterval(() => {
        Animated.timing(recFade, { toValue: 0, duration: 280, useNativeDriver: true }).start(() => {
          setRecIdx((i) => (i + 1) % slides.length);
          Animated.timing(recFade, { toValue: 1, duration: 280, useNativeDriver: true }).start();
        });
      }, 8000); // 8s per slide — time to comfortably read the intro or a recommendation
      return () => clearInterval(id);
    }, [open, slides, recFade]);

    // Tapping a breakdown category offers to jump somewhere that helps lift it — via a
    // custom Laybell-styled dialog (not the stock iOS alert).
    const openConfirm = useCallback((key: HealthKey) => {
      selection();
      setConfirmKey(key);
      confirmAnim.setValue(0);
      Animated.spring(confirmAnim, { toValue: 1, useNativeDriver: true, friction: 7, tension: 80 }).start();
    }, [confirmAnim]);
    const closeConfirm = useCallback(() => {
      Animated.timing(confirmAnim, { toValue: 0, duration: 150, useNativeDriver: true }).start(() => setConfirmKey(null));
    }, [confirmAnim]);
    const confirmGo = useCallback((key: HealthKey) => {
      const route = key === 'status' ? '/badges' : key === 'consistency' ? '/(tabs)/post' : '/analytics';
      setConfirmKey(null);
      setOpen(false);
      router.navigate(route as any);
    }, [router]);

    if (!userId) return null;
    const score = health?.score ?? 0;
    const levelKey = healthLevel(score);
    const color = healthColor(score);
    const ready = !!health;
    const slideKey = slides[recIdx % slides.length];
    const isRec = slideKey !== 'intro';
    const translateX = slide.interpolate({ inputRange: [0, 1], outputRange: [METER_W + SPACING.md, 0] });

    return (
      <>
        {/* box-none so only the handle/meter are touch targets; onTouchStart stops the
            meter's own touches from bubbling to the profile's collapse listener. */}
        <View style={styles.edge} pointerEvents="box-none" onTouchStart={(e) => e.stopPropagation()}>
          {!expanded && (
            <TouchableOpacity style={styles.handle} onPress={expand} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel={t('pageHealth.title')}>
              <View style={styles.handleGaugeTrack}>
                <View
                  style={[styles.handleGaugeFill, { height: `${ready ? score : 0}%`, backgroundColor: color }]}
                  onLayout={(e) => setGaugeH(e.nativeEvent.layout.height)}
                >
                  <Animated.View
                    pointerEvents="none"
                    style={{ position: 'absolute', left: 0, right: 0, height: GAUGE_SHINE_H, transform: [{ translateY: shine.interpolate({ inputRange: [0, 1], outputRange: [gaugeH, -GAUGE_SHINE_H] }) }] }}
                  >
                    <LinearGradient colors={SHINE_COLORS} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={StyleSheet.absoluteFill} />
                  </Animated.View>
                </View>
              </View>
            </TouchableOpacity>
          )}

          <Animated.View style={[styles.meter, { transform: [{ translateX }] }]} pointerEvents={expanded ? 'auto' : 'none'}>
            <TouchableOpacity style={styles.meterInner} activeOpacity={0.85} onPress={openSheet}>
              <Text style={[styles.meterScore, { color: color }]}>{ready ? score : '—'}</Text>
              <View style={styles.vtrack}>
                <LinearGradient
                  colors={[color, color + 'B3']}
                  style={[styles.vfill, { height: `${ready ? score : 0}%` }]}
                  onLayout={(e) => setVFillH(e.nativeEvent.layout.height)}
                >
                  <Animated.View
                    pointerEvents="none"
                    style={{ position: 'absolute', left: 0, right: 0, height: SHINE_H, transform: [{ translateY: shine.interpolate({ inputRange: [0, 1], outputRange: [vFillH, -SHINE_H] }) }] }}
                  >
                    <LinearGradient colors={SHINE_COLORS} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={StyleSheet.absoluteFill} />
                  </Animated.View>
                </LinearGradient>
              </View>
              <Text style={styles.meterLevel} numberOfLines={1}>{t(`pageHealth.level.${levelKey}`)}</Text>
            </TouchableOpacity>
          </Animated.View>
        </View>

        {/* Breakdown sheet */}
        <Modal visible={open} transparent animationType="none" onRequestClose={closeSheet}>
          <Animated.View style={[styles.overlay, { opacity: sheetAnim }]}>
            <Pressable style={StyleSheet.absoluteFill} onPressIn={closeSheet} />
            <Animated.View
              style={[styles.sheet, { transform: [{ translateY: sheetAnim.interpolate({ inputRange: [0, 1], outputRange: [sheetH, 0] }) }] }]}
              onLayout={(e) => setSheetH(e.nativeEvent.layout.height)}
            >
              <View style={styles.sheetHandle} />
              <View style={styles.sheetTitleRow}>
                <Ionicons name="pulse" size={24} color={color} />
                <Text style={styles.sheetTitle}>{t('pageHealth.title')}</Text>
              </View>

              <View style={styles.bigRow}>
                <Text style={[styles.bigScore, { color: color }]}>{score}</Text>
                <Text style={[styles.bigLevel, { color: color }]}>{t(`pageHealth.level.${levelKey}`)}</Text>
              </View>
              <View style={styles.bigTrack}>
                <LinearGradient
                  colors={[color + 'B3', color]}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                  style={[styles.hfill, { width: `${score}%` }]}
                  onLayout={(e) => setBigFillW(e.nativeEvent.layout.width)}
                >
                  <Animated.View
                    pointerEvents="none"
                    style={{ position: 'absolute', top: 0, bottom: 0, width: SHINE_W, transform: [{ translateX: shine.interpolate({ inputRange: [0, 1], outputRange: [-SHINE_W, bigFillW] }) }] }}
                  >
                    <LinearGradient colors={SHINE_COLORS} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
                  </Animated.View>
                </LinearGradient>
              </View>
              <View style={styles.recCard}>
                <Animated.View style={{ opacity: recFade, gap: 6 }}>
                  {isRec ? (
                    <>
                      <Text style={styles.recLabel}>{t('pageHealth.recommended')}</Text>
                      <Text style={styles.recText} numberOfLines={3}>{t(`pageHealth.rec.${slideKey}`)}</Text>
                    </>
                  ) : (
                    <Text style={styles.introInline} numberOfLines={4}>{t('pageHealth.intro')}</Text>
                  )}
                </Animated.View>
              </View>

              {(health?.components ?? []).map((c) => (
                <TouchableOpacity key={c.key} style={styles.comp} activeOpacity={0.6} onPress={() => openConfirm(c.key)} accessibilityRole="button">
                  <View style={styles.compHeader}>
                    <View style={styles.row}>
                      <Ionicons name={COMPONENT_ICON[c.key]} size={15} color={colors.textSecondary} />
                      <Text style={styles.compLabel}>{t(`pageHealth.comp.${c.key}`)}</Text>
                    </View>
                    <View style={styles.row}>
                      <Text style={[styles.compPct, { color: compColor(c.pct) }]}>{c.pct}%</Text>
                      <Ionicons name="chevron-forward" size={14} color={colors.textTertiary} />
                    </View>
                  </View>
                  <View style={styles.compTrack}>
                    <View style={[styles.hfill, { width: `${c.pct}%`, backgroundColor: compColor(c.pct) }]} />
                  </View>
                  <Text style={styles.compTip}>{t(`pageHealth.tip.${c.key}`)}</Text>
                </TouchableOpacity>
              ))}

              <View style={[styles.row, styles.privacy]}>
                <Ionicons name="lock-closed" size={13} color={colors.textTertiary} />
                <Text style={styles.privacyText}>{t('pageHealth.private')}</Text>
              </View>
            </Animated.View>
          </Animated.View>

          {/* Custom Laybell-styled confirm dialog (replaces the stock iOS alert). */}
          {confirmKey && (
            <Animated.View style={[styles.confirmWrap, { opacity: confirmAnim }]}>
              <Pressable style={StyleSheet.absoluteFill} onPress={closeConfirm} />
              <Animated.View style={[styles.confirmCard, { transform: [{ scale: confirmAnim.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }] }]}>
                <View style={[styles.confirmIcon, { backgroundColor: CATEGORY_COLOR[confirmKey] + '1A' }]}>
                  <Ionicons name={COMPONENT_ICON[confirmKey]} size={26} color={CATEGORY_COLOR[confirmKey]} />
                </View>
                <Text style={styles.confirmTitle}>{t(`pageHealth.comp.${confirmKey}`)}</Text>
                <Text style={styles.confirmMsg}>{t(`pageHealth.go.${confirmKey}.q`)}</Text>
                <TouchableOpacity style={[styles.confirmCta, { backgroundColor: CATEGORY_COLOR[confirmKey] }]} activeOpacity={0.85} onPress={() => confirmGo(confirmKey)} accessibilityRole="button">
                  <Text style={[styles.confirmCtaText, { color: CATEGORY_ON[confirmKey] }]}>{t(`pageHealth.go.${confirmKey}.cta`)}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.confirmCancel} activeOpacity={0.7} onPress={closeConfirm} accessibilityRole="button">
                  <Text style={styles.confirmCancelText}>{t('common.cancel')}</Text>
                </TouchableOpacity>
              </Animated.View>
            </Animated.View>
          )}
        </Modal>
      </>
    );
  },
);

export default PageHealthMeter;

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  // Up at the slot above the Shop button (upper area), on the right edge.
  edge: { position: 'absolute', right: 0, top: '24%', zIndex: 20 },

  handle: {
    width: 18, height: 72, borderTopLeftRadius: 11, borderBottomLeftRadius: 11,
    backgroundColor: colors.surfaceElevated, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRightWidth: 0,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 5, shadowOffset: { width: -2, height: 1 }, elevation: 4,
  },
  handleGaugeTrack: { width: 5, height: 52, borderRadius: 3, backgroundColor: colors.border, overflow: 'hidden', justifyContent: 'flex-end' },
  handleGaugeFill: { width: '100%', borderRadius: 3, overflow: 'hidden' },

  meter: {
    position: 'absolute', right: 0, top: -70,
    width: METER_W, borderTopLeftRadius: RADIUS.lg, borderBottomLeftRadius: RADIUS.lg,
    backgroundColor: colors.surfaceElevated, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRightWidth: 0,
    shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 10, shadowOffset: { width: -3, height: 2 }, elevation: 8,
  },
  meterInner: { alignItems: 'center', paddingVertical: SPACING.md, gap: 10 },
  meterScore: { fontSize: 20, fontWeight: '900' },
  vtrack: { width: 12, height: 150, borderRadius: 6, backgroundColor: colors.border, overflow: 'hidden', justifyContent: 'flex-end' },
  vfill: { width: '100%', borderRadius: 6, overflow: 'hidden' },
  meterLevel: { color: colors.textSecondary, fontSize: 10, fontWeight: '700', textAlign: 'center' },

  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.background, borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl,
    padding: SPACING.lg, paddingBottom: SPACING.xl, gap: SPACING.sm,
  },
  sheetHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: SPACING.xs },
  sheetTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 2 },
  sheetTitle: { color: colors.text, fontSize: 26, fontWeight: '900', letterSpacing: 0.3 },
  bigRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', gap: 8, marginTop: SPACING.xs },
  bigScore: { fontSize: 44, fontWeight: '900' },
  bigLevel: { fontSize: 18, fontWeight: '800' },
  bigTrack: { height: 12, borderRadius: 6, backgroundColor: colors.border, overflow: 'hidden', marginTop: SPACING.xs },
  hfill: { height: '100%', borderRadius: 6, overflow: 'hidden' },
  intro: { color: colors.textSecondary, fontSize: 13, lineHeight: 18, textAlign: 'center', marginTop: SPACING.sm, marginBottom: SPACING.xs },
  recCard: { paddingVertical: SPACING.xs, marginTop: SPACING.md, marginBottom: SPACING.xs, minHeight: 84, justifyContent: 'center' },
  recLabel: { color: colors.text, fontSize: 14, fontWeight: '900', letterSpacing: 0.7, textTransform: 'uppercase' },
  recText: { color: colors.text, fontSize: 14, fontWeight: '600', lineHeight: 19 },
  introInline: { color: colors.textSecondary, fontSize: 13.5, lineHeight: 19, fontWeight: '500' },
  comp: { gap: 5, marginTop: SPACING.sm },
  compHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  compLabel: { color: colors.text, fontSize: 15, fontWeight: '700' },
  compPct: { fontSize: 14, fontWeight: '800' },
  compTrack: { height: 6, borderRadius: 3, backgroundColor: colors.border, overflow: 'hidden' },
  compTip: { color: colors.textTertiary, fontSize: 12, lineHeight: 16 },
  privacy: { justifyContent: 'center', marginTop: SPACING.md },
  privacyText: { color: colors.textTertiary, fontSize: 12 },

  confirmWrap: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: SPACING.xl },
  confirmCard: {
    width: '100%', maxWidth: 330, backgroundColor: colors.surfaceElevated, borderRadius: RADIUS.xl,
    paddingHorizontal: SPACING.lg, paddingTop: SPACING.lg, paddingBottom: SPACING.sm, alignItems: 'center', gap: SPACING.xs,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 24, shadowOffset: { width: 0, height: 12 }, elevation: 16,
  },
  confirmIcon: { width: 54, height: 54, borderRadius: 27, backgroundColor: colors.primary + '1A', alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  confirmTitle: { color: colors.text, fontSize: 21, fontWeight: '900', textAlign: 'center' },
  confirmMsg: { color: colors.textSecondary, fontSize: 14.5, lineHeight: 20, textAlign: 'center', marginBottom: SPACING.sm },
  confirmCta: { alignSelf: 'stretch', backgroundColor: colors.primary, borderRadius: RADIUS.lg, paddingVertical: 14, alignItems: 'center' },
  confirmCtaText: { color: '#FFFFFF', fontSize: 15.5, fontWeight: '800', letterSpacing: 0.2 },
  confirmCancel: { alignSelf: 'stretch', paddingVertical: 12, alignItems: 'center', marginTop: 2 },
  confirmCancelText: { color: colors.textSecondary, fontSize: 14.5, fontWeight: '700' },
});
