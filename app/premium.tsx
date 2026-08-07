import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { usePremium } from '../contexts/PremiumContext';
import SwipeBackPager from '../components/SwipeBackPager';
import { SPACING, RADIUS, GRADIENTS, SHADOWS, type ThemePalette } from '../constants/theme';
import type { Pkg } from '../lib/purchases';
import { DONATION_FEE_RATE_PREMIUM, DONATION_FEE_RATE_STANDARD } from '../lib/donations';
import { Skeleton, SkeletonLine } from '../components/Skeleton';
import PremiumBubbles from '../components/PremiumBubbles';

// Premium+ brand: cinematic red — Films is the flagship perk, and red keeps the
// tier in the same warm family as Premium's orange instead of a cold departure
// (the galaxy purple it replaced belonged to Spotlight anyway). Owner call,
// 2026-08-07. Same three-stop shape as the gradients in constants/theme.
const PLUS_RED = ['#4A0812', '#8E1023', '#D91E36'] as const;
const PLUS_RED_ACCENT = '#D91E36'; // solid brand red, for icons on light ground
const PLUS_RED_LIGHT = '#FF8B98';  // legible red on the dark card body

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
  const { isPremium, isPremiumPlus, packages, configured, loading, purchase, restore } = usePremium();

  // Premium+ packages are told apart by their product id ('laybell_premium_plus…'
  // — must match RevenueCat + the webhook). Everything else sells the $9.99 tier.
  const isPlusPkg = (pkg: Pkg) => /plus/i.test(pkg.identifier);

  // Earn Money leads and is highlighted so the eye lands on it first.
  const perks = [
    // The two rates come from the constants that actually charge, not from
    // prose — see the note on premium.perkEarnDesc in lib/i18n.
    {
      icon: 'cash-outline' as const,
      label: t('premium.perkEarn'),
      desc: t('premium.perkEarnDesc', {
        premium: String(Math.round(DONATION_FEE_RATE_PREMIUM * 100)),
        standard: String(Math.round(DONATION_FEE_RATE_STANDARD * 100)),
      }),
      highlight: true,
    },
    { icon: 'people-outline' as const, label: t('premium.perkFollowers'), desc: t('premium.perkFollowersDesc') },
    { icon: 'musical-notes-outline' as const, label: t('premium.perkLessAds'), desc: t('premium.perkLessAdsDesc') },
    { icon: 'flash-outline' as const, label: t('premium.perkSpotlight'), desc: t('premium.perkSpotlightDesc') },
    { icon: 'ribbon-outline' as const, label: t('premium.perkBadgeGrace'), desc: t('premium.perkBadgeGraceDesc') },
    { icon: 'list-outline' as const, label: t('premium.perkMusicOrder'), desc: t('premium.perkMusicOrderDesc') },
    // Unlimited downloads moved UP to Premium+ (owner, 2026-08-07) — the row
    // lives on the plus card now, and effectivePinLimit gates on plus to match.
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
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} style={styles.backBtn} onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('premium.title')}</Text>
          <View style={{ width: 40 }} />
        </View>

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <LinearGradient colors={GRADIENTS.primary as any} style={styles.hero} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
            <View style={styles.heroGlow} />
            <View style={styles.heroBadge}>
              <Ionicons name="star" size={28} color="#fff" />
            </View>
            <Text style={styles.heroEyebrow}>{t('premium.heroEyebrow')}</Text>
            <Text style={styles.heroTitle}>{t('premium.title')}</Text>
            <Text style={styles.heroTagline}>{t('premium.tagline')}</Text>
          </LinearGradient>

          <Text style={styles.perksTitle}>{t('premium.perksTitle')}</Text>
          <View style={styles.perks}>
            {perks.map((p) => (
              <View key={p.label} style={[styles.perkRow, p.highlight && styles.perkRowHighlight]}>
                <View style={[styles.perkIcon, p.highlight && styles.perkIconHighlight]}>
                  <Ionicons name={p.icon} size={p.highlight ? 24 : 20} color={p.highlight ? '#fff' : colors.primary} />
                </View>
                <View style={styles.perkBody}>
                  <Text style={[styles.perkText, p.highlight && styles.perkTextHighlight]}>{p.label}</Text>
                  <Text style={styles.perkDesc}>{p.desc}</Text>
                </View>
              </View>
            ))}
          </View>

          {/* ── Premium+ — the tier above: Films, no ads, badge freeze, unlimited
                 downloads. Cinematic red with the same rising bubbles as the
                 Premium settings card, so the two tiers read as one family with
                 plus as the deeper cut. Includes everything Premium has. ── */}
          <View style={styles.plusCard}>
            <LinearGradient colors={PLUS_RED as any} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.plusHero}>
              {/* Behind the content; the card's overflow:hidden clips it. */}
              <PremiumBubbles />
              <View style={styles.plusBadge}>
                <Ionicons name="film-outline" size={22} color="#fff" />
              </View>
              <Text style={styles.plusTitle}>{t('premium.plusTitle')}</Text>
              <Text style={styles.plusTagline}>{t('premium.plusTagline')}</Text>
            </LinearGradient>
            <View style={styles.plusPerks}>
              <View style={styles.plusPerkRow}>
                <Ionicons name="film-outline" size={20} color={PLUS_RED_LIGHT} />
                <View style={styles.perkBody}>
                  <Text style={styles.perkText}>{t('premium.plusPerkFilms')}</Text>
                  <Text style={styles.perkDesc}>{t('premium.plusPerkFilmsDesc')}</Text>
                </View>
              </View>
              <View style={styles.plusPerkRow}>
                <Ionicons name="snow-outline" size={20} color={PLUS_RED_LIGHT} />
                <View style={styles.perkBody}>
                  <Text style={styles.perkText}>{t('premium.plusPerkFreeze')}</Text>
                  <Text style={styles.perkDesc}>{t('premium.plusPerkFreezeDesc')}</Text>
                </View>
              </View>
              <View style={styles.plusPerkRow}>
                <Ionicons name="ban-outline" size={20} color={PLUS_RED_LIGHT} />
                <View style={styles.perkBody}>
                  <Text style={styles.perkText}>{t('premium.plusPerkNoAds')}</Text>
                  <Text style={styles.perkDesc}>{t('premium.plusPerkNoAdsDesc')}</Text>
                </View>
              </View>
              <View style={styles.plusPerkRow}>
                <Ionicons name="cloud-download-outline" size={20} color={PLUS_RED_LIGHT} />
                <View style={styles.perkBody}>
                  <Text style={styles.perkText}>{t('premium.perkOffline')}</Text>
                  <Text style={styles.perkDesc}>{t('premium.perkOfflineDesc')}</Text>
                </View>
              </View>
            </View>
            {/* The film-removal terms, stated BEFORE anyone pays — the same
                warning fires again at lapse time, but nobody should learn the
                rule only on the way out. */}
            <Text style={styles.plusNote}>{t('premium.plusFilmNote')}</Text>
            {isPremiumPlus && (
              <View style={styles.plusActiveRow}>
                <Ionicons name="checkmark-circle" size={18} color={PLUS_RED_LIGHT} />
                <Text style={styles.plusActiveText}>{t('premium.plusActive')}</Text>
              </View>
            )}
          </View>

          {isPremium ? (
            <View style={styles.buy}>
              {/* The member card names the tier the member actually holds — a
                  Premium+ subscriber reading "Premium member" looks like a
                  billing error, not a thank-you. */}
              <View style={styles.activeCard}>
                <Ionicons name="checkmark-circle" size={22} color={isPremiumPlus ? PLUS_RED_ACCENT : colors.primary} />
                <Text style={styles.activeTitle}>{t(isPremiumPlus ? 'premium.activePlus' : 'premium.active')}</Text>
                <Text style={styles.activeBody}>{t('premium.activeBody')}</Text>
              </View>
              {/* A $9.99 subscriber can still move up — RevenueCat treats the
                  plus purchase as an upgrade of the same subscription group. */}
              {!isPremiumPlus && configured && packages.filter(isPlusPkg).map((pkg) => (
                <TouchableOpacity key={pkg.identifier} activeOpacity={0.85} onPress={() => buy(pkg)} style={styles.subscribeBtn}>
                  <LinearGradient colors={PLUS_RED as any} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.subscribeInner}>
                    <Text style={styles.subscribeText}>{t('premium.subscribePlus')}</Text>
                    <Text style={styles.subscribePrice}>{pkg.priceString}</Text>
                  </LinearGradient>
                </TouchableOpacity>
              ))}
            </View>
          ) : !configured ? (
            <View style={styles.activeCard}>
              <Ionicons name="time-outline" size={22} color={colors.textTertiary} />
              <Text style={styles.activeTitle}>{t('premium.comingSoon')}</Text>
              <Text style={styles.activeBody}>{t('premium.comingSoonBody')}</Text>
            </View>
          ) : loading ? (
            <View style={styles.buy}>
              <Skeleton width="100%" height={50} radius={RADIUS.full} />
              <Skeleton width="100%" height={50} radius={RADIUS.full} />
              <View style={{ alignItems: 'center', paddingVertical: SPACING.sm }}>
                <SkeletonLine w={90} h={14} />
              </View>
              <View style={{ alignItems: 'center', gap: SPACING.xs }}>
                <SkeletonLine w="80%" h={11} />
                <SkeletonLine w="65%" h={11} />
              </View>
            </View>
          ) : (
            <View style={styles.buy}>
              {packages.map((pkg) => (
                <TouchableOpacity key={pkg.identifier} activeOpacity={0.85} onPress={() => buy(pkg)} style={styles.subscribeBtn}>
                  {/* Plus packages sell on the red theme, matching their card. */}
                  <LinearGradient colors={(isPlusPkg(pkg) ? PLUS_RED : GRADIENTS.primary) as any} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.subscribeInner}>
                    <Text style={styles.subscribeText}>{t(isPlusPkg(pkg) ? 'premium.subscribePlus' : 'premium.subscribe')}</Text>
                    <Text style={styles.subscribePrice}>{pkg.priceString}</Text>
                  </LinearGradient>
                </TouchableOpacity>
              ))}
              <TouchableOpacity style={styles.restoreBtn} onPress={onRestore}>
                <Text style={styles.restoreText}>{t('premium.restore')}</Text>
              </TouchableOpacity>
              <Text style={styles.legal}>{t('premium.legal')}</Text>
              <Text style={styles.legal}>
                {t('premium.legalAgree')}{' '}
                <Text style={styles.legalLink} onPress={() => router.push('/terms-of-service')}>{t('about.terms')}</Text>
                {' '}{t('premium.legalAnd')}{' '}
                <Text style={styles.legalLink} onPress={() => router.push('/privacy-policy')}>{t('about.privacyPolicy')}</Text>.
              </Text>
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
    borderRadius: RADIUS.xl, marginBottom: SPACING.lg, overflow: 'hidden',
    ...SHADOWS.glow,
  },
  heroGlow: {
    position: 'absolute', top: -60, right: -40,
    width: 180, height: 180, borderRadius: 90,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  heroBadge: {
    width: 64, height: 64, borderRadius: RADIUS.full,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)',
  },
  heroEyebrow: {
    color: 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: '800',
    letterSpacing: 2, marginTop: SPACING.sm,
  },
  heroTitle: { color: '#fff', fontSize: 26, fontWeight: '900', marginTop: 2, textAlign: 'center' },
  heroTagline: { color: 'rgba(255,255,255,0.92)', fontSize: 14, textAlign: 'center', lineHeight: 20 },

  perksTitle: {
    color: colors.textTertiary, fontSize: 11, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: SPACING.md, paddingHorizontal: SPACING.xs,
  },
  perks: { gap: SPACING.sm, marginBottom: SPACING.lg },
  perkRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: colors.border, padding: SPACING.md,
  },
  perkIcon: {
    width: 44, height: 44, borderRadius: RADIUS.full,
    backgroundColor: colors.primary + '18',
    alignItems: 'center', justifyContent: 'center',
  },
  perkBody: { flex: 1, gap: 2 },
  perkText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  perkDesc: { color: colors.textSecondary, fontSize: 12, lineHeight: 17 },
  // "Earn Money" — the eye-catching lead perk: accent border/tint + a solid
  // primary icon disc and a bigger, heavier label.
  perkRowHighlight: {
    borderColor: colors.primary, borderWidth: 1.5,
    backgroundColor: colors.primary + '14',
  },
  perkIconHighlight: { backgroundColor: colors.primary },
  perkTextHighlight: { fontSize: 18, fontWeight: '900', color: colors.text },

  // Premium+ card — cinematic red (see PLUS_RED above) so the tier reads as
  // its own product while staying in Premium's warm family.
  plusCard: {
    borderRadius: RADIUS.xl, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surfaceLight, overflow: 'hidden', marginBottom: SPACING.lg,
  },
  plusHero: { alignItems: 'center', gap: 4, paddingVertical: SPACING.lg, paddingHorizontal: SPACING.lg },
  plusBadge: {
    width: 44, height: 44, borderRadius: RADIUS.full,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)', marginBottom: 2,
  },
  plusTitle: { color: '#fff', fontSize: 22, fontWeight: '900', letterSpacing: -0.3 },
  plusTagline: { color: 'rgba(255,255,255,0.9)', fontSize: 13, textAlign: 'center', lineHeight: 18 },
  plusPerks: { gap: SPACING.md, padding: SPACING.md },
  plusPerkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.md },
  plusNote: {
    color: colors.textTertiary, fontSize: 11, lineHeight: 16,
    paddingHorizontal: SPACING.md, paddingBottom: SPACING.md,
  },
  plusActiveRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingBottom: SPACING.md,
  },
  plusActiveText: { color: colors.text, fontSize: 13.5, fontWeight: '800' },

  activeCard: {
    alignItems: 'center', gap: SPACING.xs, padding: SPACING.lg,
    borderRadius: RADIUS.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceLight,
  },
  activeTitle: { color: colors.text, fontSize: 16, fontWeight: '800', marginTop: SPACING.xs },
  activeBody: { color: colors.textTertiary, fontSize: 13, lineHeight: 19, textAlign: 'center' },

  buy: { gap: SPACING.md },
  subscribeBtn: { borderRadius: RADIUS.full, overflow: 'hidden', ...SHADOWS.glow },
  subscribeInner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm,
    paddingVertical: SPACING.md + 2,
  },
  subscribeText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  subscribePrice: { color: '#fff', fontSize: 14, fontWeight: '700', opacity: 0.9 },
  restoreBtn: { alignItems: 'center', paddingVertical: SPACING.sm },
  restoreText: { color: colors.primary, fontSize: 14, fontWeight: '700' },
  legal: { color: colors.textTertiary, fontSize: 11, lineHeight: 16, textAlign: 'center', marginTop: SPACING.xs },
  legalLink: { color: colors.primary, fontWeight: '700' },
});
