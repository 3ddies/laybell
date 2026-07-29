import { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Pressable, ScrollView, Modal,
  TextInput, KeyboardAvoidingView, Platform, Animated, Easing, Dimensions,
} from 'react-native';
import { PanGestureHandler, State, GestureHandlerRootView } from 'react-native-gesture-handler';
import { FullWindowOverlay } from 'react-native-screens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, useThemedStyles } from './ThemeContext';
import { useTranslation } from './LanguageContext';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { submitReport, submitUserReport, submitConversationReport, submitListingReport, submitCommunityReport, setReportHandler, type ReportRequest } from '../lib/postActions';

// Themed in-app report sheet. Tapping Report opens a bottom sheet of quick
// reasons; picking one opens a short, OPTIONAL "add details" step before filing,
// and "Something else" collects a required free-text reason. Triggered through
// the postActions bridge, so the existing reportPost/reportUser call sites are
// unchanged.
//
// Motion mirrors the Now Playing sheet: a CONSTANT slide distance (SCREEN_H) with
// stable useRef'd animated nodes — so the entrance is consistent across opens and
// the grab handle drags continuously (the sheet tracks the finger, then closes on
// release past a threshold or springs back). No per-step animation (instant swaps).
//
// Stored in *_reports.reason: a quick reason is its code, optionally suffixed
// with the elaboration ("impersonation: they cloned my voice"); "Something else"
// stores the raw typed text. Codes map to the Community Guidelines categories.
const { height: SCREEN_H } = Dimensions.get('window');

const REASON_CODES = [
  'spam', 'harassment', 'hate', 'nudity', 'violence',
  'impersonation', 'scam', 'illegal', 'selfharm', 'ip',
] as const;

type Mode = 'list' | 'detail' | 'done';

export function ReportProvider({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();

  const [mounted, setMounted] = useState(false);
  const [mode, setMode] = useState<Mode>('list');
  const [selected, setSelected] = useState<string | null>(null); // reason code, or 'other'
  const [detail, setDetail] = useState('');
  const reqRef = useRef<ReportRequest | null>(null);
  const closingRef = useRef(false);

  // translateY: entrance/exit (0 = resting, SCREEN_H = fully off-screen below).
  // dragY: raw finger offset from the handle gesture. The two combine into sheetY,
  // and the backdrop fades with sheetY — all stable nodes (created once).
  const translateY = useRef(new Animated.Value(SCREEN_H)).current;
  const dragY = useRef(new Animated.Value(0)).current;
  const dragClamped = useRef(
    dragY.interpolate({ inputRange: [0, SCREEN_H], outputRange: [0, SCREEN_H], extrapolate: 'clamp' }),
  ).current;
  const sheetY = useRef(Animated.add(translateY, dragClamped)).current;
  // Backdrop fades with the entrance/exit only (steady during a drag) — a single
  // value interpolation, so it's rock-solid on the native driver.
  const backdropOpacity = useRef(
    translateY.interpolate({ inputRange: [0, SCREEN_H], outputRange: [1, 0], extrapolate: 'clamp' }),
  ).current;
  const onDragEvent = useRef(
    Animated.event([{ nativeEvent: { translationY: dragY } }], { useNativeDriver: true }),
  ).current;

  useEffect(() => {
    setReportHandler((req) => {
      reqRef.current = req;
      setSelected(null);
      setDetail('');
      setMode('list');
      closingRef.current = false;
      setMounted(true);
      dragY.setValue(0);
      translateY.setValue(SCREEN_H);
      Animated.timing(translateY, { toValue: 0, duration: 300, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    });
    return () => setReportHandler(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function close() {
    if (closingRef.current) return;
    closingRef.current = true;
    const onClose = reqRef.current?.onClose;
    // translateY -> SCREEN_H slides the sheet down (from wherever the drag left
    // it, since sheetY = translateY + drag) and fades the backdrop with it.
    Animated.timing(translateY, { toValue: SCREEN_H, duration: 230, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(() => {
      // A new report opened mid-close (handler resets closingRef) — don't tear
      // down the freshly-shown sheet.
      if (!closingRef.current) return;
      setMounted(false);
      reqRef.current = null;
      onClose?.();
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

  function file(reason: string) {
    const req = reqRef.current;
    if (!req) return;
    if (req.kind === 'post') submitReport(req.targetId, reason).catch(() => {});
    else if (req.kind === 'conversation') submitConversationReport(req.targetId, reason).catch(() => {});
    else if (req.kind === 'listing') submitListingReport(req.targetId, reason).catch(() => {});
    else if (req.kind === 'community') submitCommunityReport(req.targetId, reason).catch(() => {});
    else submitUserReport(req.targetId, reason).catch(() => {});
    setMode('done');
  }

  function pick(code: string) {
    setSelected(code);
    setDetail('');
    setMode('detail');
  }

  function submitDetail() {
    const txt = detail.trim();
    if (selected === 'other') {
      if (!txt) return;
      file(txt.slice(0, 300));
    } else if (selected) {
      file(txt ? `${selected}: ${txt.slice(0, 280)}` : selected);
    }
  }

  const kind = reqRef.current?.kind;
  const isUser = kind === 'user';
  const listTitle = kind === 'user' ? t('report.titleUser')
    : kind === 'conversation' ? t('report.titleChat')
    : kind === 'listing' ? t('report.titleListing')
    : kind === 'community' ? t('report.titleCommunity')
    : t('report.titlePost');
  const isOther = selected === 'other';
  const submitDisabled = isOther && !detail.trim();

  const inner = (
    <GestureHandlerRootView style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} />
      </Animated.View>

      <KeyboardAvoidingView
        style={styles.kav}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        pointerEvents="box-none"
      >
        <Animated.View style={[styles.sheet, { paddingBottom: insets.bottom + SPACING.md, transform: [{ translateY: sheetY }] }]}>
          {/* Grab handle — drag down here to dismiss (tracks the finger). */}
          <PanGestureHandler
            onGestureEvent={onDragEvent}
            onHandlerStateChange={onDragState}
            activeOffsetY={6}
            failOffsetX={[-20, 20]}
          >
            <View style={styles.grabZone}>
              <View style={styles.handle} />
            </View>
          </PanGestureHandler>

          {mode === 'done' ? (
            <View style={styles.doneWrap}>
              <View style={styles.doneIcon}><Ionicons name="checkmark-circle" size={44} color={colors.primary} /></View>
              <Text style={styles.doneTitle}>{t('report.thanksTitle')}</Text>
              <Text style={styles.doneBody}>{t('report.thanksBody')}</Text>
              <TouchableOpacity style={styles.primaryBtn} onPress={close} activeOpacity={0.85}>
                <Text style={styles.primaryBtnText}>{t('report.done')}</Text>
              </TouchableOpacity>
            </View>
          ) : mode === 'detail' ? (
            <>
              <View style={styles.header}>
                <TouchableOpacity onPress={() => setMode('list')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Ionicons name="chevron-back" size={24} color={colors.text} />
                </TouchableOpacity>
                <Text style={styles.headerTitle}>{isOther ? t('report.otherTitle') : t('report.detailTitle')}</Text>
                <View style={{ width: 24 }} />
              </View>

              {!isOther && !!selected && (
                <View style={styles.reasonChip}>
                  <Ionicons name="flag" size={13} color={colors.primary} />
                  <Text style={styles.reasonChipText}>{t(`report.reason.${selected}`)}</Text>
                </View>
              )}

              <TextInput
                style={styles.input}
                placeholder={isOther ? t('report.otherPlaceholder') : t('report.detailPlaceholder')}
                placeholderTextColor={colors.textTertiary}
                value={detail}
                onChangeText={setDetail}
                multiline
                maxLength={300}
                autoFocus={isOther}
                textAlignVertical="top"
              />
              <TouchableOpacity
                style={[styles.primaryBtn, submitDisabled && styles.btnDisabled]}
                onPress={submitDetail}
                disabled={submitDisabled}
                activeOpacity={0.85}
              >
                <Text style={styles.primaryBtnText}>{t('report.submit')}</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.title}>{listTitle}</Text>
              <Text style={styles.subtitle}>{t('report.subtitle')}</Text>
              <ScrollView style={styles.list} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
                {REASON_CODES.map((code) => (
                  <Pressable
                    key={code}
                    onPress={() => pick(code)}
                    style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                  >
                    <Text style={styles.rowText}>{t(`report.reason.${code}`)}</Text>
                    <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
                  </Pressable>
                ))}
                <Pressable onPress={() => pick('other')} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
                  <Text style={styles.rowText}>{t('report.reason.other')}</Text>
                  <Ionicons name="create-outline" size={18} color={colors.textTertiary} />
                </Pressable>
              </ScrollView>
            </>
          )}
        </Animated.View>
      </KeyboardAvoidingView>
    </GestureHandlerRootView>
  );

  // iOS: a <Modal> inside a FullWindowOverlay deadlocks, and the report can open
  // from the player/overlay chrome — so host it in its own overlay and render a
  // plain view (mirrors PostOptions / LinkGuard). We drive the animation
  // ourselves, so the Android Modal uses animationType="none".
  const layer = Platform.OS === 'ios'
    ? (mounted ? inner : null)
    : (
      <Modal visible={mounted} transparent animationType="none" onRequestClose={close} statusBarTranslucent>
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
  kav: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: c.surfaceElevated,
    borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl,
    borderWidth: 1, borderColor: c.border,
    paddingHorizontal: SPACING.lg, paddingBottom: SPACING.md,
    maxHeight: '82%',
  },
  // Enlarged touch target around the handle so the drag is easy to grab.
  grabZone: { paddingTop: SPACING.sm, paddingBottom: SPACING.sm, alignItems: 'center' },
  handle: { width: 40, height: 5, borderRadius: 3, backgroundColor: c.border },

  title: { color: c.text, fontSize: 18, fontWeight: '800', letterSpacing: -0.3 },
  subtitle: { color: c.textSecondary, fontSize: 13, marginTop: 2, marginBottom: SPACING.sm },

  list: { flexShrink: 1 },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: SPACING.md, paddingHorizontal: SPACING.sm, gap: SPACING.md,
    borderRadius: RADIUS.md,
    borderBottomWidth: 0.5, borderBottomColor: c.borderSubtle,
  },
  rowPressed: { backgroundColor: c.surfaceLight },
  rowText: { color: c.text, fontSize: 15, fontWeight: '500', flex: 1 },

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: SPACING.sm },
  headerTitle: { color: c.text, fontSize: 16, fontWeight: '800' },

  reasonChip: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6,
    backgroundColor: c.primary + '1A', borderRadius: RADIUS.full,
    paddingVertical: 6, paddingHorizontal: SPACING.sm + 2, marginBottom: SPACING.sm,
  },
  reasonChipText: { color: c.primaryLight, fontSize: 13, fontWeight: '700' },

  input: {
    backgroundColor: c.surfaceLight, borderWidth: 1, borderColor: c.border,
    borderRadius: RADIUS.md, padding: SPACING.md,
    color: c.text, fontSize: 15, minHeight: 110, marginBottom: SPACING.md,
  },

  primaryBtn: {
    alignSelf: 'stretch',
    backgroundColor: c.primary, borderRadius: RADIUS.full,
    alignItems: 'center', justifyContent: 'center', paddingVertical: SPACING.md,
    marginTop: SPACING.xs,
  },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  btnDisabled: { opacity: 0.4 },

  doneWrap: { alignItems: 'center', paddingVertical: SPACING.lg, gap: SPACING.sm },
  doneIcon: { marginBottom: SPACING.xs },
  doneTitle: { color: c.text, fontSize: 18, fontWeight: '800' },
  doneBody: { color: c.textSecondary, fontSize: 14, textAlign: 'center', lineHeight: 20, paddingHorizontal: SPACING.md },
});
