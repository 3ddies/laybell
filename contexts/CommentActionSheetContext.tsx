import { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Pressable, Modal, Platform, Animated, Easing,
} from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, useThemedStyles } from './ThemeContext';
import { useTranslation } from './LanguageContext';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { setCommentActionHandler, type CommentActionRequest } from '../lib/commentActions';

// Polished bottom action sheet for a long-pressed comment — replacing the old
// long-press-to-delete. Reply always; Delete for your own comment; Report for
// someone else's. Wired through the commentActions bridge (like the GIF sheet and
// the report sheet), so Comments.tsx stays simple and it renders above the iOS
// Now Playing / post overlays.
export function CommentActionSheetProvider({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);

  const [mounted, setMounted] = useState(false);
  const reqRef = useRef<CommentActionRequest | null>(null);
  const closingRef = useRef(false);
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    setCommentActionHandler((req) => {
      reqRef.current = req;
      closingRef.current = false;
      setMounted(true);
      anim.setValue(0);
      Animated.timing(anim, { toValue: 1, duration: 200, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    });
    return () => setCommentActionHandler(null);
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

  const req = reqRef.current;

  const content = (
    <View style={styles.root}>
      <Animated.View style={[styles.backdrop, { opacity: anim }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => close()} />
      </Animated.View>

      <Animated.View
        style={[
          styles.sheet,
          { transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [300, 0] }) }] },
        ]}
      >
        <View style={styles.grabber} />

        <TouchableOpacity style={styles.row} onPress={() => close(() => req?.onReply())} activeOpacity={0.7}>
          <Ionicons name="arrow-undo-outline" size={22} color={colors.text} />
          <Text style={styles.rowText}>{t('commentActions.reply')}</Text>
        </TouchableOpacity>

        {req?.isOwn ? (
          <TouchableOpacity style={styles.row} onPress={() => close(() => req?.onDelete())} activeOpacity={0.7}>
            <Ionicons name="trash-outline" size={22} color={colors.error} />
            <Text style={[styles.rowText, { color: colors.error }]}>{t('commentActions.delete')}</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.row} onPress={() => close(() => req?.onReport())} activeOpacity={0.7}>
            <Ionicons name="flag-outline" size={22} color={colors.error} />
            <Text style={[styles.rowText, { color: colors.error }]}>{t('commentActions.report')}</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity style={styles.cancelBtn} onPress={() => close()} activeOpacity={0.7}>
          <Text style={styles.cancelText}>{t('common.cancel')}</Text>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );

  // iOS: a <Modal> inside a FullWindowOverlay deadlocks, and comments show inside
  // the Now Playing / post overlays — so host it in its own overlay and render a
  // plain view (mirrors the GIF / report sheets). Android uses a Modal.
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
  grabber: { alignSelf: 'center', width: 38, height: 5, borderRadius: 3, backgroundColor: c.border, marginBottom: SPACING.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, paddingVertical: SPACING.md },
  rowText: { color: c.text, fontSize: 16, fontWeight: '600' },
  cancelBtn: { alignItems: 'center', paddingVertical: SPACING.md, marginTop: SPACING.xs, backgroundColor: c.surface, borderRadius: RADIUS.full },
  cancelText: { color: c.textSecondary, fontSize: 15, fontWeight: '700' },
});
