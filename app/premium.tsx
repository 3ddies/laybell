import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { usePremium } from '../contexts/PremiumContext';
import SwipeBackPager from '../components/SwipeBackPager';
// PLUS_RED lives in the theme — the Settings promo row wears the same brand
// when the member holds plus.
import { SPACING, RADIUS, GRADIENTS, SHADOWS, PLUS_RED, PLUS_RED_ACCENT, PLUS_RED_LIGHT, type ThemePalette } from '../constants/theme';
import type { Pkg } from '../lib/purchases';
import { DONATION_FEE_RATE_PREMIUM, DONATION_FEE_RATE_STANDARD } from '../lib/donations';
import { Skeleton, SkeletonLine } from '../components/Skeleton';
import PremiumBubbles from '../components/PremiumBubbles';

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

  // ── Each tier's button belongs under ITS OWN description ───────────────────
  // Both used to come out of one packages.map() in a single block at the bottom
  // of the page, which put two buttons under two descriptions with nothing
  // saying which bought which. On a page selling $9.99 beside $19.99 that is a
  // question about money, and the answer was "whichever order RevenueCat
  // returned them in".
  //
  // So the list is split and each half rendered next to the card it pays for.
  const plusPackages = packages.filter(isPlusPkg);
  const basePackages = packages.filter((p) => !isPlusPkg(p));

  // A Premium member still sees the Plus button — RevenueCat treats it as an
  // upgrade within the same subscription group — but never the $9.99 one again.
  const canBuyBase = configured && !loading && !isPremium && basePackages.length > 0;
  const canBuyPlus = configured && !loading && !isPremiumPlus && plusPackages.length > 0;

  // A function that RETURNS elements, deliberately not a component declared in
  // render: calling it inlines the nodes, where <Cta/> would be a new component
  // type every render and remount the button under the user's finger.
  const renderCta = (pkg: Pkg) => (
    <TouchableOpacity key={pkg.identifier} activeOpacity={0.85} onPress={() => buy(pkg)} style={styles.subscribeBtn}>
      {/* Plus packages sell on the red theme, matching their card. */}
      <LinearGradient colors={(isPlusPkg(pkg) ? PLUS_RED : GRADIENTS.primary) as any} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.subscribeInner}>
        <Text style={styles.subscribeText}>{t(isPlusPkg(pkg) ? 'premium.subscribePlus' : 'premium.subscribe')}</Text>
        {/* The price in a chip rather than as a second run of text. Two strings
            side by side read as a label that ran on; a chip reads as the price,
            and it is the number someone is looking for on this screen. */}
        <View style={styles.pricePill}>
          <Text style={styles.subscribePrice}>{pkg.priceString}</Text>
        </View>
      </LinearGradient>
    </TouchableOpacity>
  );

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

            {/* INSIDE the perks stack, as its last child. Sitting below the
                stack it was a pill floating between two sections, belonging to
                neither. As the closing row it picks up the stack's own gap, so
                it reads as where the list arrives — and the spacing is the
                container's rather than a margin tuned to match it, which is one
                fewer thing to drift.

                The skeleton takes the same place so the page does not reshuffle
                when the store call lands. */}
            {loading ? (
              <Skeleton width="100%" height={54} radius={RADIUS.full} />
            ) : canBuyBase ? basePackages.map(renderCta) : null}
          </View>

          {/* ── Premium+ — the tier above: Films, no ads, badge freeze, unlimited
                 downloads. Cinematic red with the same rising bubbles as the
                 Premium settings card, so the two tiers read as one family with
                 plus as the deeper cut. Includes everything Premium has. ── */}
          <View style={styles.plusCard}>
            <LinearGradient colors={PLUS_RED as any} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.plusHero}>
              {/* Behind the content; the card's overflow:hidden clips it. The
                  hero variant floats bigger bubbles up the EDGE lanes only, so
                  the centered title and tagline stay clear. */}
              <PremiumBubbles variant="hero" />
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

            {/* INSIDE the card, below the terms, behind a hairline. Nothing
                argues about which tier this buys when it is literally part of
                the Premium+ card — and the divider says "this is the action" the
                way the perks above are the pitch.

                One slot serves both the new subscriber and the $9.99 member
                upgrading; those were two separate renderings of the same button
                before, which is how they ended up in different places. */}
            {(loading || canBuyPlus) && (
              <View style={styles.plusFooter}>
                {loading
                  ? <Skeleton width="100%" height={54} radius={RADIUS.full} />
                  : plusPackages.map(renderCta)}
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
            </View>
          ) : !configured ? (
            <View style={styles.activeCard}>
              <Ionicons name="time-outline" size={22} color={colors.textTertiary} />
              <Text style={styles.activeTitle}>{t('premium.comingSoon')}</Text>
              <Text style={styles.activeBody}>{t('premium.comingSoonBody')}</Text>
            </View>
          ) : loading ? (
            // Only restore + legal are skeletoned here now; the two button
            // skeletons moved up to sit in the slots their buttons will fill.
            <View style={styles.buy}>
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

  // The Premium+ button's home, inside the card. The hairline separates action
  // from pitch; the padding matches plusPerks so the button lines up with the
  // perk text above rather than sitting a few pixels proud of it.
  plusFooter: {
    borderTopWidth: 1, borderTopColor: colors.border,
    padding: SPACING.md, gap: SPACING.sm,
  },

  // NO GLOW. It was ...SHADOWS.glow, which plusCard's overflow:'hidden' clips —
  // that card has to clip, it is what rounds the red hero and the bubbles — so
  // the two buttons would have glowed differently now that one lives inside it,
  // on the one screen where the tiers must look like one family. Dropped from
  // both and the presence put back as size and contrast instead: taller, a
  // brighter label, and the price in a chip. A flat pill inside a grouped card
  // is also what the platform's own subscription sheets do.
  subscribeBtn: { borderRadius: RADIUS.full, overflow: 'hidden' },
  subscribeInner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm,
    paddingVertical: SPACING.md + 4,
  },
  // Translucent white over either gradient, so one chip works on the orange and
  // the red without a per-tier colour.
  pricePill: {
    backgroundColor: 'rgba(255,255,255,0.22)',
    borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.sm + 2, paddingVertical: 3,
  },
  subscribeText: { color: '#fff', fontSize: 16.5, fontWeight: '900', letterSpacing: -0.2 },
  // Full opacity now: it sits on the chip's own tint, so the 0.9 that used to
  // separate it from the label was dimming the price against a lighter ground.
  subscribePrice: { color: '#fff', fontSize: 14, fontWeight: '800' },
  restoreBtn: { alignItems: 'center', paddingVertical: SPACING.sm },
  restoreText: { color: colors.primary, fontSize: 14, fontWeight: '700' },
  legal: { color: colors.textTertiary, fontSize: 11, lineHeight: 16, textAlign: 'center', marginTop: SPACING.xs },
  legalLink: { color: colors.primary, fontWeight: '700' },
});
