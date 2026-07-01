import { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Pressable, Modal,
  Platform, Animated, Easing, ActivityIndicator,
} from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useTheme, useThemedStyles } from './ThemeContext';
import { useTranslation } from './LanguageContext';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { addUserGif } from '../lib/userGifs';
import { reportPost } from '../lib/postActions';
import { setGifTapHandler, type GifTapRequest } from '../lib/gifAttachmentActions';

// Polished bottom action sheet shown when a Laybell-made GIF is tapped, replacing
// the old system Alert. Slides up with a GIF thumbnail and three actions (view /
// go to the original video / save to My GIFs). Saving swaps to an inline "Saved"
// confirmation and auto-dismisses — no second popup. Wired through the gifTap
// bridge, so the comment/message tap handlers stay simple.

type Phase = 'menu' | 'saving' | 'saved';

export function GifActionSheetProvider({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);

  const [mounted, setMounted] = useState(false);
  const [phase, setPhase] = useState<Phase>('menu');
  const reqRef = useRef<GifTapRequest | null>(null);
  const closingRef = useRef(false);
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    setGifTapHandler((req) => {
      reqRef.current = req;
      setPhase('menu');
      closingRef.current = false;
      setMounted(true);
      anim.setValue(0);
      Animated.timing(anim, { toValue: 1, duration: 200, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    });
    return () => setGifTapHandler(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function close(then?: () => void) {
    if (closingRef.current) return;
    closingRef.current = true;
    Animated.timing(anim, { toValue: 0, duration: 160, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(() => {
      setMounted(false);
      reqRef.current = null;
      then?.();
    });
  }

  function onView() {
    const req = reqRef.current;
    close(() => req?.onView());
  }

  function onGoToVideo() {
    const src = reqRef.current?.att.src;
    if (!src) return;
    close(() => router.push({ pathname: '/reel/[id]', params: { id: src } }));
  }

  // Report the GIF = report the original Laybell video it was made from. Close
  // this sheet first so the report sheet (also a FullWindowOverlay) isn't stacked.
  function onReport() {
    const src = reqRef.current?.att.src;
    if (!src) return;
    close(() => reportPost(src));
  }

  async function onSave() {
    const req = reqRef.current;
    if (!req || phase !== 'menu') return;
    if (!req.userId) { close(); return; }
    setPhase('saving');
    const { att, userId } = req;
    const err = await addUserGif(userId, { url: att.url, w: att.w, h: att.h, kind: 'saved', sourcePostId: att.src });
    if (err) { close(); return; }
    setPhase('saved');
    setTimeout(() => close(), 1200);
  }

  function onDelete() {
    const req = reqRef.current;
    if (!req?.onDelete) return;
    close(() => req.onDelete!());
  }

  const uri = reqRef.current?.att.url;
  const isLaybell = !!reqRef.current?.att.src;
  const canDelete = !!reqRef.current?.canDelete;

  const content = (
    <View style={styles.root}>
      <Animated.View style={[styles.backdrop, { opacity: anim }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => close()} />
      </Animated.View>

      <Animated.View
        style={[
          styles.sheet,
          { transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [340, 0] }) }] },
        ]}
      >
        <View style={styles.grabber} />

        {phase === 'saved' ? (
          <View style={styles.savedWrap}>
            <View style={styles.savedIcon}><Ionicons name="checkmark" size={26} color="#fff" /></View>
            <Text style={styles.title}>{t('gif.tap.savedTitle')}</Text>
            <Text style={styles.body}>{t('gif.tap.savedBody')}</Text>
          </View>
        ) : (
          <>
            <View style={styles.head}>
              {uri ? <Image source={{ uri }} style={styles.thumb} contentFit="cover" /> : null}
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>{t('gif.tap.title')}</Text>
                {isLaybell ? <Text style={styles.subtitle}>{t('gif.tap.subtitle')}</Text> : null}
              </View>
            </View>

            <TouchableOpacity style={styles.row} onPress={onView} activeOpacity={0.7} disabled={phase !== 'menu'}>
              <Ionicons name="eye-outline" size={22} color={colors.text} />
              <Text style={styles.rowText}>{t('gif.tap.view')}</Text>
            </TouchableOpacity>
            {isLaybell ? (
              <TouchableOpacity style={styles.row} onPress={onGoToVideo} activeOpacity={0.7} disabled={phase !== 'menu'}>
                <Ionicons name="film-outline" size={22} color={colors.text} />
                <Text style={styles.rowText}>{t('gif.tap.goToVideo')}</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={styles.row} onPress={onSave} activeOpacity={0.7} disabled={phase !== 'menu'}>
              {phase === 'saving'
                ? <ActivityIndicator color={colors.primary} size="small" style={{ width: 22 }} />
                : <Ionicons name="bookmark-outline" size={22} color={colors.text} />}
              <Text style={styles.rowText}>{t('gif.tap.save')}</Text>
            </TouchableOpacity>
            {isLaybell && !canDelete ? (
              <TouchableOpacity style={styles.row} onPress={onReport} activeOpacity={0.7} disabled={phase !== 'menu'}>
                <Ionicons name="flag-outline" size={22} color={colors.error} />
                <Text style={[styles.rowText, { color: colors.error }]}>{t('gif.tap.report')}</Text>
              </TouchableOpacity>
            ) : null}
            {canDelete ? (
              <TouchableOpacity style={styles.row} onPress={onDelete} activeOpacity={0.7} disabled={phase !== 'menu'}>
                <Ionicons name="trash-outline" size={22} color={colors.error} />
                <Text style={[styles.rowText, { color: colors.error }]}>{t('gif.tap.delete')}</Text>
              </TouchableOpacity>
            ) : null}

            <TouchableOpacity style={styles.cancelBtn} onPress={() => close()} activeOpacity={0.7} disabled={phase !== 'menu'}>
              <Text style={styles.cancelText}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </>
        )}
      </Animated.View>
    </View>
  );

  // iOS: a <Modal> inside a FullWindowOverlay deadlocks, and GIFs can be tapped
  // from the player/overlay chrome — so host it in its own overlay and render a
  // plain view (mirrors PostOptions / BlockConfirm). Android uses a Modal.
  const layer = Platform.OS === 'ios'
    ? (mounted ? content : null)
    : (
      <Modal visible={mounted} transparent animationType="none" onRequestClose={() => close()} statusBarTranslucent>
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
  root: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    backgroundColor: c.surfaceElevated,
    borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl,
    borderTopWidth: 1, borderColor: c.border,
    paddingHorizontal: SPACING.lg, paddingTop: SPACING.sm, paddingBottom: SPACING.xl + SPACING.md,
  },
  grabber: { alignSelf: 'center', width: 38, height: 5, borderRadius: 3, backgroundColor: c.border, marginBottom: SPACING.md },
  head: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, marginBottom: SPACING.sm },
  thumb: { width: 48, height: 48, borderRadius: RADIUS.md, backgroundColor: c.surfaceLight },
  title: { color: c.text, fontSize: 17, fontWeight: '800', letterSpacing: -0.3 },
  subtitle: { color: c.textTertiary, fontSize: 13, marginTop: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, paddingVertical: SPACING.md },
  rowText: { color: c.text, fontSize: 16, fontWeight: '600' },
  cancelBtn: { alignItems: 'center', paddingVertical: SPACING.md, marginTop: SPACING.xs, backgroundColor: c.surface, borderRadius: RADIUS.full },
  cancelText: { color: c.textSecondary, fontSize: 15, fontWeight: '700' },
  savedWrap: { alignItems: 'center', paddingVertical: SPACING.lg, gap: SPACING.xs },
  savedIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', marginBottom: SPACING.xs },
  body: { color: c.textSecondary, fontSize: 14, lineHeight: 20, textAlign: 'center' },
});
