import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { usePremium } from '../contexts/PremiumContext';
import SwipeBackPager from '../components/SwipeBackPager';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import type { Pkg } from '../lib/purchases';

// Laybell Premium paywall. Reads offerings/status from RevenueCat via PremiumContext;
// perks are wired through lib/entitlements (unlimited offline + ad-free are live; the
// others are entitlement-ready). Until the RevenueCat keys + store products are set
// up (docs/PHASE_C_SETUP.md), `configured` is false and we show a "coming soon" state
// instead of a broken purchase button.
export default function PremiumScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { t } = useTranslation();
  const { isPremium, packages, configured, loading, purchase, restore } = usePremium();

  const perks = [
    { icon: 'cloud-download-outline' as const, label: t('premium.perkOffline') },
    { icon: 'musical-notes-outline' as const, label: t('premium.perkAdFree') },
    { icon: 'sparkles-outline' as const, label: t('premium.perkQuality') },
    { icon: 'ribbon-outline' as const, label: t('premium.perkBadge') },
  ];

  async function buy(pkg: Pkg) {
    const res = await purchase(pkg);
    if (res === 'error') Alert.alert(t('premium.title'), t('premium.purchaseError'));
    // 'ok' flips status via the customer-info listener (UI re-renders); 'cancelled' is a no-op.
  }

  async function onRestore() {
    const ok = await restore();
    Alert.alert(t('premium.title'), ok ? t('premium.restoredOk') : t('premium.restoredNone'));
  }

  return (
    <SwipeBackPager>
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={24} color={colors.primary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('premium.title')}</Text>
          <View style={{ width: 40 }} />
        </View>

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <LinearGradient colors={GRADIENTS.primarySoft as any} style={styles.hero}>
            <Ionicons name="star" size={34} color={colors.primary} />
            <Text style={styles.heroTitle}>{t('premium.title')}</Text>
            <Text style={styles.heroTagline}>{t('premium.tagline')}</Text>
          </LinearGradient>

          <View style={styles.perks}>
            {perks.map((p) => (
              <View key={p.label} style={styles.perkRow}>
                <Ionicons name={p.icon} size={20} color={colors.primary} />
                <Text style={styles.perkText}>{p.label}</Text>
              </View>
            ))}
          </View>

          {isPremium ? (
            <View style={styles.activeCard}>
              <Ionicons name="checkmark-circle" size={22} color={colors.primary} />
              <Text style={styles.activeTitle}>{t('premium.active')}</Text>
              <Text style={styles.activeBody}>{t('premium.activeBody')}</Text>
            </View>
          ) : !configured ? (
            <View style={styles.activeCard}>
              <Ionicons name="time-outline" size={22} color={colors.textTertiary} />
              <Text style={styles.activeTitle}>{t('premium.comingSoon')}</Text>
              <Text style={styles.activeBody}>{t('premium.comingSoonBody')}</Text>
            </View>
          ) : loading ? (
            <ActivityIndicator color={colors.primary} style={{ marginTop: SPACING.lg }} />
          ) : (
            <View style={styles.buy}>
              {packages.map((pkg) => (
                <TouchableOpacity key={pkg.identifier} style={styles.subscribeBtn} activeOpacity={0.85} onPress={() => buy(pkg)}>
                  <Text style={styles.subscribeText}>{t('premium.subscribe')}</Text>
                  <Text style={styles.subscribePrice}>{pkg.priceString}</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity style={styles.restoreBtn} onPress={onRestore}>
                <Text style={styles.restoreText}>{t('premium.restore')}</Text>
              </TouchableOpacity>
              <Text style={styles.legal}>{t('premium.legal')}</Text>
            </View>
          )}
        </ScrollView>
      </View>
    </SwipeBackPager>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  content: { padding: SPACING.md, paddingBottom: SPACING.xxl },

  hero: {
    alignItems: 'center', gap: SPACING.xs, paddingVertical: SPACING.xl, paddingHorizontal: SPACING.lg,
    borderRadius: RADIUS.lg, marginBottom: SPACING.lg,
  },
  heroTitle: { color: colors.text, fontSize: 22, fontWeight: '900', marginTop: SPACING.xs },
  heroTagline: { color: colors.textSecondary, fontSize: 14, textAlign: 'center', lineHeight: 20 },

  perks: { gap: SPACING.md, marginBottom: SPACING.lg },
  perkRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  perkText: { color: colors.text, fontSize: 15, flex: 1 },

  activeCard: {
    alignItems: 'center', gap: SPACING.xs, padding: SPACING.lg,
    borderRadius: RADIUS.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceLight,
  },
  activeTitle: { color: colors.text, fontSize: 16, fontWeight: '800', marginTop: SPACING.xs },
  activeBody: { color: colors.textTertiary, fontSize: 13, lineHeight: 19, textAlign: 'center' },

  buy: { gap: SPACING.md },
  subscribeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm,
    backgroundColor: colors.primary, paddingVertical: SPACING.md, borderRadius: RADIUS.lg,
  },
  subscribeText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  subscribePrice: { color: '#fff', fontSize: 14, fontWeight: '700', opacity: 0.9 },
  restoreBtn: { alignItems: 'center', paddingVertical: SPACING.sm },
  restoreText: { color: colors.primary, fontSize: 14, fontWeight: '700' },
  legal: { color: colors.textTertiary, fontSize: 11, lineHeight: 16, textAlign: 'center', marginTop: SPACING.xs },
});
