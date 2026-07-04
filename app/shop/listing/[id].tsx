import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Image, ScrollView, ActivityIndicator, Linking,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
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
import { usePostMusic } from '../../../contexts/PostMusicContext';
import {
  fetchListing, formatPrice, getDeliverableUrl, myOrderForListing, requestToBuy,
  setOrderStatus, updateListing, type ShopListing, type ShopOrder,
} from '../../../lib/shop';

const PREVIEW_HOST = 'shop-preview';

// Listing detail — the marketplace "product page": cover, tap-to-play preview,
// price/license/category, seller row, and the CTA state machine:
//   visitor: Request to buy → Requested (cancel) → Delivered (download)
//   seller:  Edit · Pause/Activate · Remove

export default function ListingScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile } = useProfile();
  const { playSong, stop: stopSong } = usePostMusic();

  const [listing, setListing] = useState<ShopListing | null>(null);
  const [order, setOrder] = useState<ShopOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const isOwner = !!listing && listing.user_id === profile?.id;

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [l, o] = await Promise.all([fetchListing(id), myOrderForListing(id)]);
      setListing(l);
      setOrder(o);
    } catch { /* pre-migration */ }
    setLoading(false);
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => () => { stopSong(PREVIEW_HOST); }, [stopSong]);

  function togglePreview() {
    if (!listing?.preview_url) return;
    if (previewing) {
      stopSong(PREVIEW_HOST);
      setPreviewing(false);
    } else {
      playSong(PREVIEW_HOST, listing.id, listing.preview_url);
      setPreviewing(true);
    }
  }

  async function buy() {
    if (!listing || busy) return;
    setBusy(true);
    try {
      const o = await requestToBuy(listing, '');
      setOrder(o);
    } catch { /* unique violation = already requested */ await load(); }
    setBusy(false);
  }

  async function cancelRequest() {
    if (!order || busy) return;
    setBusy(true);
    setOrder({ ...order, status: 'cancelled' });
    await setOrderStatus(order.id, 'cancelled').catch(() => load());
    setBusy(false);
  }

  async function download() {
    if (!listing?.file_path || busy) return;
    setBusy(true);
    try {
      const url = await getDeliverableUrl(listing.file_path);
      Linking.openURL(url).catch(() => {});
    } catch { /* not delivered / revoked */ }
    setBusy(false);
  }

  async function setStatus(status: 'active' | 'paused' | 'removed') {
    if (!listing) return;
    if (status === 'removed') setConfirmRemove(false);
    setListing({ ...listing, status });
    await updateListing(listing.id, { status }).catch(() => load());
    if (status === 'removed') router.back();
  }

  const sellerName = listing?.seller?.display_name || listing?.seller?.username || '';

  return (
    <SwipeBackPager>
      <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle} numberOfLines={1}>{listing?.title ?? t('shop.title')}</Text>
          <View style={styles.headerBtn} />
        </View>

        {loading || !listing ? (
          loading ? <DetailSkeleton /> : (
            <View style={styles.gone}>
              <Ionicons name="bag-remove-outline" size={40} color={colors.textTertiary} />
              <Text style={styles.goneText}>{t('shop.listingGone')}</Text>
            </View>
          )
        ) : (
          <ScrollView contentContainerStyle={styles.content}>
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
                  {` · ${t(`shop.license.${listing.license}`)}`}
                </Text>
              </View>
              <View style={styles.pricePill}>
                <Text style={styles.priceText}>
                  {listing.price_cents <= 0 ? t('shop.free') : formatPrice(listing.price_cents, listing.currency)}
                </Text>
              </View>
            </View>

            {listing.sales_count > 0 && (
              <Text style={styles.sales}>{t('shop.salesCount', { n: listing.sales_count })}</Text>
            )}
            {!!listing.description && <Text style={styles.description}>{listing.description}</Text>}

            {/* Seller */}
            <TouchableOpacity
              style={styles.sellerRow}
              onPress={() => router.push(`/profile/${listing.user_id}`)}
              activeOpacity={0.8}
            >
              {listing.seller?.avatar_url ? (
                <Image source={{ uri: listing.seller.avatar_url }} style={styles.sellerAvatar} />
              ) : (
                <LinearGradient colors={GRADIENTS.primary} style={styles.sellerAvatar}>
                  <Text style={styles.sellerInitial}>{(sellerName || '?').charAt(0).toUpperCase()}</Text>
                </LinearGradient>
              )}
              <View style={styles.flex}>
                <Text style={styles.sellerName}>{sellerName}</Text>
                <Text style={styles.sellerSub}>{t('shop.viewShop')}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
            </TouchableOpacity>

            {/* CTAs */}
            {isOwner ? (
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
            ) : (
              <View style={styles.buyerActions}>
                {order?.status === 'delivered' ? (
                  <TouchableOpacity style={styles.greenBtn} onPress={download} disabled={busy} activeOpacity={0.85}>
                    {busy ? <ActivityIndicator color="#fff" /> : (
                      <>
                        <Ionicons name="download-outline" size={18} color="#fff" />
                        <Text style={styles.greenBtnText}>{t('shop.download')}</Text>
                      </>
                    )}
                  </TouchableOpacity>
                ) : order?.status === 'requested' ? (
                  <TouchableOpacity style={styles.pendingBtn} onPress={cancelRequest} disabled={busy}>
                    <Ionicons name="time-outline" size={17} color={colors.textSecondary} />
                    <Text style={styles.pendingBtnText}>{t('shop.requested')}</Text>
                  </TouchableOpacity>
                ) : listing.status === 'active' ? (
                  <TouchableOpacity style={styles.greenBtn} onPress={buy} disabled={busy} activeOpacity={0.85}>
                    {busy ? <ActivityIndicator color="#fff" /> : (
                      <>
                        <Ionicons name="bag-check-outline" size={18} color="#fff" />
                        <Text style={styles.greenBtnText}>
                          {listing.price_cents <= 0 ? t('shop.get') : t('shop.requestToBuy')}
                        </Text>
                      </>
                    )}
                  </TouchableOpacity>
                ) : (
                  <View style={styles.pendingBtn}>
                    <Text style={styles.pendingBtnText}>{t('shop.unavailable')}</Text>
                  </View>
                )}
                <TouchableOpacity
                  style={styles.messageBtn}
                  onPress={() => router.push(`/messages/${listing.user_id}`)}
                >
                  <Ionicons name="chatbubble-outline" size={17} color={colors.text} />
                  <Text style={styles.messageBtnText}>{t('shop.messageSeller')}</Text>
                </TouchableOpacity>
                {order?.status === 'requested' && (
                  <Text style={styles.hint}>{t('shop.requestHint')}</Text>
                )}
              </View>
            )}
          </ScrollView>
        )}

        <ConfirmDialog
          visible={confirmRemove}
          title={t('shop.removeConfirmTitle')}
          message={t('shop.removeConfirmMsg')}
          confirmLabel={t('shop.remove')}
          cancelLabel={t('common.cancel')}
          destructive
          onConfirm={() => setStatus('removed')}
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
  headerTitle: { flex: 1, textAlign: 'center', color: c.text, fontSize: 16, fontWeight: '700' },
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
  buyerActions: { gap: 8 },
  greenBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: c.success, borderRadius: RADIUS.full, paddingVertical: 13,
  },
  greenBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
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
  gone: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  goneText: { color: c.textTertiary, fontSize: 14 },
});
