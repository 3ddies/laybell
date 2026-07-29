import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  ActivityIndicator, Image, Alert, RefreshControl, Modal,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useState, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import {
  SPOTLIGHT_PACKAGES, fmtPrice, packageFor, effectiveStatus, timeLeftLabel, rampHoursFor,
  purchaseCampaign, activateCampaign, cancelPendingCampaign, endCampaign,
  fetchMyCampaigns, setPendingSpotlight, clearPendingSpotlight, spotlightDurationPhrase,
  fetchFreeSpotlightAvailable, claimFreeSpotlight,
  type SpotlightPackage, type SpotlightCampaign, type SpotlightStatus,
} from '../lib/spotlight';
import { isAudioPost } from '../lib/genres';
import VideoThumb from '../components/VideoThumb';
import SwipeBackPager from '../components/SwipeBackPager';
import ConfirmDialog from '../components/ConfirmDialog';
import SpotlightLiveDialog from '../components/SpotlightLiveDialog';
import { SPACING, RADIUS, SHADOWS, type ThemePalette } from '../constants/theme';
import { Skeleton, SkeletonLine, GridSkeleton } from '../components/Skeleton';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { countLabel } from '../lib/i18n';

// Spotlight manager (reached from the profile's Spotlight button and Settings).
// Pay (simulated) → the campaign is born `pending` → attach a post (an
// existing public one via the grid here, or a brand-new one via the composer
// handoff in lib/spotlight) → it launches as the Home feed's #3 post (climbing
// toward #1 only when genuinely trending) and holds placement as long as
// engagement backs it up. Campaign cards double as the basic analytics view:
// views, taps, likes, time left.

type FlowStep = 'package' | 'pay' | 'choose' | 'grid';

function statusLabel(s: SpotlightStatus, t: (k: string) => string): string {
  switch (s) {
    case 'pending': return t('spotlight.statusPending');
    case 'active': return t('spotlight.statusLive');
    case 'ended': return t('spotlight.statusEnded');
    case 'canceled': return t('spotlight.statusCanceled');
  }
}

function thumbFor(post: any): { uri: string | null; video: boolean } {
  if (!post) return { uri: null, video: false };
  if (post.type === 'video') return { uri: post.thumbnail_url ?? null, video: true };
  if (post.type === 'slideshow') return { uri: post.thumbnail_url || post.media_url, video: false };
  if (isAudioPost(post.type)) return { uri: post.cover_url ?? null, video: false };
  return { uri: post.media_url ?? null, video: false };
}

export default function SpotlightScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const router = useRouter();

  const [campaigns, setCampaigns] = useState<SpotlightCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Premium free monthly Spotlight: whether this month's credit is unclaimed, and
  // whether the CURRENT create flow is spending it (skips package/pay → grid).
  const [freeAvailable, setFreeAvailable] = useState(false);
  const [freeFlow, setFreeFlow] = useState(false);

  // Create / resume flow (modal)
  const [flowOpen, setFlowOpen] = useState(false);
  const [flowStep, setFlowStep] = useState<FlowStep>('package');
  const [pkg, setPkg] = useState<SpotlightPackage | null>(null);
  const [paying, setPaying] = useState(false);
  // Synchronous re-entry guard: `paying` state only disables the button after a
  // re-render commits, so a fast double-tap would buy twice without this.
  const payingRef = useRef(false);
  const [flowCampaign, setFlowCampaign] = useState<SpotlightCampaign | null>(null);
  const [myPosts, setMyPosts] = useState<any[]>([]);
  const [postsLoading, setPostsLoading] = useState(false);
  const [attachingId, setAttachingId] = useState<string | null>(null);

  // Themed dialogs (no stock system alerts in the main flow).
  const [pickTarget, setPickTarget] = useState<any | null>(null); // post awaiting spotlight confirm
  const [liveDuration, setLiveDuration] = useState<string | null>(null); // success dialog
  const [cancelTarget, setCancelTarget] = useState<SpotlightCampaign | null>(null);
  const [endTarget, setEndTarget] = useState<SpotlightCampaign | null>(null);

  const load = useCallback(async () => {
    const [camps, free] = await Promise.all([fetchMyCampaigns(), fetchFreeSpotlightAvailable()]);
    setCampaigns(camps);
    setFreeAvailable(free);
    setLoading(false);
    setRefreshing(false);
  }, []);

  // Reload whenever the screen gains focus — a campaign may have just gone
  // live through the composer handoff.
  useFocusEffect(useCallback(() => { load(); }, [load]));

  // The attractive landing shows whenever nothing is currently live; once a
  // spotlight is active the screen switches to the practical management view.
  const hasActive = campaigns.some((c) => effectiveStatus(c) === 'active');

  function statusColor(s: SpotlightStatus): string {
    switch (s) {
      case 'active': return colors.primary;
      case 'pending': return '#F59E0B';
      default: return colors.textTertiary;
    }
  }

  // ─── Create flow ────────────────────────────────────────────────────────────

  function startFlow() {
    setFreeFlow(false);
    setPkg(null);
    setFlowCampaign(null);
    setFlowStep('package');
    setFlowOpen(true);
  }

  // Premium free monthly boost: skip package + payment and go straight to picking
  // an existing post; claimFreeSpotlight mints the 1-day Spotlight on pick.
  function startFreeFlow() {
    setFreeFlow(true);
    setPkg(packageFor('1d'));   // for labels/duration only — no charge
    setFlowCampaign(null);
    setFlowOpen(true);
    openPostGrid();             // sets step 'grid' and loads eligible posts
  }

  // A paid `pending` campaign (e.g. the app died mid-flow) re-enters at the
  // choose step — the purchase is never lost.
  function resumeFlow(c: SpotlightCampaign) {
    setFlowCampaign(c);
    setPkg(packageFor(c.package_key));
    setFlowStep('choose');
    setFlowOpen(true);
  }

  async function handlePay() {
    if (!pkg || payingRef.current) return;
    payingRef.current = true;
    setPaying(true);
    try {
      const campaign = await purchaseCampaign(pkg);
      // A null here means the purchase SUCCEEDED but the follow-up read of the
      // row failed — the credits are already spent and the campaign exists. Say
      // that, rather than "could not complete the purchase", and refresh so it
      // shows up in the pending list where it can be used or cancelled.
      if (!campaign) {
        Alert.alert(t('spotlight.payFailedTitle'), t('spotlight.purchasedNotShown'));
        load();
        return;
      }
      setFlowCampaign(campaign);
      setFlowStep('choose');
      load();
    } catch (e: any) {
      // purchaseCampaign now THROWS on RPC failure so callers can tell "no
      // credits" from "offline". Without this catch it was an unhandled
      // rejection: the spinner stopped, nothing was said, and the user tapped
      // Pay again — buying a second campaign, because there is no idempotency
      // key on a purchase the user genuinely repeated.
      const msg = String(e?.message ?? '');
      if (msg.includes('insufficient funds')) {
        Alert.alert(t('spotlight.payFailedTitle'), t('spotlight.needCredits'));
        router.push('/credits');
      } else {
        Alert.alert(t('spotlight.payFailedTitle'), t('spotlight.payFailedBody'));
      }
    } finally {
      payingRef.current = false;
      setPaying(false);
    }
  }

  // Own public, non-archived posts that aren't already spotlighted.
  async function openPostGrid() {
    setFlowStep('grid');
    setPostsLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setMyPosts([]); return; }
      const base = () => supabase
        .from('posts')
        .select('id, type, media_url, thumbnail_url, cover_url, caption, created_at')
        .eq('user_id', user.id)
        .eq('is_public', true)
        .order('created_at', { ascending: false });
      // archived_at is absent until the archive migration — fall back cleanly.
      let { data, error } = await base().is('archived_at', null);
      if (error) ({ data } = await base());
      const taken = new Set(
        campaigns
          .filter(c => c.status === 'pending' || effectiveStatus(c) === 'active')
          .map(c => c.post_id)
          .filter(Boolean),
      );
      setMyPosts((data ?? []).filter((p: any) => !taken.has(p.id)));
    } finally {
      setPostsLoading(false);
    }
  }

  function handleNewPost() {
    if (!flowCampaign || !pkg) return;
    setPendingSpotlight({ campaignId: flowCampaign.id, days: pkg.days, label: pkg.label });
    setFlowOpen(false);
    // ONE atomic op: pop the Spotlight modal (and any modal stacked beneath it,
    // e.g. when opened from Settings) AND select the EXISTING composer tab.
    // Two things were wrong before: (a) a BARE '/post' href issued from this
    // transparent modal doesn't resolve to the live (tabs) pager — the root
    // Stack re-resolves it into a SECOND (tabs) group (which starts on Home),
    // double-mounting HomeScreen (the realtime-channel crash); (b) dismissAll()
    // + a separately-dispatched navigate() raced, and the dismiss-to-profile
    // landing committed last, so the composer flashed then bounced to Profile.
    // dismissTo with the GROUP-QUALIFIED href fixes both: it's a single POP_TO
    // dispatch (no race) and the '(tabs)' segment pins resolution to the
    // already-mounted pager (no duplicate group), the same reason an in-tab
    // router.navigate('/explore') works. Fallback (older expo-router without
    // dismissTo) keeps the grouped href — the bare '/post' was itself the bug.
    const r = router as any;
    if (typeof r.dismissTo === 'function') {
      r.dismissTo('/(tabs)/post');
    } else {
      try { r.dismissAll?.(); } catch {}
      r.navigate('/(tabs)/post');
    }
  }

  function handlePickPost(post: any) {
    if (!flowCampaign || !pkg || attachingId) return;
    setPickTarget(post);
  }

  async function confirmPick() {
    const post = pickTarget;
    setPickTarget(null);
    if (!pkg || !post || attachingId) return;
    // Free flow has no pre-bought campaign — the RPC mints one on claim.
    if (!freeFlow && !flowCampaign) return;
    setAttachingId(post.id);
    if (freeFlow) {
      const res = await claimFreeSpotlight(post.id);
      setAttachingId(null);
      if (!res.ok) {
        if (res.reason === 'already_claimed') setFreeAvailable(false);
        Alert.alert(
          t('spotlight.errorTitle'),
          res.reason === 'already_claimed' ? t('spotlight.freeAlreadyClaimed') : t('spotlight.startFailedBody'),
        );
        return;
      }
    } else {
      const ok = await activateCampaign(flowCampaign!.id, post.id, pkg.days);
      setAttachingId(null);
      if (!ok) {
        Alert.alert(t('spotlight.errorTitle'), t('spotlight.startFailedBody'));
        return;
      }
    }
    // Any parked "create a new post" handoff is stale now that the
    // campaign went live through the grid.
    clearPendingSpotlight();
    setFlowOpen(false);
    load();
    // The celebratory themed dialog (renders at the screen root, which is
    // visible again now that the flow modal is down).
    setLiveDuration(spotlightDurationPhrase(pkg.label));
  }

  // ─── Campaign card actions ──────────────────────────────────────────────────

  function confirmCancelPending(c: SpotlightCampaign) {
    setCancelTarget(c);
  }

  async function doCancelPending() {
    const c = cancelTarget;
    setCancelTarget(null);
    if (!c) return;
    const ok = await cancelPendingCampaign(c.id);
    if (ok) load();
    else Alert.alert(t('spotlight.errorTitle'), t('spotlight.cancelFailedBody'));
  }

  function confirmEndEarly(c: SpotlightCampaign) {
    setEndTarget(c);
  }

  async function doEndEarly() {
    const c = endTarget;
    setEndTarget(null);
    if (!c) return;
    const ok = await endCampaign(c.id);
    if (ok) load();
    else Alert.alert(t('spotlight.errorTitle'), t('spotlight.endFailedBody'));
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  function renderCampaign(c: SpotlightCampaign) {
    const status = effectiveStatus(c);
    const pack = packageFor(c.package_key);
    const { uri, video } = thumbFor(c.posts);
    const likeCount = c.posts?.likes?.[0]?.count ?? 0;
    return (
      <View key={c.id} style={styles.card}>
        <View style={styles.cardTop}>
          {c.posts ? (
            video && !uri ? (
              <VideoThumb thumbnailUrl={c.posts.thumbnail_url} mediaUrl={c.posts.media_url} style={styles.cardThumb} />
            ) : uri ? (
              <Image source={{ uri }} style={styles.cardThumb} resizeMode="cover" />
            ) : (
              <View style={[styles.cardThumb, styles.cardThumbPlaceholder]}>
                <Ionicons name={isAudioPost(c.posts.type) ? 'musical-notes' : 'image'} size={20} color={colors.primary} />
              </View>
            )
          ) : (
            <View style={[styles.cardThumb, styles.cardThumbPlaceholder]}>
              <Ionicons name="sparkles-outline" size={20} color={colors.primary} />
            </View>
          )}
          <View style={styles.cardInfo}>
            <View style={styles.cardTitleRow}>
              <Text style={styles.cardTitle}>{pack?.label ?? c.package_key} · {fmtPrice(c.price_cents)}</Text>
              <View style={[styles.statusChip, { borderColor: statusColor(status) }]}>
                <Text style={[styles.statusChipText, { color: statusColor(status) }]}>{statusLabel(status, t)}</Text>
              </View>
            </View>
            <Text style={styles.cardCaption} numberOfLines={1}>
              {c.posts?.caption || (status === 'pending' ? t('spotlight.noPostAttached') : t('spotlight.postUnavailable'))}
            </Text>
            <Text style={styles.cardMeta}>
              {status === 'active'
                ? timeLeftLabel(c.ends_at)
                : t('spotlight.purchasedOn', { date: new Date(c.created_at).toLocaleDateString() })}
            </Text>
          </View>
        </View>

        {status !== 'pending' && (
          <View style={styles.statsRow}>
            <View style={styles.stat}>
              <Ionicons name="eye-outline" size={15} color={colors.textSecondary} />
              <Text style={styles.statText}>{countLabel('view', c.impression_count)}</Text>
            </View>
            <View style={styles.stat}>
              <Ionicons name="hand-left-outline" size={15} color={colors.textSecondary} />
              <Text style={styles.statText}>{countLabel('tap', c.tap_count)}</Text>
            </View>
            <View style={styles.stat}>
              <Ionicons name="heart-outline" size={15} color={colors.textSecondary} />
              <Text style={styles.statText}>{countLabel('like', likeCount)}</Text>
            </View>
          </View>
        )}

        {status === 'pending' && (
          <View style={styles.cardActions}>
            <TouchableOpacity style={styles.cardActionPrimary} onPress={() => resumeFlow(c)}>
              <Ionicons name="albums-outline" size={15} color={colors.text} />
              <Text style={styles.cardActionPrimaryText}>{t('spotlight.chooseAPost')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.cardActionGhost} onPress={() => confirmCancelPending(c)}>
              <Text style={styles.cardActionGhostText}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>
        )}
        {status === 'active' && (
          <View style={styles.cardActions}>
            <TouchableOpacity style={styles.cardActionGhost} onPress={() => confirmEndEarly(c)}>
              <Text style={styles.cardActionGhostText}>{t('spotlight.endEarly')}</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  }

  const flowTitle = flowStep === 'package' ? t('spotlight.stepPackageTitle')
    : flowStep === 'pay' ? t('spotlight.stepPayTitle')
    : flowStep === 'grid' ? t('spotlight.stepGridTitle')
    : t('spotlight.stepChooseTitle');

  return (
    <SwipeBackPager>
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Spotlight</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          {/* hero-stage block */}
          <Skeleton width="100%" height={230} radius={RADIUS.xl} />
          {/* eyebrow + title + tagline lines */}
          <View style={{ alignItems: 'center', gap: SPACING.sm, marginTop: SPACING.xs }}>
            <SkeletonLine w={120} h={11} />
            <SkeletonLine w={200} h={20} />
            <SkeletonLine w="80%" h={13} />
            <SkeletonLine w="60%" h={13} />
          </View>
          {/* full-width gradient CTA button */}
          <Skeleton width="100%" height={52} radius={RADIUS.full} style={{ marginTop: SPACING.md }} />
        </ScrollView>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />
          }
        >
          {freeAvailable && (
            <TouchableOpacity style={styles.freeBanner} onPress={startFreeFlow} activeOpacity={0.85}>
              <View style={styles.freeIcon}><Ionicons name="gift" size={22} color="#fff" /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.freeTitle}>{t('spotlight.freeTitle')}</Text>
                <Text style={styles.freeSub}>{t('spotlight.freeSub')}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.primary} />
            </TouchableOpacity>
          )}
          {hasActive ? (
            // ── Active spotlight(s): the practical management screen ──────────────
            <>
              <Text style={styles.hint}>{t('spotlight.hint')}</Text>

              <TouchableOpacity style={styles.createBtn} onPress={startFlow} activeOpacity={0.85}>
                <LinearGradient colors={[colors.primary, colors.primaryDark ?? colors.primary]} style={styles.createBtnInner}>
                  <Ionicons name="sparkles" size={18} color="#FFFFFF" />
                  <Text style={styles.createBtnText}>{t('spotlight.createBtn')}</Text>
                </LinearGradient>
              </TouchableOpacity>

              <View style={styles.cards}>
                <Text style={styles.sectionTitle}>{t('spotlight.yourSpotlights')}</Text>
                {campaigns.map(renderCampaign)}
              </View>
            </>
          ) : (
            // ── Nothing live: the attractive "artwork under a spotlight" landing ──
            <>
              <View style={styles.hero}>
                <LinearGradient
                  colors={['#1C1206', '#0C0805']}
                  style={styles.heroStage}
                  start={{ x: 0.5, y: 0 }}
                  end={{ x: 0.5, y: 1 }}
                >
                  {/* the lamp */}
                  <View style={styles.heroLamp} />
                  {/* the cone of light spilling down from it */}
                  <View style={styles.heroBeam} />
                  {/* the glow pooling on the artwork */}
                  <View style={styles.heroPool} />
                  {/* the lit artwork */}
                  <View style={styles.heroArtwork}>
                    <Ionicons name="image" size={36} color={colors.primary} />
                  </View>
                </LinearGradient>

                <Text style={styles.heroEyebrow}>{t('spotlight.heroEyebrow')}</Text>
                <Text style={styles.heroTitle}>{t('spotlight.heroTitle')}</Text>
                <Text style={styles.heroTagline}>{t('spotlight.heroTagline')}</Text>

                <TouchableOpacity style={styles.heroCreateBtn} onPress={startFlow} activeOpacity={0.85}>
                  <LinearGradient
                    colors={[colors.primary, colors.primaryDark ?? colors.primary]}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0 }}
                    style={styles.heroCreateInner}
                  >
                    <Ionicons name="sparkles" size={18} color="#fff" />
                    <Text style={styles.heroCreateText}>{t('spotlight.heroCreate')}</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </View>

              {/* Pending / ended campaigns still surface below so nothing is lost. */}
              {campaigns.length > 0 && (
                <View style={styles.cards}>
                  <Text style={styles.sectionTitle}>{t('spotlight.yourSpotlights')}</Text>
                  {campaigns.map(renderCampaign)}
                </View>
              )}
            </>
          )}
        </ScrollView>
      )}

      {/* Create / resume flow */}
      <Modal visible={flowOpen} animationType="slide" onRequestClose={() => setFlowOpen(false)}>
        <View style={styles.flowContainer}>
          <View style={styles.flowHeader}>
            <TouchableOpacity
              style={styles.backBtn}
              onPress={() => {
                if (flowStep === 'pay') setFlowStep('package');
                else if (flowStep === 'grid' && !freeFlow) setFlowStep('choose');
                else setFlowOpen(false);
              }}
            >
              <Ionicons name={flowStep === 'pay' || flowStep === 'grid' ? 'chevron-back' : 'close'} size={24} color={colors.text} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>{flowTitle}</Text>
            <View style={{ width: 40 }} />
          </View>

          {flowStep === 'package' && (
            <ScrollView contentContainerStyle={styles.flowScroll}>
              <Text style={styles.flowLead}>
                {t('spotlight.packageLead')}
              </Text>
              {SPOTLIGHT_PACKAGES.map(p => {
                const on = pkg?.key === p.key;
                return (
                  <TouchableOpacity
                    key={p.key}
                    style={[styles.pkgCard, on && styles.pkgCardActive]}
                    onPress={() => setPkg(p)}
                    activeOpacity={0.8}
                  >
                    <View style={styles.pkgTop}>
                      <Text style={[styles.pkgLabel, on && { color: colors.primary }]}>{p.label}</Text>
                      <Text style={[styles.pkgPrice, on && { color: colors.primary }]}>{fmtPrice(p.priceCents)}</Text>
                    </View>
                    <Text style={styles.pkgBlurb}>{p.blurb}</Text>
                    <View style={styles.pkgMetaRow}>
                      <Ionicons name="trending-up-outline" size={13} color={colors.textTertiary} />
                      <Text style={styles.pkgMeta}>{t('spotlight.pkgPlacement', { hours: rampHoursFor(p.weight) })}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
              <TouchableOpacity
                style={[styles.primaryBtn, !pkg && styles.primaryBtnDisabled]}
                disabled={!pkg}
                onPress={() => setFlowStep('pay')}
              >
                <Text style={styles.primaryBtnText}>{t('spotlight.continue')}</Text>
              </TouchableOpacity>
            </ScrollView>
          )}

          {flowStep === 'pay' && pkg && (
            <ScrollView contentContainerStyle={styles.flowScroll}>
              <View style={styles.summaryCard}>
                <Text style={styles.summaryTitle}>{t('spotlight.orderSummary')}</Text>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryKey}>{t('spotlight.summaryPackage')}</Text>
                  <Text style={styles.summaryVal}>{t('spotlight.summaryPackageVal', { label: pkg.label })}</Text>
                </View>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryKey}>{t('spotlight.summaryPlacement')}</Text>
                  <Text style={styles.summaryVal}>{t('spotlight.summaryPlacementVal', { hours: rampHoursFor(pkg.weight) })}</Text>
                </View>
                <View style={styles.summaryDivider} />
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryTotalKey}>{t('spotlight.summaryTotal')}</Text>
                  <Text style={styles.summaryTotalVal}>{fmtPrice(pkg.priceCents)}</Text>
                </View>
              </View>
              <Text style={styles.simNote}>
                {t('spotlight.simCheckout')}
              </Text>
              <TouchableOpacity style={styles.primaryBtn} onPress={handlePay} disabled={paying}>
                {paying
                  ? <ActivityIndicator color={colors.text} size="small" />
                  : <Text style={styles.primaryBtnText}>{t('spotlight.payAmount', { price: fmtPrice(pkg.priceCents) })}</Text>}
              </TouchableOpacity>
            </ScrollView>
          )}

          {flowStep === 'choose' && (
            <ScrollView contentContainerStyle={styles.flowScroll}>
              <Text style={styles.flowLead}>
                {t('spotlight.chooseLead')}
              </Text>
              <TouchableOpacity style={styles.chooseCard} onPress={openPostGrid} activeOpacity={0.8}>
                <View style={styles.chooseIcon}><Ionicons name="albums-outline" size={24} color={colors.primary} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.chooseTitle}>{t('spotlight.chooseExistingTitle')}</Text>
                  <Text style={styles.chooseSub}>{t('spotlight.chooseExistingSub')}</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.chooseCard} onPress={handleNewPost} activeOpacity={0.8}>
                <View style={styles.chooseIcon}><Ionicons name="add-circle-outline" size={24} color={colors.primary} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.chooseTitle}>{t('spotlight.chooseNewTitle')}</Text>
                  <Text style={styles.chooseSub}>{t('spotlight.chooseNewSub')}</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
              </TouchableOpacity>
              <Text style={styles.simNote}>
                {t('spotlight.chooseNote')}
              </Text>
            </ScrollView>
          )}

          {flowStep === 'grid' && (
            postsLoading ? (
              <View style={styles.gridScroll}>
                <SkeletonLine w="70%" h={12} style={{ marginHorizontal: SPACING.md, marginBottom: SPACING.sm }} />
                <GridSkeleton columns={3} count={12} gap={1} padding={0} />
              </View>
            ) : myPosts.length === 0 ? (
              <View style={styles.empty}>
                <Ionicons name="images-outline" size={44} color={colors.textTertiary} />
                <Text style={styles.emptyTitle}>{t('spotlight.gridEmptyTitle')}</Text>
                <Text style={styles.emptySub}>
                  {t('spotlight.gridEmptySub')}
                </Text>
              </View>
            ) : (
              <ScrollView contentContainerStyle={styles.gridScroll}>
                <Text style={[styles.hint, { paddingHorizontal: SPACING.md }]}>{t('spotlight.gridHint')}</Text>
                <View style={styles.grid}>
                  {myPosts.map(post => {
                    const { uri, video } = thumbFor(post);
                    return (
                      <TouchableOpacity key={post.id} style={styles.cell} onPress={() => handlePickPost(post)} activeOpacity={0.85}>
                        {video && !uri ? (
                          <VideoThumb thumbnailUrl={post.thumbnail_url} mediaUrl={post.media_url} style={styles.cellMedia} />
                        ) : uri ? (
                          <Image source={{ uri }} style={styles.cellMedia} resizeMode="cover" />
                        ) : (
                          <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.cellPlaceholder}>
                            <Ionicons name={isAudioPost(post.type) ? 'musical-notes' : 'videocam'} size={26} color={colors.primary} />
                          </LinearGradient>
                        )}
                        {attachingId === post.id && (
                          <View style={styles.cellBusy}><ActivityIndicator color={colors.text} size="small" /></View>
                        )}
                        <View style={styles.typeBadge}>
                          <Ionicons
                            name={post.type === 'slideshow' ? 'copy' : post.type === 'video' ? 'videocam' : isAudioPost(post.type) ? 'musical-notes' : 'image'}
                            size={11} color={colors.text}
                          />
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </ScrollView>
            )
          )}

          {/* Themed spotlight-this-post confirmation (inside the flow modal so
              it stacks above the grid). */}
          <ConfirmDialog
            visible={!!pickTarget}
            title={t('spotlight.confirmPickTitle')}
            message={pkg ? t('spotlight.confirmPickBody', { label: pkg.label }) : ''}
            confirmLabel={t('spotlight.confirmPickAction')}
            cancelLabel={t('common.cancel')}
            icon="sparkles"
            onConfirm={confirmPick}
            onCancel={() => setPickTarget(null)}
          />
        </View>
      </Modal>

      {/* Themed campaign-card confirmations (screen level). */}
      <ConfirmDialog
        visible={!!cancelTarget}
        title={t('spotlight.cancelTitle')}
        message={t('spotlight.cancelBody')}
        confirmLabel={t('spotlight.cancelAction')}
        cancelLabel={t('spotlight.keepIt')}
        destructive
        onConfirm={doCancelPending}
        onCancel={() => setCancelTarget(null)}
      />
      <ConfirmDialog
        visible={!!endTarget}
        title={t('spotlight.endTitle')}
        message={t('spotlight.endBody')}
        confirmLabel={t('spotlight.endAction')}
        cancelLabel={t('spotlight.keepRunning')}
        destructive
        onConfirm={doEndEarly}
        onCancel={() => setEndTarget(null)}
      />

      {/* The celebratory "you're live" moment — replaces the stock alert. */}
      <SpotlightLiveDialog
        visible={!!liveDuration}
        duration={liveDuration ?? ''}
        onClose={() => setLiveDuration(null)}
      />
    </View>
    </SwipeBackPager>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm,
    paddingTop: SPACING.xxl + SPACING.sm,
    paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.borderSubtle,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },

  scroll: { padding: SPACING.md, paddingBottom: SPACING.xxl, gap: SPACING.md },
  hint: { color: colors.textSecondary, fontSize: 12, lineHeight: 18 },

  // Premium free-monthly-Spotlight banner.
  freeBanner: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    backgroundColor: colors.primary + '14', borderRadius: RADIUS.lg,
    borderWidth: 1.5, borderColor: colors.primary, padding: SPACING.md,
  },
  freeIcon: {
    width: 44, height: 44, borderRadius: RADIUS.full, backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  freeTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
  freeSub: { color: colors.textSecondary, fontSize: 12, marginTop: 1, lineHeight: 16 },

  // Attractive landing (no live spotlight)
  hero: { alignItems: 'center', gap: SPACING.xs },
  heroStage: {
    width: '100%', height: 230, borderRadius: RADIUS.xl, overflow: 'hidden',
    alignItems: 'center', marginBottom: SPACING.md,
    borderWidth: 1, borderColor: colors.border,
  },
  heroLamp: {
    width: 30, height: 9, borderRadius: 5, marginTop: SPACING.md,
    backgroundColor: colors.primaryLight,
    shadowColor: colors.primary, shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9, shadowRadius: 12, elevation: 8,
  },
  // The cone of light: an upward-apex triangle spreading down from the lamp.
  heroBeam: {
    position: 'absolute', top: SPACING.md + 9,
    width: 0, height: 0,
    borderLeftWidth: 80, borderRightWidth: 80, borderBottomWidth: 150,
    borderLeftColor: 'transparent', borderRightColor: 'transparent',
    borderBottomColor: 'rgba(242,101,34,0.14)',
  },
  // Soft pool of light gathered on the artwork.
  heroPool: {
    position: 'absolute', bottom: 30,
    width: 150, height: 80, borderRadius: 75,
    backgroundColor: 'rgba(250,181,37,0.10)',
  },
  heroArtwork: {
    position: 'absolute', bottom: 36,
    width: 74, height: 74, borderRadius: RADIUS.md,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1, borderColor: 'rgba(242,101,34,0.45)',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: colors.primary, shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6, shadowRadius: 16, elevation: 8,
  },
  heroEyebrow: {
    color: colors.primary, fontSize: 12, fontWeight: '800',
    letterSpacing: 2, marginTop: SPACING.xs,
  },
  heroTitle: { color: colors.text, fontSize: 24, fontWeight: '900', textAlign: 'center', marginTop: 2 },
  heroTagline: {
    color: colors.textSecondary, fontSize: 14, lineHeight: 20,
    textAlign: 'center', paddingHorizontal: SPACING.md, marginTop: SPACING.xs,
  },
  heroCreateBtn: {
    borderRadius: RADIUS.full, overflow: 'hidden', marginTop: SPACING.lg, alignSelf: 'stretch',
    ...SHADOWS.glow,
  },
  heroCreateInner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm,
    paddingVertical: SPACING.md + 2,
  },
  heroCreateText: { color: '#fff', fontSize: 16, fontWeight: '800' },

  createBtn: { borderRadius: RADIUS.lg, overflow: 'hidden' },
  createBtnInner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm,
    paddingVertical: SPACING.md,
  },
  createBtnText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },

  sectionTitle: {
    color: colors.textTertiary, fontSize: 11, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.8, paddingHorizontal: SPACING.xs,
  },
  cards: { gap: SPACING.sm },
  card: {
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: SPACING.md, gap: SPACING.sm,
  },
  cardTop: { flexDirection: 'row', gap: SPACING.sm, alignItems: 'center' },
  cardThumb: { width: 54, height: 54, borderRadius: RADIUS.sm, backgroundColor: colors.surfaceElevated },
  cardThumbPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  cardInfo: { flex: 1, gap: 2 },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.sm },
  cardTitle: { color: colors.text, fontSize: 14, fontWeight: '700', flexShrink: 1 },
  statusChip: {
    borderWidth: 1, borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.sm, paddingVertical: 2,
  },
  statusChipText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.3 },
  cardCaption: { color: colors.textSecondary, fontSize: 12 },
  cardMeta: { color: colors.textTertiary, fontSize: 11 },

  statsRow: {
    flexDirection: 'row', gap: SPACING.lg,
    borderTopWidth: 0.5, borderTopColor: colors.border, paddingTop: SPACING.sm,
  },
  stat: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  statText: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },

  cardActions: { flexDirection: 'row', gap: SPACING.sm },
  cardActionPrimary: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: colors.primary, borderRadius: RADIUS.full,
    paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md, flex: 1,
  },
  cardActionPrimaryText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  cardActionGhost: {
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.border, borderRadius: RADIUS.full,
    paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md,
  },
  cardActionGhostText: { color: colors.textSecondary, fontSize: 13, fontWeight: '700' },

  empty: { alignItems: 'center', paddingTop: SPACING.xxl, gap: SPACING.sm, paddingHorizontal: SPACING.lg },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  emptySub: { color: colors.textSecondary, fontSize: 13, textAlign: 'center' },

  // Flow modal
  flowContainer: { flex: 1, backgroundColor: colors.background },
  flowHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm,
    paddingTop: SPACING.xxl + SPACING.sm,
    paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.borderSubtle,
  },
  flowScroll: { padding: SPACING.md, gap: SPACING.md, paddingBottom: SPACING.xxl },
  flowLead: { color: colors.textSecondary, fontSize: 13, lineHeight: 19 },

  pkgCard: {
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.lg,
    borderWidth: 1.5, borderColor: colors.border,
    padding: SPACING.md, gap: 6,
  },
  pkgCardActive: { borderColor: colors.primary, backgroundColor: colors.primary + '11' },
  pkgTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pkgLabel: { color: colors.text, fontSize: 16, fontWeight: '800' },
  pkgPrice: { color: colors.text, fontSize: 16, fontWeight: '800' },
  pkgBlurb: { color: colors.textSecondary, fontSize: 12, lineHeight: 17 },
  pkgMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pkgMeta: { color: colors.textTertiary, fontSize: 11, fontWeight: '600' },

  primaryBtn: {
    backgroundColor: colors.primary, borderRadius: RADIUS.full,
    alignItems: 'center', justifyContent: 'center',
    paddingVertical: SPACING.md, marginTop: SPACING.sm,
  },
  primaryBtnDisabled: { opacity: 0.4 },
  primaryBtnText: { color: colors.text, fontSize: 15, fontWeight: '800' },

  summaryCard: {
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: SPACING.md, gap: SPACING.sm,
  },
  summaryTitle: { color: colors.text, fontSize: 14, fontWeight: '800', marginBottom: 2 },
  summaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  summaryKey: { color: colors.textSecondary, fontSize: 13 },
  summaryVal: { color: colors.text, fontSize: 13, fontWeight: '600' },
  summaryDivider: { height: 0.5, backgroundColor: colors.border },
  summaryTotalKey: { color: colors.text, fontSize: 14, fontWeight: '800' },
  summaryTotalVal: { color: colors.primary, fontSize: 16, fontWeight: '800' },
  simNote: { color: colors.textTertiary, fontSize: 11, lineHeight: 16, textAlign: 'center' },

  chooseCard: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: colors.border, padding: SPACING.md,
  },
  chooseIcon: {
    width: 46, height: 46, borderRadius: RADIUS.full,
    backgroundColor: colors.primary + '18',
    alignItems: 'center', justifyContent: 'center',
  },
  chooseTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  chooseSub: { color: colors.textSecondary, fontSize: 12, marginTop: 1 },

  // Post grid
  gridScroll: { paddingTop: SPACING.sm, paddingBottom: SPACING.xxl },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingTop: SPACING.sm },
  cell: { width: '33.33%', aspectRatio: 1, position: 'relative', padding: 1 },
  cellMedia: { width: '100%', height: '100%' },
  cellPlaceholder: {
    width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center',
    borderWidth: 0.5, borderColor: colors.border,
  },
  cellBusy: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center',
  },
  typeBadge: {
    position: 'absolute', top: 6, right: 6,
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center',
  },
});
