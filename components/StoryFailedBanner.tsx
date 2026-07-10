import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RADIUS, SPACING, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

// Shown by StoryUploadContext when a story's background upload fails all its
// retries after the user has already left the composer. Tap Retry to re-run the
// post (the local capture file is reused), or dismiss to give up.

export default function StoryFailedBanner({ onRetry, onDismiss }: {
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.wrap, { top: insets.top + 8 }]} pointerEvents="box-none">
      <View style={styles.card}>
        <Ionicons name="cloud-offline-outline" size={20} color={colors.text} />
        <Text style={styles.text} numberOfLines={1}>{t('storyCamera.postFailBanner')}</Text>
        <TouchableOpacity onPress={onRetry} style={styles.retryBtn} hitSlop={6}>
          <Ionicons name="refresh" size={14} color="#fff" />
          <Text style={styles.retryText}>{t('common.retry')}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onDismiss} hitSlop={8} style={styles.closeBtn}>
          <Ionicons name="close" size={18} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  wrap: { position: 'absolute', left: SPACING.md, right: SPACING.md, zIndex: 70 },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: c.surfaceElevated,
    borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: c.border,
    paddingVertical: SPACING.sm, paddingLeft: SPACING.md, paddingRight: SPACING.sm,
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 8,
  },
  text: { flex: 1, color: c.text, fontSize: 14, fontWeight: '600' },
  retryBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: c.primary, borderRadius: RADIUS.full,
    paddingVertical: 6, paddingHorizontal: SPACING.md,
  },
  retryText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  closeBtn: { padding: 2 },
});
