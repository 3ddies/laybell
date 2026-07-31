import { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { RADIUS, SPACING, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { notifySuccess, reactionPop } from '../lib/haptics';
import { formatPrice, setOrderStatus, OFFER_TTL_MS, type OrderStatus } from '../lib/shop';
import type { ParsedOffer } from '../lib/offerMessage';

// A buy-offer, rendered in the DM thread as a card instead of a chat bubble —
// the seller answers it where they read it, rather than being told to go and
// find the Orders tab.
//
// The ORDER's status is the truth, not the message. A message cannot be edited
// once sent, so an accepted offer would otherwise still be showing Accept and
// Decline forever. `status` is passed in by the thread, which reads every offer
// order in one query, and is undefined until that lands — the buttons stay out
// until it does, because offering the seller a button that might be settling an
// already-settled order is worse than a beat of nothing.
//
// Accepting is a real exclusive sale: shop_settle_offer pays the escrow out to
// the seller, and shop_order_delivered marks the listing sold and auto-declines
// every other pending request on it. Hence the confirm step.

export default function OfferMessageCard({
  offer,
  status,
  createdAt,
  isOwn,
  onSettled,
}: {
  offer: ParsedOffer;
  status?: OrderStatus;
  // When the order was placed, for the 24h deadline. From the ORDER, not the
  // message — they are made moments apart, but only one of them is what the
  // server measures against.
  createdAt?: string;
  // The BUYER sent it. Only the other side gets to accept or decline.
  isOwn: boolean;
  onSettled?: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const router = useRouter();
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState(false);

  const price = formatPrice(offer.cents, offer.currency);
  // An offer stands for 24h. The sweep that formally expires it (and returns the
  // buyer's escrowed credits) runs every ten minutes, so between the deadline and
  // the next pass the row still says 'requested'. Reading it as expired here
  // keeps the card honest in that window — and, more importantly, keeps Accept
  // out of the seller's reach on an offer the server would now refuse to deliver.
  const pastDue = !!createdAt && Date.now() - new Date(createdAt).getTime() > OFFER_TTL_MS;
  const effective: OrderStatus | undefined =
    status === 'requested' && pastDue ? 'expired' : status;
  const pending = effective === 'requested';
  const canAnswer = !isOwn && pending;

  async function settle(next: 'delivered' | 'declined') {
    if (busy) return;
    setBusy(next === 'delivered' ? 'accept' : 'decline');
    setFailed(false);
    try {
      await setOrderStatus(offer.orderId, next);
      if (next === 'delivered') notifySuccess(); else reactionPop();
      onSettled?.();
    } catch {
      // Accepting genuinely can fail: shop_order_delivered raises 'listing_sold'
      // once the beat has gone exclusively, so a seller sitting on two offers who
      // accepts both gets refused on the second — correctly. Say so rather than
      // leaving a button that looks broken, and re-read, which is what actually
      // replaces this card with the real outcome.
      setFailed(true);
      onSettled?.();
    }
    setBusy(null);
    setConfirming(false);
  }

  const outcome =
    effective === 'delivered' ? { icon: 'checkmark-circle' as const, text: t('offerMsg.accepted'), tone: colors.success }
      : effective === 'declined' ? { icon: 'close-circle' as const, text: t('offerMsg.declined'), tone: colors.textTertiary }
        : effective === 'cancelled' ? { icon: 'remove-circle' as const, text: t('offerMsg.cancelled'), tone: colors.textTertiary }
          : effective === 'expired' ? { icon: 'time' as const, text: t('offerMsg.expired'), tone: colors.textTertiary }
            : effective === 'refunded' ? { icon: 'arrow-undo-circle' as const, text: t('offerMsg.refunded'), tone: colors.textTertiary }
              : null;

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <View style={styles.tag}>
          <Ionicons name="pricetag" size={12} color={colors.success} />
          <Text style={styles.tagText}>{isOwn ? t('offerMsg.youOffered') : t('offerMsg.title')}</Text>
        </View>
      </View>

      <Text style={styles.amount}>{price}</Text>
      {!!offer.title && (
        <TouchableOpacity
          onPress={() => offer.listingId && router.push(`/shop/listing/${offer.listingId}`)}
          disabled={!offer.listingId}
          activeOpacity={0.7}
        >
          <Text style={styles.listing} numberOfLines={2}>{offer.title}</Text>
        </TouchableOpacity>
      )}
      {/* On the card itself, not only in the accept confirmation — both sides
          should be able to see what kind of deal this is without tapping
          anything. An offer is always a BUY-OUT; there is no such thing as an
          offer to lease, and a seller skimming a thread could easily assume
          otherwise. */}
      <Text style={styles.toBuy}>{t('offerMsg.toBuy')}</Text>
      {!!offer.note && <Text style={styles.note}>{offer.note}</Text>}

      {outcome ? (
        <View style={styles.outcome}>
          <Ionicons name={outcome.icon} size={15} color={outcome.tone} />
          <Text style={[styles.outcomeText, { color: outcome.tone }]}>{outcome.text}</Text>
        </View>
      ) : canAnswer ? (
        confirming ? (
          <View style={styles.confirmWrap}>
            {/* Says what accepting actually does. It is not "agree to a price" —
                it takes the money, hands over the file and ends the listing. */}
            <Text style={styles.confirmText}>{t('offerMsg.confirmBody', { price })}</Text>
            <View style={styles.btnRow}>
              <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={() => setConfirming(false)} disabled={!!busy}>
                <Text style={styles.btnGhostText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.btn, styles.btnAccept]} onPress={() => settle('delivered')} disabled={!!busy}>
                {busy === 'accept'
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={styles.btnAcceptText}>{t('offerMsg.confirmAccept')}</Text>}
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <View style={styles.btnRow}>
            <TouchableOpacity style={[styles.btn, styles.btnDecline]} onPress={() => settle('declined')} disabled={!!busy}>
              {busy === 'decline'
                ? <ActivityIndicator color={colors.textSecondary} size="small" />
                : <Text style={styles.btnDeclineText}>{t('offerMsg.decline')}</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={[styles.btn, styles.btnAccept]} onPress={() => setConfirming(true)} disabled={!!busy}>
              <Text style={styles.btnAcceptText}>{t('offerMsg.accept')}</Text>
            </TouchableOpacity>
          </View>
        )
      ) : pending ? (
        <View style={styles.outcome}>
          <Ionicons name="time-outline" size={15} color={colors.textTertiary} />
          <Text style={[styles.outcomeText, { color: colors.textTertiary }]}>{t('offerMsg.waiting')}</Text>
        </View>
      ) : null}

      {failed && <Text style={styles.failed}>{t('shop.noLongerAvailable')}</Text>}
    </View>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  // Green-edged rather than green-filled: it has to read as money without
  // shouting over the thread it sits in.
  card: {
    maxWidth: 290, minWidth: 210,
    backgroundColor: c.surfaceElevated,
    borderWidth: 1, borderColor: c.success + '66',
    borderRadius: RADIUS.lg,
    padding: SPACING.md,
    gap: 4,
  },
  head: { flexDirection: 'row', alignItems: 'center' },
  tag: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: c.success + '1F', borderRadius: RADIUS.full,
    paddingVertical: 3, paddingHorizontal: 8,
  },
  tagText: { color: c.success, fontSize: 11, fontWeight: '800', letterSpacing: 0.2 },

  amount: { color: c.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.5, marginTop: 2 },
  listing: { color: c.textSecondary, fontSize: 13, fontWeight: '600' },
  toBuy: { color: c.textTertiary, fontSize: 11.5, fontWeight: '700', marginTop: 1 },
  note: { color: c.textSecondary, fontSize: 13, marginTop: 4, lineHeight: 18 },

  outcome: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: SPACING.sm },
  outcomeText: { fontSize: 13, fontWeight: '700' },

  btnRow: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.sm },
  btn: {
    flex: 1, borderRadius: RADIUS.full, paddingVertical: 9,
    alignItems: 'center', justifyContent: 'center',
  },
  btnAccept: { backgroundColor: c.success },
  btnAcceptText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  btnDecline: { backgroundColor: c.surfaceLight, borderWidth: 1, borderColor: c.border },
  btnDeclineText: { color: c.textSecondary, fontSize: 14, fontWeight: '700' },
  btnGhost: { backgroundColor: 'transparent' },
  btnGhostText: { color: c.textTertiary, fontSize: 14, fontWeight: '700' },

  confirmWrap: { marginTop: SPACING.sm },
  confirmText: { color: c.textSecondary, fontSize: 12.5, lineHeight: 17 },
  failed: { color: c.error, fontSize: 12.5, marginTop: SPACING.xs, lineHeight: 17 },
});
