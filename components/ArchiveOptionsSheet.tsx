import { useEffect, useState } from 'react';
import { View, Text, Pressable, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import SlideUpSheet from './SlideUpSheet';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

// A themed long-press options menu for an archived item (storybook or story). The
// caller builds the row list, so it stays generic: pass a title + the options, and
// null `visible` to close. A row with `confirm` opens an in-sheet confirmation step
// (used for the destructive "delete permanently" action) instead of firing at once.
export type ArchiveOption = {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  tone?: 'default' | 'destructive';
  confirm?: { title: string; body: string; confirmLabel: string };
  onPress: () => void;
};

export default function ArchiveOptionsSheet({
  visible, title, subtitle, options, onClose,
}: {
  visible: boolean;
  title?: string;
  subtitle?: string;
  options: ArchiveOption[];
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const [confirmKey, setConfirmKey] = useState<string | null>(null);

  // Always open on the menu (not a stale confirm step from last time).
  useEffect(() => { if (visible) setConfirmKey(null); }, [visible]);

  const confirming = options.find((o) => o.key === confirmKey) ?? null;

  // Close first, then run the action a frame later so the sheet's slide-out isn't
  // competing with a navigation push / alert on the same tick.
  function fire(o: ArchiveOption) {
    onClose();
    requestAnimationFrame(() => o.onPress());
  }

  return (
    <SlideUpSheet visible={visible} onClose={onClose} sheetStyle={[styles.sheet, { paddingBottom: insets.bottom + SPACING.md }]}>
      {confirming ? (
        <>
          <View style={styles.confirmHead}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} onPress={() => setConfirmKey(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="chevron-back" size={24} color={colors.text} />
            </TouchableOpacity>
            <Text style={styles.confirmTitle} numberOfLines={1}>{confirming.confirm!.title}</Text>
            <View style={{ width: 24 }} />
          </View>
          <Text style={styles.confirmBody}>{confirming.confirm!.body}</Text>
          <TouchableOpacity style={styles.destructiveBtn} onPress={() => fire(confirming)} activeOpacity={0.85}>
            <Text style={styles.destructiveBtnText}>{confirming.confirm!.confirmLabel}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.cancelBtn} onPress={() => setConfirmKey(null)} activeOpacity={0.7}>
            <Text style={styles.cancelText}>{t('common.cancel')}</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <View style={styles.grab} />
          {title ? <Text style={styles.title} numberOfLines={1}>{title}</Text> : null}
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          {options.map((o) => (
            <Pressable
              key={o.key}
              onPress={() => { if (o.confirm) setConfirmKey(o.key); else fire(o); }}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <Ionicons name={o.icon} size={20} color={o.tone === 'destructive' ? colors.error : colors.text} />
              <Text style={[styles.rowText, o.tone === 'destructive' && { color: colors.error }]}>{o.label}</Text>
            </Pressable>
          ))}
          <TouchableOpacity style={styles.cancelBtn} onPress={onClose} activeOpacity={0.7}>
            <Text style={styles.cancelText}>{t('common.cancel')}</Text>
          </TouchableOpacity>
        </>
      )}
    </SlideUpSheet>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  sheet: {
    backgroundColor: c.surfaceElevated,
    borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl,
    borderWidth: 1, borderColor: c.border,
    paddingHorizontal: SPACING.lg, paddingTop: SPACING.sm,
  },
  grab: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: c.border, marginBottom: SPACING.sm },
  title: { color: c.text, fontSize: 16, fontWeight: '800', letterSpacing: -0.2 },
  subtitle: { color: c.textSecondary, fontSize: 12, marginTop: 1, marginBottom: SPACING.sm },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    paddingVertical: SPACING.md, paddingHorizontal: SPACING.sm, borderRadius: RADIUS.md,
  },
  rowPressed: { backgroundColor: c.surfaceLight },
  rowText: { color: c.text, fontSize: 15, fontWeight: '600' },
  cancelBtn: { alignItems: 'center', paddingVertical: SPACING.md, marginTop: SPACING.xs },
  cancelText: { color: c.textSecondary, fontSize: 15, fontWeight: '700' },
  confirmHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: SPACING.sm, marginTop: SPACING.xs },
  confirmTitle: { flex: 1, textAlign: 'center', color: c.text, fontSize: 16, fontWeight: '800' },
  confirmBody: { color: c.textSecondary, fontSize: 14, lineHeight: 21, paddingBottom: SPACING.sm },
  destructiveBtn: {
    alignSelf: 'stretch', backgroundColor: c.error, borderRadius: RADIUS.full,
    alignItems: 'center', justifyContent: 'center', paddingVertical: SPACING.md, marginTop: SPACING.sm,
  },
  destructiveBtnText: { color: '#fff', fontSize: 15, fontWeight: '800' },
});
