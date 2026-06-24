import { View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

// Small "Premium supporter" star chip shown next to a name on profiles. Visible to
// anyone (premium status is mirrored to profiles.premium_until by the RevenueCat
// webhook). `active` lets the current user's own profile light up instantly from the
// client's RevenueCat status before the webhook-written column catches up.
export default function SupporterBadge({
  premiumUntil, active, size = 11,
}: { premiumUntil?: string | null; active?: boolean; size?: number }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const live = active || (!!premiumUntil && new Date(premiumUntil).getTime() > Date.now());
  if (!live) return null;
  return (
    <View
      style={[styles.chip, { backgroundColor: colors.primary + '1A' }]}
      accessibilityLabel={t('premium.supporter')}
    >
      <Ionicons name="star" size={size} color={colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999 },
});
