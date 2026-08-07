import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RADIUS, SPACING, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

// Shown when a background upload fails after the user has already left the
// composer — a story (StoryUploadContext) or a video (UploadQueueContext).
//
// It exists because the in-feed error card only helps if you are LOOKING at
// the feed. A failure you never see reads as the post silently vanishing.
//
// Retry re-runs the original job from its snapshot, so the caption, tags, song
// and any Spotlight survive — nothing has to be redone. The message says so,
// because the discouraging part of a failed upload is not the failure, it is
// not knowing whether your work is gone.

export default function UploadFailedBanner({ onRetry, onDismiss, message }: {
  onRetry: () => void;
  onDismiss: () => void;
  /** Defaults to the story wording. */
  message?: string;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.wrap, { top: insets.top + 8 }]} pointerEvents="box-none">
      <View style={styles.card}>
        <Ionicons name="cloud-offline-outline" size={20} color={colors.text} />
        {/* 4 lines, not 2: a truncated failure reason is worse than none —
            it turns "the upload didn't finish" into a mystery about whatever
            word happened to land before the ellipsis. */}
        <Text style={styles.text} numberOfLines={4}>{message ?? t('storyCamera.postFailBanner')}</Text>
        <TouchableOpacity onPress={onRetry} style={styles.retryBtn} hitSlop={6}>
          <Ionicons name="refresh" size={14} color="#fff" />
          <Text style={styles.retryText}>{t('common.retry')}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onDismiss} hitSlop={8} style={styles.closeBtn} accessibilityRole="button" accessibilityLabel={t('a11y.close')}>
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
