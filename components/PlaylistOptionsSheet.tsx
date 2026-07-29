import { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Pressable, Modal,
  Animated, Easing, Dimensions,
} from 'react-native';
import { PanGestureHandler, State, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

// Themed playlist long-press menu, replacing the old system Alert. Slides up with
// a draggable handle (same motion as the ad-options sheet); Make Public/Private +
// Delete, with an in-sheet delete confirmation. Prop-controlled: pass a playlist
// to open, null to close.
const { height: SCREEN_H } = Dimensions.get('window');

type Pl = { id: string; name: string; is_public: boolean };

type Props = {
  playlist: Pl | null;
  onClose: () => void;
  onToggleVisibility: (pl: Pl) => void;
  onDelete: (id: string) => void;
};

type Mode = 'menu' | 'confirmDelete';

export default function PlaylistOptionsSheet({ playlist, onClose, onToggleVisibility, onDelete }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();

  const [mounted, setMounted] = useState(false);
  const [mode, setMode] = useState<Mode>('menu');
  const plRef = useRef<Pl | null>(null);
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
    if (playlist) {
      plRef.current = playlist;
      setMode('menu');
      closingRef.current = false;
      setMounted(true);
      dragY.setValue(0);
      translateY.setValue(SCREEN_H);
      Animated.timing(translateY, { toValue: 0, duration: 300, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    } else if (mounted) {
      close(); // closed externally (e.g. the playlist was deleted)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlist]);

  function close() {
    if (closingRef.current) return;
    closingRef.current = true;
    Animated.timing(translateY, { toValue: SCREEN_H, duration: 230, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(() => {
      if (!closingRef.current) return;
      setMounted(false);
      onClose();
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

  const pl = plRef.current;
  if (!mounted && !playlist) return null;

  const inner = (
    <GestureHandlerRootView style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} />
      </Animated.View>

      <View style={styles.anchor} pointerEvents="box-none">
        <Animated.View style={[styles.sheet, { paddingBottom: insets.bottom + SPACING.md, transform: [{ translateY: sheetY }] }]}>
          <PanGestureHandler onGestureEvent={onDragEvent} onHandlerStateChange={onDragState} activeOffsetY={6} failOffsetX={[-20, 20]}>
            <View style={styles.grabZone}><View style={styles.handle} /></View>
          </PanGestureHandler>

          {mode === 'confirmDelete' ? (
            <>
              <View style={styles.header}>
                <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} onPress={() => setMode('menu')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Ionicons name="chevron-back" size={24} color={colors.text} />
                </TouchableOpacity>
                <Text style={styles.headerTitle}>{t('music.deletePlaylist')}</Text>
                <View style={{ width: 24 }} />
              </View>
              <Text style={styles.confirmBody}>{t('music.deleteConfirm')}</Text>
              <TouchableOpacity
                style={styles.deleteBtn}
                onPress={() => { const id = pl?.id; close(); if (id) onDelete(id); }}
                activeOpacity={0.85}
              >
                <Text style={styles.deleteBtnText}>{t('common.delete')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setMode('menu')} activeOpacity={0.7}>
                <Text style={styles.cancelText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.title} numberOfLines={1}>{pl?.name}</Text>
              <Text style={styles.subtitle}>{pl?.is_public ? t('music.publicPlaylist') : t('music.privatePlaylist')}</Text>

              <Pressable
                onPress={() => { const p = pl; close(); if (p) onToggleVisibility(p); }}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              >
                <Ionicons name={pl?.is_public ? 'lock-closed-outline' : 'globe-outline'} size={20} color={colors.text} />
                <Text style={styles.rowText}>{pl?.is_public ? t('music.makePrivate') : t('music.makePublic')}</Text>
              </Pressable>
              <Pressable onPress={() => setMode('confirmDelete')} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
                <Ionicons name="trash-outline" size={20} color={colors.error} />
                <Text style={[styles.rowText, { color: colors.error }]}>{t('music.deletePlaylist')}</Text>
              </Pressable>

              <TouchableOpacity style={styles.cancelBtn} onPress={close} activeOpacity={0.7}>
                <Text style={styles.cancelText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
            </>
          )}
        </Animated.View>
      </View>
    </GestureHandlerRootView>
  );

  return (
    <Modal visible={mounted} transparent animationType="none" onRequestClose={close} statusBarTranslucent>
      {inner}
    </Modal>
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
  confirmBody: { color: c.textSecondary, fontSize: 14, lineHeight: 21, paddingBottom: SPACING.sm },

  deleteBtn: {
    alignSelf: 'stretch', backgroundColor: c.error, borderRadius: RADIUS.full,
    alignItems: 'center', justifyContent: 'center', paddingVertical: SPACING.md, marginTop: SPACING.sm,
  },
  deleteBtnText: { color: '#fff', fontSize: 15, fontWeight: '800' },

  cancelBtn: { alignItems: 'center', paddingVertical: SPACING.md, marginTop: SPACING.xs },
  cancelText: { color: c.textSecondary, fontSize: 15, fontWeight: '700' },
});
