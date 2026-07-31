import { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Image, ScrollView, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import SwipeBackPager from '../../components/SwipeBackPager';
import ConfirmDialog from '../../components/ConfirmDialog';
import { GRADIENTS, RADIUS, SPACING, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { reactionPop, notifySuccess } from '../../lib/haptics';
import { fetchListing, formatPrice, requestToBuy } from '../../lib/shop';
import { fetchLedgerBalances } from '../../lib/ledger';
import CreditConfirmDialog from '../../components/CreditConfirmDialog';
import {
  cartSubtotalCents, clearCart, removeFromCart, useShopCart, type CartItem,
} from '../../lib/shopCart';

// The cart — a local shortlist of listings to request together. "Checkout" here
// does NOT charge anything (the marketplace settles off-platform); it fires the
// same buy-REQUEST the listing page does, once per item, each DMing its seller.
// Successfully requested items leave the cart; anything unavailable is reported
// and left behind.

const SAFETY_ACK_KEY = 'shop_safety_ack_v1';

type Result = { requested: number; skipped: number };

export default function CartScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { items } = useShopCart();

  const [busy, setBusy] = useState(false);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const subtotal = cartSubtotalCents(items);
  // Credits held, read when checkout is tapped. null = no confirmation open.
  const [confirmBalance, setConfirmBalance] = useState<number | null>(null);

  async function startCheckout() {
    if (busy || items.length === 0) return;
    // One-time off-platform-payment primer, same gate the single-listing buy uses.
    const acked = await AsyncStorage.getItem(SAFETY_ACK_KEY).catch(() => null);
    if (!acked) { setSafetyOpen(true); return; }
    askConfirm();
  }

  async function ackAndCheckout() {
    setSafetyOpen(false);
    await AsyncStorage.setItem(SAFETY_ACK_KEY, '1').catch(() => {});
    askConfirm();
  }

  // Same confirmation the listing buttons use, against the cart subtotal. It
  // matters more here: a cart charges for several listings in one go, and the
  // old flow discovered an empty balance mid-run and reported the ITEMS as
  // unavailable, which was simply the wrong diagnosis.
  async function askConfirm() {
    setBusy(true);
    const bal = await fetchLedgerBalances().catch(() => null);
    setBusy(false);
    setConfirmBalance(bal?.ready ? bal.credits.totalCents : 0);
  }

  async function runCheckout() {
    setBusy(true);
    setError(null);
    let requested = 0;
    let skipped = 0;
    // Serial, not parallel: the buy-request throttle is per-user-per-window, and
    // a burst of parallel inserts could trip it spuriously or race the DMs.
    for (const item of [...items]) {
      try {
        const listing = await fetchListing(item.listingId);
        // Gone, paused, sold, or somehow your own listing → skip, keep in cart.
        if (!listing || listing.status !== 'active') { skipped++; continue; }
        // Request the deal type this item was added as (server re-validates it).
        await requestToBuy(listing, '', item.kind);
        removeFromCart(item.listingId);
        requested++;
      } catch (e) {
        const msg = (e as Error)?.message ?? '';
        if (msg.includes('rate_limited')) {
          setError(t('shop.rateLimited'));
          break; // stop the run; leave the rest in the cart to try later
        }
        // Out of credits: stop immediately. Counting this as "skipped" made the
        // run finish and report that the items were no longer available — the
        // items are fine, the balance isn't, and the buyer is one tap from
        // fixing it.
        if (msg.includes('insufficient funds')) {
          setError(t('shop.needCredits'));
          break;
        }
        // Unique violation = already requested earlier → treat as done, clear it.
        if (msg.toLowerCase().includes('duplicate') || msg.includes('unique')) {
          removeFromCart(item.listingId);
          requested++;
        } else {
          skipped++;
        }
      }
    }
    setBusy(false);
    if (requested > 0) { notifySuccess(); setResult({ requested, skipped }); }
    else if (skipped > 0 && !error) setError(t('shop.cart.allUnavailable'));
  }

  return (
    <SwipeBackPager>
      <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
        <View style={styles.header}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} onPress={() => router.back()} style={styles.headerBtn}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('shop.cart.title')}</Text>
          {items.length > 0 && !result ? (
            <TouchableOpacity onPress={() => clearCart()} style={styles.headerBtn} hitSlop={6}>
              <Text style={styles.clearText}>{t('shop.cart.clear')}</Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.headerBtn} />
          )}
        </View>

        {result ? (
          // ── Success state ───────────────────────────────────────────────────
          <View style={styles.doneWrap}>
            <LinearGradient colors={GRADIENTS.primary} style={styles.doneCircle}>
              <Ionicons name="checkmark" size={42} color="#fff" />
            </LinearGradient>
            <Text style={styles.doneTitle}>{t('shop.cart.doneTitle')}</Text>
            <Text style={styles.doneBody}>{t('shop.cart.doneBody', { n: result.requested })}</Text>
            {result.skipped > 0 && (
              <Text style={styles.doneSkipped}>{t('shop.cart.someSkipped', { n: result.skipped })}</Text>
            )}
            <TouchableOpacity style={styles.greenBtn} onPress={() => router.replace('/shop?tab=orders')} activeOpacity={0.85}>
              <Ionicons name="bag-check-outline" size={18} color="#fff" />
              <Text style={styles.greenBtnText}>{t('shop.cart.viewOrders')}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => router.back()} style={styles.linkBtn}>
              <Text style={styles.linkText}>{t('shop.cart.keepShopping')}</Text>
            </TouchableOpacity>
          </View>
        ) : items.length === 0 ? (
          // ── Empty state ─────────────────────────────────────────────────────
          <View style={styles.emptyWrap}>
            <Ionicons name="cart-outline" size={48} color={colors.textTertiary} />
            <Text style={styles.emptyTitle}>{t('shop.cart.empty')}</Text>
            <Text style={styles.emptySub}>{t('shop.cart.emptySub')}</Text>
            <TouchableOpacity style={styles.browseBtn} onPress={() => router.replace('/shop')} activeOpacity={0.85}>
              <Ionicons name="storefront-outline" size={17} color={colors.text} />
              <Text style={styles.browseText}>{t('shop.cart.browse')}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          // ── Cart list ───────────────────────────────────────────────────────
          <>
            <ScrollView contentContainerStyle={styles.list}>
              {items.map((item) => (
                <CartRow key={item.listingId} item={item} onOpen={() => router.push(`/shop/listing/${item.listingId}`)} onRemove={() => removeFromCart(item.listingId)} />
              ))}
              <Text style={styles.hint}>{t('shop.cart.checkoutHint')}</Text>
            </ScrollView>

            {/* Checkout bar */}
            <View style={[styles.footer, { paddingBottom: insets.bottom + SPACING.sm }]}>
              <View style={styles.subtotalRow}>
                <Text style={styles.subtotalLabel}>
                  {t('shop.cart.items', { n: items.length })}
                </Text>
                <Text style={styles.subtotalValue}>
                  {subtotal <= 0 ? t('shop.free') : formatPrice(subtotal)}
                </Text>
              </View>
              {!!error && <Text style={styles.errorText}>{error}</Text>}
              <TouchableOpacity style={styles.greenBtn} onPress={startCheckout} disabled={busy} activeOpacity={0.85}>
                {busy ? <ActivityIndicator color="#fff" /> : (
                  <>
                    <Ionicons name="bag-check-outline" size={18} color="#fff" />
                    <Text style={styles.greenBtnText}>{t('shop.cart.checkout')}</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </>
        )}

        {/* Same spend confirmation as the listing buttons, against the subtotal. */}
        <CreditConfirmDialog
          visible={confirmBalance !== null}
          priceCents={subtotal}
          balanceCents={confirmBalance ?? 0}
          itemLabel={t('shop.cart.items', { n: items.length })}
          onBuy={() => { setConfirmBalance(null); runCheckout(); }}
          onCancel={() => setConfirmBalance(null)}
        />

        <ConfirmDialog
          visible={safetyOpen}
          title={t('shop.safetyTitle')}
          message={t('shop.safetyBody')}
          confirmLabel={t('shop.safetyOk')}
          cancelLabel={t('common.cancel')}
          icon="shield-checkmark-outline"
          onConfirm={ackAndCheckout}
          onCancel={() => setSafetyOpen(false)}
        />
      </View>
    </SwipeBackPager>
  );
}

function CartRow({ item, onOpen, onRemove }: { item: CartItem; onOpen: () => void; onRemove: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  return (
    <View style={styles.row}>
      <TouchableOpacity style={styles.rowMain} onPress={onOpen} activeOpacity={0.8}>
        {item.coverUrl ? (
          <Image source={{ uri: item.coverUrl }} style={styles.cover} />
        ) : (
          <LinearGradient colors={GRADIENTS.primary} style={styles.cover}>
            <Ionicons name="musical-note" size={18} color="#fff" />
          </LinearGradient>
        )}
        <View style={styles.rowInfo}>
          <Text style={styles.rowTitle} numberOfLines={1}>{item.title}</Text>
          {!!item.sellerName && <Text style={styles.rowSeller} numberOfLines={1}>{item.sellerName}</Text>}
          <Text style={styles.rowPrice}>
            {item.priceCents <= 0 ? t('shop.free') : formatPrice(item.priceCents, item.currency)}
            {item.kind ? `  ·  ${t(`shop.kind.${item.kind}`)}` : ''}
          </Text>
        </View>
      </TouchableOpacity>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.close')} onPress={() => { reactionPop(); onRemove(); }} style={styles.removeBtn} hitSlop={8}>
        <Ionicons name="close" size={18} color={colors.textTertiary} />
      </TouchableOpacity>
    </View>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.background },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 },
  headerBtn: { minWidth: 40, height: 40, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  headerTitle: { flex: 1, textAlign: 'center', color: c.text, fontSize: 17, fontWeight: '700' },
  clearText: { color: c.textSecondary, fontSize: 13, fontWeight: '600' },

  list: { padding: SPACING.md, gap: 10, paddingBottom: 20 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: c.surface, borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
  },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10 },
  cover: { width: 54, height: 54, borderRadius: RADIUS.sm, backgroundColor: c.surfaceLight, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  rowInfo: { flex: 1, gap: 2 },
  rowTitle: { color: c.text, fontSize: 14, fontWeight: '700' },
  rowSeller: { color: c.textTertiary, fontSize: 12 },
  rowPrice: { color: c.success, fontSize: 13, fontWeight: '800', marginTop: 1 },
  removeBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', marginRight: 4 },
  hint: { color: c.textTertiary, fontSize: 12, lineHeight: 17, textAlign: 'center', paddingHorizontal: 16, marginTop: 6 },

  footer: {
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border,
    paddingHorizontal: SPACING.md, paddingTop: SPACING.sm, gap: 8,
    backgroundColor: c.background,
  },
  subtotalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  subtotalLabel: { color: c.textSecondary, fontSize: 13, fontWeight: '600' },
  subtotalValue: { color: c.text, fontSize: 17, fontWeight: '800' },
  errorText: { color: c.error, fontSize: 12.5, textAlign: 'center' },
  greenBtn: {
    alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: c.success, borderRadius: RADIUS.full, paddingVertical: 14,
  },
  greenBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 40 },
  emptyTitle: { color: c.text, fontSize: 17, fontWeight: '800', marginTop: 4 },
  emptySub: { color: c.textTertiary, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  browseBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 8,
    borderWidth: 1, borderColor: c.border, borderRadius: RADIUS.full, paddingHorizontal: 18, paddingVertical: 11,
  },
  browseText: { color: c.text, fontSize: 14, fontWeight: '600' },

  doneWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 36 },
  doneCircle: { width: 80, height: 80, borderRadius: 40, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  doneTitle: { color: c.text, fontSize: 20, fontWeight: '800' },
  doneBody: { color: c.textSecondary, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  doneSkipped: { color: c.textTertiary, fontSize: 12.5, textAlign: 'center' },
  linkBtn: { paddingVertical: 10 },
  linkText: { color: c.textTertiary, fontSize: 13, fontWeight: '600' },
});
