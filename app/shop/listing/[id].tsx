import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Image, ScrollView, ActivityIndicator, Linking, RefreshControl, Share,
  Modal, TextInput, KeyboardAvoidingView, Platform, Pressable,
} from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import SwipeBackPager from '../../../components/SwipeBackPager';
import ConfirmDialog from '../../../components/ConfirmDialog';
import { DetailSkeleton } from '../../../components/Skeleton';
import { GRADIENTS, RADIUS, SPACING, type ThemePalette } from '../../../constants/theme';
import { useTheme, useThemedStyles } from '../../../contexts/ThemeContext';
import { useTranslation } from '../../../contexts/LanguageContext';
import { useProfile } from '../../../contexts/ProfileContext';
import { useFollow } from '../../../contexts/FollowContext';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { reactionPop, notifySuccess } from '../../../lib/haptics';
import { usePostMusicActions, useSongHostActive } from '../../../contexts/PostMusicContext';
import { WEB_ORIGIN } from '../../../lib/appLinks';
import { reportListing } from '../../../lib/postActions';
import {
  checkFreeConditions, fetchListing, formatPrice, getDeliverableUrl, hasDeliveredSales,
  logDeliverableDownload,
  freeHasConditions, legacyKindOf, listingPriceLabel, myOrdersForListing, priceForKind, refundAndRemoveListing,
  requestToBuy, saleTypes, setOrderStatus, updateListing,
  type FreeConditionState, type SaleKind, type ShopListing, type ShopOrder,
} from '../../../lib/shop';
import { addToCart, removeFromCart, useInCart, useShopCart } from '../../../lib/shopCart';

const PREVIEW_HOST = 'shop-preview';

// Listing detail — the marketplace "product page": cover, tap-to-play preview,
// seller row, and a CTA PER DEAL TYPE (a listing can offer any mix):
//   Sell  → "Buy · $X"        (exclusive buy-out — delivering it ends the listing)
//   Lease → "Lease · $Y"      (non-exclusive copy, keeps selling)
//   Free  → "Free (Claim now)" (may be gated on following the seller and/or
//                               liking posts; a valid claim delivers instantly)
// Lease-ONLY listings also get "Make an offer" — name a buy-out price the
// seller can accept. Owners see Edit · Pause · Remove; removal of a listing
// with purchases becomes "Refund buyers & remove".

export default function ListingScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile } = useProfile();
  const { following, toggleFollow } = useFollow();
  const { playSong, stop: stopSong } = usePostMusicActions();
  // Derived from the shared player, so the icon always matches what's audible —
  // per-host subscription re-renders this screen only when ITS preview flips.
  const previewing = useSongHostActive(PREVIEW_HOST);
  const { count: cartCount } = useShopCart();
  const inCart = useInCart(id);

  const [listing, setListing] = useState<ShopListing | null>(null);
  const [orders, setOrders] = useState<ShopOrder[]>([]);
  const [conds, setConds] = useState<FreeConditionState | null>(null);
  const [hasSales, setHasSales] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyKind, setBusyKind] = useState<SaleKind | 'download' | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Offer sheet (lease-only listings).
  const [offerOpen, setOfferOpen] = useState(false);
  const [offerText, setOfferText] = useState('');
  // One-time marketplace safety primer, shown before the FIRST buy request on
  // this device (payments happen off-platform, so buyers must know the rules).
  const [safetyOpen, setSafetyOpen] = useState(false);
  const pendingBuyRef = useRef<{ kind: SaleKind; offerCents: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which CTA's caption is expanded. One at a time: two open explainers push
  // the buttons apart and turn a decision into a wall of text.
  const [expanded, setExpanded] = useState<'sell' | 'lease' | null>(null);
  // The gated free-claim sheet. Owned by this screen rather than being its own
  // route — see the note on the Free button.
  const [freeOpen, setFreeOpen] = useState(false);
  // Set when a condition row sends the user away, so returning re-opens the
  // sheet instead of stranding them on the listing. A ref, not state: it must
  // survive the navigation without causing a render of its own.
  const reopenFreeRef = useRef(false);

  const isOwner = !!listing && listing.user_id === profile?.id;

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [l, os] = await Promise.all([fetchListing(id), myOrdersForListing(id)]);
      setListing(l);
      setOrders(os);
      if (l) {
        const types = saleTypes(l);
        if (types.free && l.user_id !== profile?.id) {
          checkFreeConditions(l).then(setConds).catch(() => {});
        }
        if (l.user_id === profile?.id) {
          hasDeliveredSales(l.id).then(setHasSales).catch(() => {});
        }
      }
    } catch { /* pre-migration */ }
    setLoading(false);
  }, [id, profile?.id]);
  useEffect(() => { load(); }, [load]);
  // Opening the sheet re-reads the conditions: a post liked on another screen
  // would otherwise still show unticked until the listing itself refocused.
  useEffect(() => {
    if (freeOpen && listing) checkFreeConditions(listing).then(setConds).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freeOpen]);
  // Coming back from a post (liking it for a free claim) or a profile → the
  // unlock checklist re-verifies itself, and the sheet REOPENS if that is where
  // the user came from. Leaving them on the listing would make finishing a
  // three-post checklist a matter of re-opening the sheet after every single
  // one, when the sheet is the whole reason they left.
  //
  // The reopen is deferred rather than immediate: SwipeBackPager runs a ~280ms
  // return animation, and presenting a modal into the middle of that is exactly
  // the kind of two-animations-at-once problem this screen has already had.
  useFocusEffect(useCallback(() => {
    if (listing && saleTypes(listing).free && !isOwner) {
      checkFreeConditions(listing).then(setConds).catch(() => {});
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (reopenFreeRef.current) {
      reopenFreeRef.current = false;
      timer = setTimeout(() => setFreeOpen(true), 320);
    }
    return () => { if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listing?.id, following]));
  // Stop the preview on unmount ONLY. stopSong's identity changes on every
  // context re-render, so listing it as a dep re-ran this cleanup right after
  // playSong updated the context — killing the preview the instant it started.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => { stopSong(PREVIEW_HOST); }, []);

  function togglePreview() {
    if (!listing?.preview_url) return;
    if (previewing) stopSong(PREVIEW_HOST);
    else playSong(PREVIEW_HOST, listing.id, listing.preview_url);
  }

  const SAFETY_ACK_KEY = 'shop_safety_ack_v1';

  // The buyer's standing order for one deal type (legacy orders map through
  // the listing's old single license).
  function orderFor(kind: SaleKind): ShopOrder | null {
    if (!listing) return null;
    return orders.find((o) => (o.kind ?? legacyKindOf(listing)) === kind
      && (o.status === 'requested' || o.status === 'delivered')) ?? null;
  }
  const deliveredOrder = orders.find((o) => o.status === 'delivered') ?? null;

  // Claim from the free sheet. Kept apart from buy() so the sheet closes only
  // when the claim actually lands: buy() signals failure through `error`
  // state, which cannot be read back synchronously at the call site.
  async function claimFree() {
    if (!listing || busyKind) return;
    setError(null);
    if (!readyToClaim) { setError(t('shop.freeCondUnmetErr')); return; }
    setBusyKind('free');
    try {
      const o = await requestToBuy(listing, '', 'free', 0);
      setOrders((prev) => [o, ...prev]);
      notifySuccess();
      setFreeOpen(false);
    } catch {
      // A refusal means our view of the conditions was stale — re-read it so
      // the checklist tells the truth rather than staying green.
      setError(t('shop.freeCondUnmetErr'));
      checkFreeConditions(listing).then(setConds).catch(() => {});
    }
    setBusyKind(null);
  }

  async function buy(kind: SaleKind, offerCents = 0) {
    if (!listing || busyKind) return;
    setError(null);
    // Free claims aren't payments — no primer; instead the unlock conditions
    // must be met (client check for UX; the server re-verifies).
    //
    // Only GATED listings are checked. readyToClaim requires `conds` to have
    // loaded, and an ungated listing reaches this path straight from the Free
    // button — gating it on a fetch that may not have returned yet would refuse
    // a download that has no conditions to fail.
    if (kind === 'free') {
      if (freeHasConditions(listing) && !readyToClaim) { setError(t('shop.freeCondUnmetErr')); return; }
    } else {
      const acked = await AsyncStorage.getItem(SAFETY_ACK_KEY).catch(() => null);
      if (!acked) {
        pendingBuyRef.current = { kind, offerCents };
        setSafetyOpen(true);
        return;
      }
    }
    setBusyKind(kind);
    try {
      const o = await requestToBuy(listing, '', kind, offerCents);
      setOrders((prev) => [o, ...prev]);
      // Paid sell/lease now DELIVERS on the spot — the credits have already
      // moved, so the file is unlocked before this line runs. Only offers are
      // still a request, because they need the seller to agree a price.
      if (o.status === 'delivered') notifySuccess();
      else reactionPop();
      if (kind === 'offer') { setOfferOpen(false); setOfferText(''); }
    } catch (e) {
      const msg = (e as Error)?.message ?? '';
      if (msg.includes('rate_limited')) setError(t('shop.rateLimited'));
      else if (msg.includes('free_follow_required') || msg.includes('free_likes_required')) {
        setError(t('shop.freeCondUnmetErr'));
        checkFreeConditions(listing).then(setConds).catch(() => {});
      } else if (msg.includes('insufficient funds')) {
        // Send them where the problem is solvable instead of showing an error
        // they can't act on. Same routing the tip flow uses.
        setError(t('shop.needCredits'));
        router.push('/credits');
      } else if (msg.includes('cannot_buy_own')) setError(t('shop.cannotBuyOwn'));
      else await load(); // unique violation / kind gone → resync
    }
    setBusyKind(null);
  }

  async function ackSafetyAndBuy() {
    setSafetyOpen(false);
    // Persist the ack BEFORE re-entering buy(), which re-reads it.
    await AsyncStorage.setItem(SAFETY_ACK_KEY, '1').catch(() => {});
    const pending = pendingBuyRef.current;
    pendingBuyRef.current = null;
    if (pending) buy(pending.kind, pending.offerCents);
  }

  async function cancelRequest(order: ShopOrder) {
    if (busyKind) return;
    setOrders((prev) => prev.map((o) => (o.id === order.id ? { ...o, status: 'cancelled' } : o)));
    await setOrderStatus(order.id, 'cancelled').catch(() => load());
  }

  async function download() {
    if (!listing?.file_path || busyKind) return;
    setBusyKind('download');
    try {
      const url = await getDeliverableUrl(listing.file_path);
      // Log BEFORE opening: this row is the dispute evidence that the buyer took
      // delivery, and it must not depend on the handoff to the browser succeeding.
      logDeliverableDownload(deliveredOrder?.id, listing.file_path);
      Linking.openURL(url).catch(() => {});
    } catch { /* not delivered / revoked */ }
    setBusyKind(null);
  }

  async function setStatus(status: 'active' | 'paused') {
    if (!listing) return;
    setListing({ ...listing, status });
    await updateListing(listing.id, { status }).catch(() => load());
  }

  // Takedown: purchase-free listings remove directly; purchased ones can ONLY
  // go down through the refund path (the server enforces this either way).
  async function removeListing() {
    if (!listing) return;
    setConfirmRemove(false);
    if (hasSales) {
      const ok = await refundAndRemoveListing(listing.id);
      if (!ok) { setError(t('shop.error')); return; }
      router.back();
    } else {
      setListing({ ...listing, status: 'removed' });
      try {
        await updateListing(listing.id, { status: 'removed' });
        router.back();
      } catch {
        // Raced a first sale → the guard refused. Reload and show the note.
        await load();
        setError(t('shop.hasPurchasesNote'));
      }
    }
  }

  const sellerName = listing?.seller?.display_name || listing?.seller?.username || '';

  // ── Live unlock progress ─────────────────────────────────────────────────
  // The follow condition is answered from the FollowContext, not from the
  // fetched `conds` snapshot. Two reasons, and the second is the point of the
  // feature: following updates the context optimistically, so the row ticks
  // the instant it is tapped instead of after a round trip — and UNfollowing
  // un-ticks it just as fast. Progress here is a live reading, never a
  // high-water mark; it only becomes permanent once the claim is delivered,
  // which is an order, not a checkbox.
  const needFollow = !!listing?.free_requires_follow;
  const followOk = !needFollow || (!!listing && following.has(listing.user_id));
  // Likes still come from the snapshot — whether a post is liked is not in any
  // context here — so they refresh when the sheet opens and on screen focus.
  const likesOk = (conds?.likes ?? []).every((l) => l.met);
  const readyToClaim = !!conds && followOk && likesOk;
  const types = listing ? saleTypes(listing) : { sell: false, lease: false, free: false };
  const offerable = !!listing && types.lease && !types.sell && listing.status === 'active';
  // Lease-ONLY (nothing to buy, nothing free) makes the offer the only route
  // to owning it, so it stops being a quiet secondary button and goes green
  // like the other primary CTAs.
  const offerPrimary = offerable && !types.free;
  const offerCents = Math.round((parseFloat(offerText.replace(',', '.')) || 0) * 100);
  const enabledLabels = [
    types.sell && t('shop.license.exclusive'),
    types.lease && t('shop.license.nonexclusive'),
    types.free && t('shop.license.free'),
  ].filter(Boolean).join(' · ');

  // One CTA button per deal type; each has its own pending/owned state.
  function renderKindCta(kind: 'sell' | 'lease' | 'free') {
    if (!listing) return null;
    const order = orderFor(kind);
    if (order?.status === 'delivered') return null; // covered by Download above
    if (order?.status === 'requested') {
      const label = kind === 'sell'
        ? t('shop.requested')
        : `${t(`shop.kind.${kind}`)} — ${t('shop.requested')}`;
      return (
        <TouchableOpacity key={kind} style={styles.pendingBtn} onPress={() => cancelRequest(order)} disabled={!!busyKind}>
          <Ionicons name="time-outline" size={17} color={colors.textSecondary} />
          <Text style={styles.pendingBtnText}>{label}</Text>
        </TouchableOpacity>
      );
    }
    // Each button carries a one-line caption saying what that deal actually
    // grants. It matters most on a listing offering several at once, where
    // "Buy $40 / Lease $15 / Free" alone doesn't say what separates them.
    //
    // A GATED free listing gets no caption: tapping it opens a screen that
    // states the conditions in full, so a one-liner here would only preview it
    // in vaguer words. Read from the LISTING rather than from `conds`, which
    // arrives over the network and is null on first paint — keying off it would
    // flash "Anyone can download" onto a gated listing before correcting itself.
    const gatedFree = kind === 'free' && freeHasConditions(listing);
    const caption =
      kind === 'sell' ? t('shop.cta.sellDesc')
        : kind === 'lease' ? t('shop.cta.leaseDesc')
          : gatedFree ? null : t('shop.cta.freeDesc');
    // The long-form explainer, revealed by tapping the caption.
    const longDesc = kind === 'sell' ? t('shop.licenseInfo.exclusive')
      : kind === 'lease' ? t('shop.licenseInfo.nonexclusive') : null;

    if (kind === 'free') {
      return (
        <View key="free" style={styles.ctaBlock}>
          <TouchableOpacity
            // Always full green. It used to dim while conditions were unmet,
            // which read as "disabled" on the one button that is always
            // tappable — it opens the sheet where the conditions get done. The
            // locked look belongs on the claim button inside, which really is
            // blocked.
            style={[styles.greenBtn, styles.freeBtn]}
            // Gated claims open a full-screen sheet rather than a checklist
            // wedged under the button: the conditions are a task list and
            // deserve the room to be read and acted on.
            //
            // A SHEET, not a route. This was briefly its own screen, which meant
            // registering it in app/_layout's transparentModal list — miss that
            // and the pager's animation fights the stack's. A Modal owned by
            // this screen cannot be mis-registered, and reads the same to the
            // user.
            onPress={() => (gatedFree ? setFreeOpen(true) : buy('free'))}
            disabled={!!busyKind}
            activeOpacity={0.85}
          >
            {busyKind === 'free' ? <ActivityIndicator color="#fff" /> : (
              <View style={styles.freeBtnInner}>
                <Text style={styles.greenBtnText}>{t('shop.freeWord')}</Text>
                <Text style={styles.claimNowText}>{t('shop.claimNow')}</Text>
              </View>
            )}
          </TouchableOpacity>
          {!!caption && <Text style={styles.ctaDesc}>{caption}</Text>}
        </View>
      );
    }
    const price = formatPrice(priceForKind(listing, kind), listing.currency);
    const open = expanded === kind;
    return (
      <View key={kind} style={styles.ctaBlock}>
        <TouchableOpacity
          style={[styles.greenBtn, kind === 'lease' && styles.leaseBtn]}
          onPress={() => buy(kind)}
          disabled={!!busyKind}
          activeOpacity={0.85}
        >
          {busyKind === kind ? <ActivityIndicator color="#fff" /> : (
            <>
              <Ionicons name={kind === 'sell' ? 'flash' : 'repeat'} size={18} color="#fff" />
              <Text style={styles.greenBtnText}>
                {kind === 'sell' ? t('shop.buyFor', { price }) : t('shop.leaseFor', { price })}
              </Text>
            </>
          )}
        </TouchableOpacity>
        {!!caption && (
          <TouchableOpacity
            onPress={() => setExpanded(open ? null : kind)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={t('shop.ctaMore')}
            accessibilityState={{ expanded: open }}
          >
            <View style={styles.ctaDescRow}>
              <Text style={styles.ctaDesc}>{caption}</Text>
              <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={12} color={colors.textTertiary} />
            </View>
            {open && !!longDesc && <Text style={styles.ctaLong}>{longDesc}</Text>}
          </TouchableOpacity>
        )}
      </View>
    );
  }

  return (
    <SwipeBackPager>
      <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
        <View style={styles.header}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} onPress={() => router.back()} style={styles.headerBtn}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle} numberOfLines={1}>{listing?.title ?? t('shop.title')}</Text>
          <View style={styles.headerRight}>
            <TouchableOpacity style={styles.headerBtn} onPress={() => router.push('/shop/cart')} accessibilityLabel={t('shop.cart.title')}>
              <Ionicons name="cart-outline" size={22} color={colors.text} />
              {cartCount > 0 && (
                <View style={styles.cartBadge}>
                  <Text style={styles.cartBadgeText}>{cartCount > 9 ? '9+' : cartCount}</Text>
                </View>
              )}
            </TouchableOpacity>
            {listing && (
              <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.share')}
                style={styles.headerBtn}
                onPress={() =>
                  Share.share({
                    message: `${t('shop.shareMsg', {
                      title: listing.title,
                      price: listingPriceLabel(listing, t('shop.free')),
                    })}\n${WEB_ORIGIN}/open.html?p=shop/listing/${listing.id}`,
                  }).catch(() => {})
                }
              >
                <Ionicons name="share-outline" size={21} color={colors.text} />
              </TouchableOpacity>
            )}
          </View>
        </View>

        {loading || !listing ? (
          loading ? <DetailSkeleton /> : (
            <View style={styles.gone}>
              <Ionicons name="bag-remove-outline" size={40} color={colors.textTertiary} />
              <Text style={styles.goneText}>{t('shop.listingGone')}</Text>
            </View>
          )
        ) : (
          <ScrollView
            contentContainerStyle={styles.content}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                tintColor={colors.textSecondary}
                onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
              />
            }
          >
            {/* Cover + preview play */}
            <TouchableOpacity activeOpacity={listing.preview_url ? 0.85 : 1} onPress={togglePreview}>
              <View style={styles.coverWrap}>
                {listing.cover_url ? (
                  <Image source={{ uri: listing.cover_url }} style={styles.cover} />
                ) : (
                  <LinearGradient colors={GRADIENTS.primary} style={styles.cover} />
                )}
                {listing.preview_url && (
                  <View style={styles.playScrim}>
                    <Ionicons name={previewing ? 'pause-circle' : 'play-circle'} size={64} color="rgba(255,255,255,0.92)" />
                    <Text style={styles.previewLabel}>{t('shop.preview')}</Text>
                  </View>
                )}
              </View>
            </TouchableOpacity>

            {/* Price + title + meta */}
            <View style={styles.titleRow}>
              <View style={styles.flex}>
                <Text style={styles.title}>{listing.title}</Text>
                <Text style={styles.meta}>
                  {t(`shop.category.${listing.category}`)}
                  {listing.genre ? ` · ${listing.genre}` : ''}
                  {enabledLabels ? ` · ${enabledLabels}` : ''}
                </Text>
              </View>
              <View style={styles.pricePill}>
                <Text style={styles.priceText}>{listingPriceLabel(listing, t('shop.free'))}</Text>
              </View>
            </View>

            {listing.sales_count > 0 && (
              <Text style={styles.sales}>{t('shop.salesCount', { n: listing.sales_count })}</Text>
            )}
            {/* The plain-words explainer for each deal type used to sit here as
                a permanent block. It now lives inside the caption under its own
                button, revealed on tap — same words, attached to the thing they
                describe, and not three paragraphs between the price and the
                buy button. */}
            {!!listing.description && <Text style={styles.description}>{listing.description}</Text>}

            {/* Seller — the row is the shop entrance ("View shop" → their shop
                grid); ONLY the avatar circle opens the regular profile. */}
            <TouchableOpacity
              style={styles.sellerRow}
              onPress={() => router.push(`/shop/${listing.user_id}`)}
              activeOpacity={0.8}
            >
              <TouchableOpacity onPress={() => router.push(`/profile/${listing.user_id}`)} hitSlop={4}>
                {listing.seller?.avatar_url ? (
                  <Image source={{ uri: listing.seller.avatar_url }} style={styles.sellerAvatar} />
                ) : (
                  <LinearGradient colors={GRADIENTS.primary} style={styles.sellerAvatar}>
                    <Text style={styles.sellerInitial}>{(sellerName || '?').charAt(0).toUpperCase()}</Text>
                  </LinearGradient>
                )}
              </TouchableOpacity>
              <View style={styles.flex}>
                <Text style={styles.sellerName}>{sellerName}</Text>
                <Text style={styles.sellerSub}>{t('shop.viewShop')}</Text>
              </View>
              <Ionicons name="storefront-outline" size={18} color={colors.textTertiary} />
            </TouchableOpacity>

            {/* CTAs */}
            {isOwner ? (
              <>
                <View style={styles.ownerActions}>
                  <TouchableOpacity style={styles.ownerBtn} onPress={() => router.push(`/shop/new-listing?id=${listing.id}`)}>
                    <Ionicons name="create-outline" size={17} color={colors.text} />
                    <Text style={styles.ownerBtnText}>{t('shop.edit')}</Text>
                  </TouchableOpacity>
                  {listing.status !== 'sold' && (
                    <TouchableOpacity
                      style={styles.ownerBtn}
                      onPress={() => setStatus(listing.status === 'paused' ? 'active' : 'paused')}
                    >
                      <Ionicons name={listing.status === 'paused' ? 'play-outline' : 'pause-outline'} size={17} color={colors.text} />
                      <Text style={styles.ownerBtnText}>
                        {listing.status === 'paused' ? t('shop.activate') : t('shop.pause')}
                      </Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity style={styles.ownerBtn} onPress={() => setConfirmRemove(true)}>
                    <Ionicons name="trash-outline" size={17} color={colors.error} />
                    <Text style={[styles.ownerBtnText, { color: colors.error }]}>{t('shop.remove')}</Text>
                  </TouchableOpacity>
                </View>
                {hasSales && (
                  <View style={styles.protectedRow}>
                    <Ionicons name="lock-closed-outline" size={13} color={colors.textTertiary} />
                    <Text style={styles.protectedText}>{t('shop.hasPurchasesNote')}</Text>
                  </View>
                )}
                {!!error && <Text style={styles.errorText}>{error}</Text>}
              </>
            ) : (
              <View style={styles.buyerActions}>
                {/* A delivered order (any kind) = the file is yours. */}
                {deliveredOrder && (
                  <TouchableOpacity style={styles.greenBtn} onPress={download} disabled={!!busyKind} activeOpacity={0.85}>
                    {busyKind === 'download' ? <ActivityIndicator color="#fff" /> : (
                      <>
                        <Ionicons name="download-outline" size={18} color="#fff" />
                        <Text style={styles.greenBtnText}>{t('shop.download')}</Text>
                      </>
                    )}
                  </TouchableOpacity>
                )}

                {listing.status === 'active' ? (
                  <>
                    {/* One button per deal type the seller highlighted. */}
                    {types.sell && renderKindCta('sell')}
                    {types.lease && renderKindCta('lease')}
                    {types.free && renderKindCta('free')}

                    {/* The unlock checklist used to live inline here. It is now a
                        full-screen sheet opened by the Free button — a task list
                        needs room to be read and acted on, and half of those
                        tasks navigate away anyway. */}
                    {/* Lease-only: name your price for the beat itself. */}
                    {offerable && !orderFor('offer') && (
                      <TouchableOpacity
                        style={[styles.offerBtn, offerPrimary && styles.offerBtnPrimary]}
                        onPress={() => setOfferOpen(true)}
                        activeOpacity={0.85}
                      >
                        <Ionicons name="pricetag-outline" size={17} color={offerPrimary ? "#fff" : colors.text} />
                        <Text style={[styles.offerBtnText, offerPrimary && styles.offerBtnTextPrimary]}>{t('shop.makeOffer')}</Text>
                      </TouchableOpacity>
                    )}
                    {orderFor('offer')?.status === 'requested' && (
                      <TouchableOpacity style={styles.pendingBtn} onPress={() => cancelRequest(orderFor('offer')!)} disabled={!!busyKind}>
                        <Ionicons name="time-outline" size={17} color={colors.textSecondary} />
                        <Text style={styles.pendingBtnText}>
                          {t('shop.offerSent', { price: formatPrice(orderFor('offer')!.price_cents, listing.currency) })}
                        </Text>
                      </TouchableOpacity>
                    )}

                    {/* Add to cart (shortlists the everyday deal type). */}
                    {!deliveredOrder && (
                      <TouchableOpacity
                        style={[styles.cartBtn, inCart && styles.cartBtnActive]}
                        onPress={() => { reactionPop(); inCart ? removeFromCart(listing.id) : addToCart(listing); }}
                        activeOpacity={0.85}
                      >
                        <Ionicons name={inCart ? 'checkmark' : 'cart-outline'} size={17} color={inCart ? colors.success : colors.text} />
                        <Text style={[styles.cartBtnText, inCart && { color: colors.success }]}>
                          {inCart ? t('shop.inCart') : t('shop.addToCart')}
                        </Text>
                      </TouchableOpacity>
                    )}
                  </>
                ) : !deliveredOrder ? (
                  <View style={styles.pendingBtn}>
                    <Text style={styles.pendingBtnText}>
                      {listing.status === 'sold' ? t('shop.sold') : t('shop.unavailable')}
                    </Text>
                  </View>
                ) : null}

                <TouchableOpacity
                  style={styles.messageBtn}
                  onPress={() => router.push(`/messages/${listing.user_id}`)}
                >
                  <Ionicons name="chatbubble-outline" size={17} color={colors.text} />
                  <Text style={styles.messageBtnText}>{t('shop.messageSeller')}</Text>
                </TouchableOpacity>
                {!!error && <Text style={styles.errorText}>{error}</Text>}
                {orders.some((o) => o.status === 'requested') && (
                  <Text style={styles.hint}>{t('shop.requestHint')}</Text>
                )}
                <TouchableOpacity style={styles.reportRow} onPress={() => reportListing(listing.id)} hitSlop={6}>
                  <Ionicons name="flag-outline" size={13} color={colors.textTertiary} />
                  <Text style={styles.reportText}>{t('shop.report')}</Text>
                </TouchableOpacity>
                {/* What Buy / Lease / Free actually grant — the full agreement. */}
                <TouchableOpacity style={styles.reportRow} onPress={() => router.push('/marketplace-terms')} hitSlop={6}>
                  <Ionicons name="document-text-outline" size={13} color={colors.textTertiary} />
                  <Text style={styles.reportText}>{t('shop.marketplaceTerms')}</Text>
                </TouchableOpacity>
              </View>
            )}
          </ScrollView>
        )}

        {/* Offer sheet — buyer names a buy-out price on a lease-only beat. */}
        {/* Gated free claim. A Modal owned by this screen, deliberately not a
            route: as its own screen it had to be listed in app/_layout's
            transparentModal array, and missing that made the pager and the
            stack animate against each other. */}
        <Modal visible={freeOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setFreeOpen(false)}>
          <View style={styles.freeSheet}>
            <View style={styles.freeSheetHead}>
              <Text style={styles.freeSheetTitle} numberOfLines={1}>{t('shop.unlockTitle')}</Text>
              <TouchableOpacity onPress={() => setFreeOpen(false)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('a11y.close')}>
                <Ionicons name="close" size={24} color={colors.text} />
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={styles.freeSheetBody} showsVerticalScrollIndicator={false}>
              <Text style={styles.freeSheetIntro}>{t('shop.freeClaimIntro')}</Text>
              <View style={styles.unlockCard}>
                {!!listing?.free_requires_follow && (
                  <TouchableOpacity
                    style={styles.unlockRow}
                    onPress={() => { if (!followOk && listing) toggleFollow(listing.user_id); }}
                    activeOpacity={followOk ? 1 : 0.7}
                  >
                    <Ionicons name={followOk ? 'checkmark-circle' : 'person-add-outline'} size={20} color={followOk ? colors.success : colors.textSecondary} />
                    <Text style={[styles.unlockText, followOk && styles.unlockTextMet]}>
                      {t('shop.unlockFollow', { name: sellerName || '—' })}
                    </Text>
                    {!followOk && <Ionicons name="chevron-forward" size={15} color={colors.textTertiary} />}
                  </TouchableOpacity>
                )}
                {(conds?.likes ?? []).map((lk, i) => (
                  <TouchableOpacity
                    key={lk.postId}
                    style={styles.unlockRow}
                    // Closing first is required — a route pushed while a
                    // pageSheet is up presents behind it on iOS. The ref is what
                    // brings the user back here afterwards.
                    onPress={() => { reopenFreeRef.current = true; setFreeOpen(false); router.push(`/post/${lk.postId}`); }}
                    activeOpacity={0.7}
                  >
                    <Ionicons name={lk.met ? 'checkmark-circle' : 'heart-outline'} size={20} color={lk.met ? colors.success : colors.textSecondary} />
                    <Text style={[styles.unlockText, lk.met && styles.unlockTextMet]}>
                      {t('shop.unlockLike', { n: i + 1 })}
                    </Text>
                    {!lk.met && <Ionicons name="chevron-forward" size={15} color={colors.textTertiary} />}
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={[styles.unlockHint, readyToClaim && { color: colors.success }]}>
                {readyToClaim ? t('shop.unlockReady') : t('shop.unlockUnmet')}
              </Text>
              {!!error && <Text style={styles.errorText}>{error}</Text>}
              {/* Locked until every box is ticked — the same condition
                  shop_order_precheck enforces server-side, so this never
                  promises something the backend will refuse. */}
              <TouchableOpacity
                style={[styles.greenBtn, !readyToClaim && styles.btnLocked]}
                onPress={claimFree}
                disabled={!readyToClaim || busyKind === 'free'}
                activeOpacity={0.85}
              >
                {busyKind === 'free' ? <ActivityIndicator color="#fff" /> : (
                  <>
                    <Ionicons name={readyToClaim ? 'gift' : 'lock-closed'} size={18} color="#fff" />
                    <Text style={styles.greenBtnText}>{t('shop.freeClaimBtn')}</Text>
                  </>
                )}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </Modal>

        <Modal visible={offerOpen} transparent animationType="slide" onRequestClose={() => setOfferOpen(false)}>
          <Pressable style={styles.offerBackdrop} onPress={() => setOfferOpen(false)}>
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
              <Pressable style={[styles.offerSheet, { paddingBottom: insets.bottom + SPACING.md }]}>
                <Text style={styles.offerTitle}>{t('shop.makeOffer')}</Text>
                <Text style={styles.offerSub}>{t('shop.offerSub')}</Text>
                <View style={styles.offerRow}>
                  <Text style={styles.offerSymbol}>$</Text>
                  <TextInput
                    style={styles.offerInput}
                    placeholder="0.00"
                    placeholderTextColor={colors.textTertiary}
                    value={offerText}
                    onChangeText={setOfferText}
                    keyboardType="decimal-pad"
                    maxLength={8}
                    autoFocus
                  />
                </View>
                <TouchableOpacity
                  style={[styles.greenBtn, offerCents <= 0 && { opacity: 0.5 }]}
                  onPress={() => buy('offer', offerCents)}
                  disabled={offerCents <= 0 || !!busyKind}
                  activeOpacity={0.85}
                >
                  {busyKind === 'offer' ? <ActivityIndicator color="#fff" /> : (
                    <>
                      <Ionicons name="paper-plane-outline" size={17} color="#fff" />
                      <Text style={styles.greenBtnText}>{t('shop.offerSend')}</Text>
                    </>
                  )}
                </TouchableOpacity>
              </Pressable>
            </KeyboardAvoidingView>
          </Pressable>
        </Modal>

        {/* One-time buyer safety primer (payments settle off-platform). */}
        <ConfirmDialog
          visible={safetyOpen}
          title={t('shop.safetyTitle')}
          message={t('shop.safetyBody')}
          confirmLabel={t('shop.safetyOk')}
          cancelLabel={t('common.cancel')}
          icon="shield-checkmark-outline"
          onConfirm={ackSafetyAndBuy}
          onCancel={() => { pendingBuyRef.current = null; setSafetyOpen(false); }}
        />

        <ConfirmDialog
          visible={confirmRemove}
          title={hasSales ? t('shop.refundRemoveTitle') : t('shop.removeConfirmTitle')}
          message={hasSales ? t('shop.refundRemoveMsg') : t('shop.removeConfirmMsg')}
          confirmLabel={hasSales ? t('shop.refundRemove') : t('shop.remove')}
          cancelLabel={t('common.cancel')}
          destructive
          onConfirm={removeListing}
          onCancel={() => setConfirmRemove(false)}
        />
      </View>
    </SwipeBackPager>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.background },
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, gap: 6 },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerRight: { flexDirection: 'row', alignItems: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', color: c.text, fontSize: 16, fontWeight: '700' },
  cartBadge: {
    position: 'absolute', top: 4, right: 4, minWidth: 15, height: 15, borderRadius: 7.5,
    paddingHorizontal: 3, backgroundColor: c.success, alignItems: 'center', justifyContent: 'center',
  },
  cartBadgeText: { color: '#fff', fontSize: 9, fontWeight: '800' },
  cartBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    borderWidth: 1, borderColor: c.border, borderRadius: RADIUS.full, paddingVertical: 12,
  },
  cartBtnActive: { borderColor: c.success, backgroundColor: c.success + '14' },
  cartBtnText: { color: c.text, fontSize: 14, fontWeight: '600' },
  content: { padding: SPACING.md, gap: 12, paddingBottom: 44 },
  coverWrap: { borderRadius: RADIUS.lg, overflow: 'hidden', aspectRatio: 1, backgroundColor: c.surfaceLight },
  cover: { width: '100%', height: '100%' },
  playScrim: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.25)', gap: 2 },
  previewLabel: { color: 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: '700', letterSpacing: 0.6 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  title: { color: c.text, fontSize: 19, fontWeight: '800' },
  meta: { color: c.textTertiary, fontSize: 12, marginTop: 3 },
  pricePill: { backgroundColor: c.success, borderRadius: RADIUS.full, paddingHorizontal: 13, paddingVertical: 6 },
  priceText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  sales: { color: c.textSecondary, fontSize: 12, fontWeight: '600' },
  // Deal-type explainer (Lease / Sell / Free in plain words).
  description: { color: c.textSecondary, fontSize: 14, lineHeight: 20 },
  sellerRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: c.surface, borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, padding: 10,
  },
  sellerAvatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  sellerInitial: { color: '#fff', fontSize: 16, fontWeight: '700' },
  sellerName: { color: c.text, fontSize: 14, fontWeight: '700' },
  sellerSub: { color: c.textTertiary, fontSize: 12 },
  ownerActions: { flexDirection: 'row', gap: 8 },
  ownerBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderWidth: 1, borderColor: c.border, borderRadius: RADIUS.md, paddingVertical: 11,
  },
  ownerBtnText: { color: c.text, fontSize: 13, fontWeight: '600' },
  protectedRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, paddingHorizontal: 4 },
  protectedText: { flex: 1, color: c.textTertiary, fontSize: 11.5, lineHeight: 16 },
  buyerActions: { gap: 8 },
  // A CTA and its caption. Small gap so the caption reads as belonging to the
  // button above it rather than floating between two.
  ctaBlock: { gap: 5 },
  ctaDesc: {
    color: c.textTertiary, fontSize: 11.5, lineHeight: 15,
    textAlign: 'center', paddingHorizontal: 8,
  },
  ctaDescRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  ctaLong: {
    color: c.textSecondary, fontSize: 12, lineHeight: 17,
    paddingHorizontal: 10, paddingTop: 6,
  },
  freeSheet: { flex: 1, backgroundColor: c.background },
  freeSheetHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border,
  },
  freeSheetTitle: { flex: 1, color: c.text, fontSize: 17, fontWeight: '800' },
  freeSheetBody: { padding: SPACING.md, gap: SPACING.md },
  freeSheetIntro: { color: c.textSecondary, fontSize: 13.5, lineHeight: 19 },
  greenBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: c.success, borderRadius: RADIUS.full, paddingVertical: 13,
  },
  // The lease button reads as its own deal, not a twin of Buy.
  leaseBtn: { backgroundColor: '#0EA5E9' },
  greenBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  freeBtn: { paddingVertical: 9 },
  freeBtnInner: { alignItems: 'center' },
  claimNowText: { color: 'rgba(255,255,255,0.85)', fontSize: 11, fontWeight: '600', marginTop: 1 },
  btnLocked: { opacity: 0.55 },
  unlockCard: {
    backgroundColor: c.surface, borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
    padding: 12, gap: 10,
  },
  unlockTitle: { color: c.text, fontSize: 13, fontWeight: '800' },
  unlockRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  unlockText: { flex: 1, color: c.textSecondary, fontSize: 13, fontWeight: '600' },
  unlockTextMet: { color: c.text, textDecorationLine: 'line-through', opacity: 0.7 },
  unlockHint: { color: c.textTertiary, fontSize: 11.5, marginTop: 2 },
  offerBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    borderWidth: 1.5, borderColor: c.text, borderRadius: RADIUS.full, paddingVertical: 12,
  },
  offerBtnText: { color: c.text, fontSize: 14, fontWeight: '700' },
  offerBtnPrimary: { backgroundColor: c.success, borderColor: c.success },
  offerBtnTextPrimary: { color: '#fff' },
  pendingBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    backgroundColor: c.surfaceLight, borderRadius: RADIUS.full, paddingVertical: 13,
  },
  pendingBtnText: { color: c.textSecondary, fontSize: 14, fontWeight: '700' },
  messageBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    borderWidth: 1, borderColor: c.border, borderRadius: RADIUS.full, paddingVertical: 12,
  },
  messageBtnText: { color: c.text, fontSize: 14, fontWeight: '600' },
  hint: { color: c.textTertiary, fontSize: 12, textAlign: 'center', lineHeight: 17, paddingHorizontal: 10 },
  errorText: { color: c.error, fontSize: 12.5, textAlign: 'center' },
  reportRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 6 },
  reportText: { color: c.textTertiary, fontSize: 12 },
  gone: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  goneText: { color: c.textTertiary, fontSize: 14 },
  offerBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  offerSheet: {
    backgroundColor: c.surface,
    borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl,
    paddingHorizontal: SPACING.md, paddingTop: SPACING.md, gap: 10,
  },
  offerTitle: { color: c.text, fontSize: 16, fontWeight: '800' },
  offerSub: { color: c.textSecondary, fontSize: 12.5, lineHeight: 18 },
  offerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  offerSymbol: { color: c.text, fontSize: 18, fontWeight: '800' },
  offerInput: {
    flex: 1, backgroundColor: c.surfaceLight, borderRadius: RADIUS.md,
    paddingHorizontal: 14, paddingVertical: 12, color: c.text, fontSize: 16, fontWeight: '700',
  },
});
