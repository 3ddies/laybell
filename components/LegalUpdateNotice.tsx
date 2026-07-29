import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { RADIUS, SPACING, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

// Marketplace Terms §11 promises that material changes are communicated in the
// app. The 2026-07-29 revision is material — Shop purchases moved from
// "arrange payment with the seller" to Laybell credits, and the platform fee
// went 15% → 30% — so this is that communication.
//
// Shown once per user in the Shop shell (where the change applies), then
// remembered. Bump ACK_KEY on the next material revision to show it again;
// the old key is simply left behind, so nobody re-sees a notice they already
// dismissed.
//
// Fail-safe by construction: it starts hidden and only ever reveals itself
// after AsyncStorage confirms the user has NOT seen it. A storage error leaves
// it hidden rather than nagging on every mount.
const ACK_KEY = 'legal.marketplaceTerms.ack.2026-07-29';

export default function LegalUpdateNotice() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const router = useRouter();
  const [show, setShow] = useState(false);

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(ACK_KEY)
      .then((seen) => { if (alive && !seen) setShow(true); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!show) return null;

  const ack = () => {
    setShow(false);
    AsyncStorage.setItem(ACK_KEY, '1').catch(() => {});
  };

  return (
    <TouchableOpacity
      style={styles.card}
      activeOpacity={0.85}
      accessibilityRole="button"
      onPress={() => { ack(); router.push('/marketplace-terms'); }}
    >
      <Ionicons name="document-text-outline" size={20} color={colors.primary} />
      <View style={styles.textWrap}>
        <Text style={styles.title}>{t('legalUpdate.marketplaceTitle')}</Text>
        <Text style={styles.body}>{t('legalUpdate.marketplaceBody')}</Text>
      </View>
      <TouchableOpacity
        onPress={ack}
        hitSlop={10}
        style={styles.closeBtn}
        accessibilityRole="button"
        accessibilityLabel={t('a11y.close')}
      >
        <Ionicons name="close" size={18} color={colors.textSecondary} />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  card: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    marginHorizontal: SPACING.md, marginBottom: SPACING.sm,
    backgroundColor: c.surfaceLight,
    borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: c.primary + '3A',
    paddingVertical: SPACING.sm, paddingLeft: SPACING.md, paddingRight: SPACING.sm,
  },
  textWrap: { flex: 1, minWidth: 0 },
  title: { color: c.text, fontSize: 13.5, fontWeight: '700' },
  body: { color: c.textSecondary, fontSize: 12, marginTop: 1 },
  closeBtn: { padding: 2 },
});
