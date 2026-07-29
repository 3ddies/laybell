import { View, Text, TouchableOpacity, Image, StyleSheet, Share } from 'react-native';
import SlideUpSheet from './SlideUpSheet';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { SPACING, RADIUS } from '../constants/theme';
import { profileShareUrl } from '../lib/appLinks';
import { recordAppShare } from '../lib/badges';
import QRCodeView from './QRCodeView';

type Props = {
  visible: boolean;
  onClose: () => void;
  userId: string;
  username?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
};

// Bottom-sheet showing the user's profile QR. Scanning it opens the app to this
// profile, or (via web/open.html) sends the scanner to the app store if they
// don't have Laybell yet. The QR card stays white-on-dark regardless of theme so
// scanners always get the contrast they need.
export default function ProfileQRModal({ visible, onClose, userId, username, displayName, avatarUrl }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const url = profileShareUrl(userId);

  const onShare = async () => {
    try {
      const res = await Share.share({ message: url, url });
      // Only count it once the user actually shares (not on dismiss). The profile
      // QR routes non-users to the app store, so sharing it = inviting to the app;
      // it credits the App-sharing (Advocate) badge.
      if (res.action === Share.sharedAction) recordAppShare();
    } catch { /* share sheet dismissed or unavailable */ }
  };

  return (
    <SlideUpSheet
      visible={visible}
      onClose={onClose}
      sheetStyle={[styles.sheet, { backgroundColor: colors.surface ?? colors.background }]}
    >
          <View style={styles.grabber} />

          <View style={styles.headerRow}>
            <Text style={[styles.title, { color: colors.text }]}>{t('qr.title')}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10} style={styles.closeBtn} accessibilityRole="button" accessibilityLabel={t('a11y.close')}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={styles.qrCard}>
            <QRCodeView value={url} size={232} color="#101012" background="#ffffff" />
          </View>

          <View style={styles.identityRow}>
            {avatarUrl ? (
              <Image source={{ uri: avatarUrl }} style={styles.avatar} />
            ) : (
              <View style={[styles.avatar, styles.avatarFallback]}>
                <Ionicons name="person" size={18} color="#ffffff" />
              </View>
            )}
            <View style={styles.identityText}>
              {!!displayName && (
                <Text style={[styles.displayName, { color: colors.text }]} numberOfLines={1}>
                  {displayName}
                </Text>
              )}
              {!!username && (
                <Text style={[styles.username, { color: colors.textSecondary }]} numberOfLines={1}>
                  @{username}
                </Text>
              )}
            </View>
          </View>

          <Text style={[styles.subtitle, { color: colors.text }]}>{t('qr.subtitle')}</Text>
          <Text style={[styles.noApp, { color: colors.textSecondary }]}>{t('qr.noApp')}</Text>

          <TouchableOpacity style={[styles.shareBtn, { backgroundColor: colors.primary }]} onPress={onShare}>
            <Ionicons name="share-outline" size={18} color="#ffffff" />
            <Text style={styles.shareLabel}>{t('qr.share')}</Text>
          </TouchableOpacity>
    </SlideUpSheet>
  );
}

const styles = StyleSheet.create({
  // The backdrop lives in SlideUpSheet now — it has to be animated, and its
  // 0.55 dim is that component's default.
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.sm,
    paddingBottom: SPACING.xxl,
    alignItems: 'center',
  },
  grabber: {
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: 'rgba(128,128,128,0.4)',
    marginBottom: SPACING.md,
  },
  headerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    width: '100%', marginBottom: SPACING.lg,
  },
  title: { fontSize: 18, fontWeight: '800' },
  closeBtn: { padding: 2 },
  qrCard: {
    backgroundColor: '#ffffff',
    padding: SPACING.lg,
    borderRadius: RADIUS.lg,
    // Soft frame so the white card reads as a distinct surface in dark mode.
    shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 12, shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
  identityRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    marginTop: SPACING.lg, maxWidth: '100%',
  },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#333' },
  avatarFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#888' },
  identityText: { flexShrink: 1 },
  displayName: { fontSize: 15, fontWeight: '700' },
  username: { fontSize: 13, fontWeight: '500' },
  subtitle: { fontSize: 15, fontWeight: '700', marginTop: SPACING.md, textAlign: 'center' },
  noApp: { fontSize: 12.5, lineHeight: 18, marginTop: 4, textAlign: 'center', paddingHorizontal: SPACING.md },
  shareBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    marginTop: SPACING.lg, paddingVertical: 13, paddingHorizontal: SPACING.xl,
    borderRadius: RADIUS.full, alignSelf: 'stretch',
  },
  shareLabel: { color: '#ffffff', fontSize: 15, fontWeight: '700' },
});
