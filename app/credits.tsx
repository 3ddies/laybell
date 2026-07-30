import { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import SwipeBackPager from '../components/SwipeBackPager';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { getCreditPacks, purchaseCredits, purchasesConfigured, type Pkg } from '../lib/purchases';
import { fetchLedgerBalances } from '../lib/ledger';
import { SkeletonLine } from '../components/Skeleton';

// Buy Laybell Credits.
//
// Credits are SPEND-ONLY and never redeemable for cash. That is a legal boundary,
// not a product choice: a balance a user can cash out is stored value, which pulls
// Laybell into state money-transmitter territory. The copy on this screen says so
// plainly rather than burying it, because someone who expects a refundable balance
// and discovers otherwise has a legitimate complaint.
//
// The balance is NOT granted here. The store charges the card, RevenueCat's webhook
// posts the funding transaction into the ledger, and the balance follows — usually
// within seconds, but it is asynchronous. This screen therefore never claims the
// credits have landed; it says they are on the way and re-polls.
export default function CreditsScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const [packs, setPacks] = useState<Pkg[]>([]);
  const [loading, setLoading] = useState(true);
  const [buying, setBuying] = useState<string | null>(null);
  const [balanceCents, setBalanceCents] = useState<number | null>(null);
  const configured = purchasesConfigured();

  const loadBalance = useCallback(async () => {
    const b = await fetchLedgerBalances();
    setBalanceCents(b.ready ? b.credits.totalCents : null);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [p] = await Promise.all([getCreditPacks(), loadBalance()]);
      if (!alive) return;
      setPacks(p);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [loadBalance]);

  async function buy(pkg: Pkg) {
    if (buying) return;
    setBuying(pkg.identifier);
    const res = await purchaseCredits(pkg);
    setBuying(null);

    if (res === 'cancelled') return;
    if (res === 'error') { Alert.alert(t('credits.title'), t('credits.purchaseError')); return; }

    // 'ok' means the STORE charged the card — not that the ledger has the credits.
    // Crediting happens server-side when RevenueCat's webhook lands, so promising
    // an updated balance here would be a lie roughly as often as it was true.
    Alert.alert(t('credits.purchasedTitle'), t('credits.purchasedBody'));
    // Poll a couple of times: usually seconds, occasionally longer.
    setTimeout(loadBalance, 2500);
    setTimeout(loadBalance, 8000);
  }

  const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  return (
    <SwipeBackPager>
      {/* This screen is pushed as a transparentModal (app/_layout.tsx), so
          nothing above it reserves the status bar — the header has to clear the
          notch itself. insets.top + 8 is what every sibling uses (wallet, cart,
          shop, listing), and this one had simply never been given it. */}
      <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.backBtn}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('a11y.back')}
          >
            <Ionicons name="chevron-back" size={26} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('credits.title')}</Text>
          <View style={styles.backBtn} />
        </View>

        <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
          <LinearGradient colors={GRADIENTS.primary} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.balanceCard}>
            <Text style={styles.balanceLabel}>{t('credits.balanceLabel')}</Text>
            {balanceCents == null
              ? <SkeletonLine w={120} h={34} />
              : <Text style={styles.balanceValue}>{fmt(balanceCents)}</Text>}
            <Text style={styles.balanceHint}>{t('credits.balanceHint')}</Text>
          </LinearGradient>

          <Text style={styles.sectionTitle}>{t('credits.addTitle')}</Text>

          {!configured ? (
            <View style={styles.notice}>
              <Ionicons name="time-outline" size={18} color={colors.textSecondary} />
              <Text style={styles.noticeText}>{t('credits.comingSoon')}</Text>
            </View>
          ) : loading ? (
            <>
              <SkeletonLine w="100%" h={62} />
              <SkeletonLine w="100%" h={62} />
              <SkeletonLine w="100%" h={62} />
            </>
          ) : packs.length === 0 ? (
            // Configured but nothing came back: almost always the store products
            // aren't approved yet, or this is a simulator with no sandbox account.
            // Say something true rather than showing an empty screen.
            <View style={styles.notice}>
              <Ionicons name="alert-circle-outline" size={18} color={colors.textSecondary} />
              <Text style={styles.noticeText}>{t('credits.unavailable')}</Text>
            </View>
          ) : (
            packs.map((p) => (
              <TouchableOpacity
                key={p.identifier}
                style={styles.pack}
                onPress={() => buy(p)}
                disabled={!!buying}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel={t('credits.buyA11y', { price: p.priceString })}
                accessibilityState={{ disabled: !!buying, busy: buying === p.identifier }}
              >
                <View style={styles.packIcon}>
                  <Ionicons name="diamond-outline" size={20} color={colors.primary} />
                </View>
                <View style={styles.packBody}>
                  <Text style={styles.packTitle}>{p.title || p.identifier}</Text>
                  {!!p.description && <Text style={styles.packDesc} numberOfLines={1}>{p.description}</Text>}
                </View>
                {buying === p.identifier
                  ? <ActivityIndicator color={colors.primary} />
                  : <Text style={styles.packPrice}>{p.priceString}</Text>}
              </TouchableOpacity>
            ))
          )}

          {/* Stated up front, not buried. Someone who expects to cash this out and
              finds they can't has a fair grievance — so it is said before the
              purchase, not after. */}
          <Text style={styles.legal}>{t('credits.legal')}</Text>
        </ScrollView>
      </View>
    </SwipeBackPager>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
  },
  backBtn: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  body: { padding: SPACING.md, paddingBottom: SPACING.xl, gap: SPACING.sm },

  balanceCard: {
    borderRadius: RADIUS.lg, padding: SPACING.lg, alignItems: 'center', marginBottom: SPACING.sm,
  },
  balanceLabel: { color: 'rgba(255,255,255,0.9)', fontSize: 13, fontWeight: '600' },
  balanceValue: { color: '#fff', fontSize: 40, fontWeight: '800', marginTop: 2 },
  balanceHint: { color: 'rgba(255,255,255,0.85)', fontSize: 12, marginTop: 6, textAlign: 'center' },

  sectionTitle: { color: colors.text, fontSize: 15, fontWeight: '700', marginTop: SPACING.sm },

  pack: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.surface, borderRadius: RADIUS.md, padding: SPACING.md,
  },
  packIcon: {
    width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surfaceLight,
  },
  packBody: { flex: 1 },
  packTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  packDesc: { color: colors.textSecondary, fontSize: 12, marginTop: 1 },
  packPrice: { color: colors.primary, fontSize: 16, fontWeight: '700' },

  notice: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.surface, borderRadius: RADIUS.md, padding: SPACING.md,
  },
  noticeText: { color: colors.textSecondary, fontSize: 13, flex: 1, lineHeight: 18 },

  legal: { color: colors.textTertiary, fontSize: 11, lineHeight: 16, marginTop: SPACING.md },
});
