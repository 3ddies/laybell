import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Pressable, Animated, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

type Props = {
  visible: boolean;
  title: string;
  message?: string;
  confirmLabel: string;
  cancelLabel?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  /** Tint the icon + confirm button with the error color (for delete/remove). */
  destructive?: boolean;
  /** Optional middle action (e.g. a softer alternative) shown between confirm and cancel. */
  secondaryLabel?: string;
  onSecondary?: () => void;
  onConfirm: () => void;
  onCancel: () => void;
};

// Polished themed yes/no confirmation — a centered card with a fade + scale
// entrance, matching the BlockConfirm dialog. Renders as an absolute-fill overlay
// (no Modal of its own), so it's safe to drop inside an already-open Modal.
export default function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel,
  icon = 'alert-circle',
  destructive = false,
  secondaryLabel,
  onSecondary,
  onConfirm,
  onCancel,
}: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const anim = useRef(new Animated.Value(0)).current;
  // Stay mounted through the exit animation after `visible` flips to false.
  const [render, setRender] = useState(visible);

  useEffect(() => {
    if (visible) {
      setRender(true);
      anim.setValue(0);
      Animated.timing(anim, { toValue: 1, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    } else if (render) {
      Animated.timing(anim, { toValue: 0, duration: 140, easing: Easing.in(Easing.cubic), useNativeDriver: true })
        .start(({ finished }) => { if (finished) setRender(false); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!render) return null;
  const accent = destructive ? colors.error : colors.primary;

  return (
    <View style={styles.root}>
      <Animated.View style={[styles.backdrop, { opacity: anim }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} />
      </Animated.View>

      <Animated.View
        style={[
          styles.card,
          { opacity: anim, transform: [{ scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }] },
        ]}
      >
        <View style={[styles.icon, { backgroundColor: accent + '22' }]}>
          <Ionicons name={icon} size={26} color={accent} />
        </View>
        <Text style={styles.title}>{title}</Text>
        {!!message && <Text style={styles.body}>{message}</Text>}

        <TouchableOpacity
          style={[styles.confirmBtn, { backgroundColor: accent }]}
          onPress={onConfirm}
          activeOpacity={0.85}
        >
          <Text style={styles.confirmText}>{confirmLabel}</Text>
        </TouchableOpacity>
        {!!secondaryLabel && !!onSecondary && (
          <TouchableOpacity style={styles.secondaryBtn} onPress={onSecondary} activeOpacity={0.85}>
            <Text style={styles.secondaryText}>{secondaryLabel}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={styles.cancelBtn} onPress={onCancel} activeOpacity={0.7}>
          <Text style={styles.cancelText}>{cancelLabel ?? t('common.cancel')}</Text>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  root: { ...StyleSheet.absoluteFillObject, zIndex: 1000, alignItems: 'center', justifyContent: 'center', padding: SPACING.lg },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)' },
  card: {
    width: '100%', maxWidth: 360,
    backgroundColor: c.surfaceElevated,
    borderRadius: RADIUS.xl, borderWidth: 1, borderColor: c.border,
    padding: SPACING.lg, alignItems: 'center',
  },
  icon: {
    width: 56, height: 56, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center', marginBottom: SPACING.sm,
  },
  title: { color: c.text, fontSize: 18, fontWeight: '800', textAlign: 'center', letterSpacing: -0.3 },
  body: { color: c.textSecondary, fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: SPACING.xs },
  confirmBtn: {
    alignSelf: 'stretch', borderRadius: RADIUS.full,
    alignItems: 'center', justifyContent: 'center', paddingVertical: SPACING.md, marginTop: SPACING.md,
  },
  confirmText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  secondaryBtn: {
    alignSelf: 'stretch', borderRadius: RADIUS.full, borderWidth: 1, borderColor: c.border,
    alignItems: 'center', justifyContent: 'center', paddingVertical: SPACING.md, marginTop: SPACING.sm,
  },
  secondaryText: { color: c.text, fontSize: 15, fontWeight: '700' },
  cancelBtn: { alignSelf: 'stretch', alignItems: 'center', paddingVertical: SPACING.sm + 2, marginTop: SPACING.xs },
  cancelText: { color: c.textSecondary, fontSize: 15, fontWeight: '700' },
});
