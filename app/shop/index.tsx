import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, FlatList, ScrollView,
  ActivityIndicator, Image, RefreshControl, Switch,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import SwipeBackPager from '../../components/SwipeBackPager';
import ShopListingCard from '../../components/ShopListingCard';
import { GridSkeleton, ListRowsSkeleton } from '../../components/Skeleton';
import { reactionPop, tabTick } from '../../lib/haptics';
import { RADIUS, SPACING, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { useProfile } from '../../contexts/ProfileContext';
import {
  LISTING_CATEGORIES, createShop, deliverOrder, exploreListings, fetchMyPurchases,
  fetchMySales, fetchSellerListings, formatPrice, getShop, hasOpenShop,
  markShopOrdersSeen, pendingSalesCount, sellerEarningsCents, setOrderStatus, updateShop,
  fetchDeliveredShopEarningsCents,
  type ExploreSort, type ListingCategory, type SellerProfile, type Shop, type ShopListing, type ShopOrder,
} from '../../lib/shop';
import { useShopCart } from '../../lib/shopCart';

// The Shop hub — Laybell's marketplace for digital goods.
//   Explore  — browse/search every active listing (the marketplace feed)
//   My Shop  — open a shop, manage listings
//   Orders   — sales (deliver/decline buy requests) and purchases

type Tab = 'explore' | 'mine' | 'orders';

export default function ShopHubScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { profile } = useProfile();
  const params = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<Tab>(params.tab === 'mine' ? 'mine' : params.tab === 'orders' ? 'orders' : 'explore');
  const { count: cartCount } = useShopCart();
  // Buy requests waiting on you — surfaces as a green count on the Orders tab.
  const [pendingCount, setPendingCount] = useState(0);
  useEffect(() => {
    pendingSalesCount().then(setPendingCount).catch(() => {});
  }, [tab]);

  return (
    <SwipeBackPager>
      <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('shop.title')}</Text>
          <TouchableOpacity onPress={() => router.push('/shop/cart')} style={styles.headerBtn} accessibilityLabel={t('shop.cart.title')}>
            <Ionicons name="cart-outline" size={23} color={colors.text} />
            {cartCount > 0 && (
              <View style={styles.cartBadge}>
                <Text style={styles.cartBadgeText}>{cartCount > 9 ? '9+' : cartCount}</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>

        {/* Segmented tabs */}
        <View style={styles.segment}>
          {(['explore', 'mine', 'orders'] as Tab[]).map((k) => (
            <TouchableOpacity
              key={k}
              style={[styles.segmentBtn, tab === k && styles.segmentBtnActive]}
              onPress={() => setTab(k)}
            >
              <View style={styles.segmentInner}>
                <Text style={[styles.segmentText, tab === k && styles.segmentTextActive]}>
                  {t(`shop.tab.${k}`)}
                </Text>
                {k === 'orders' && pendingCount > 0 && (
                  <View style={styles.segmentBadge}>
                    <Text style={styles.segmentBadgeText}>{pendingCount > 9 ? '9+' : pendingCount}</Text>
                  </View>
                )}
              </View>
            </TouchableOpacity>
          ))}
        </View>

        {tab === 'explore' && <ExploreTab />}
        {tab === 'mine' && <MyShopTab myId={profile?.id ?? null} myAge={(profile as { age?: number | null } | null)?.age ?? null} />}
        {tab === 'orders' && (
          <OrdersTab onChanged={() => pendingSalesCount().then(setPendingCount).catch(() => {})} />
        )}
      </View>
    </SwipeBackPager>
  );
}

// --- Explore ----------------------------------------------------------------------

function ExploreTab() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<ListingCategory | null>(null);
  // One friendly chip that CYCLES the sort — no menu to open, no extra row.
  const [sort, setSort] = useState<ExploreSort>('new');
  const [listings, setListings] = useState<ShopListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (term: string, cat: ListingCategory | null, s: ExploreSort) => {
    try { setListings(await exploreListings({ search: term, category: cat, sort: s })); }
    catch { /* pre-migration */ }
    setLoading(false);
  }, []);

  // Debounced search + instant category/sort filters.
  useEffect(() => {
    const timer = setTimeout(() => load(search, category, sort), search ? 350 : 0);
    return () => clearTimeout(timer);
  }, [search, category, sort, load]);

  const SORTS: ExploreSort[] = ['new', 'price', 'popular'];
  const nextSort = () => setSort(SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length]);

  return (
    <View style={styles.flex}>
      <View style={styles.searchRow}>
        <Ionicons name="search" size={17} color={colors.textTertiary} />
        <TextInput
          style={styles.searchInput}
          placeholder={t('shop.searchPlaceholder')}
          placeholderTextColor={colors.textTertiary}
          value={search}
          onChangeText={setSearch}
          returnKeyType="search"
        />
        {!!search && (
          <TouchableOpacity onPress={() => setSearch('')} hitSlop={8}>
            <Ionicons name="close-circle" size={17} color={colors.textTertiary} />
          </TouchableOpacity>
        )}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow} contentContainerStyle={styles.chipRowContent}>
        <TouchableOpacity style={styles.sortChip} onPress={nextSort}>
          <Ionicons name="swap-vertical" size={13} color={colors.text} />
          <Text style={styles.sortChipText}>{t(`shop.sort.${sort}`)}</Text>
        </TouchableOpacity>
        <Chip label={t('shop.all')} active={!category} onPress={() => setCategory(null)} />
        {LISTING_CATEGORIES.map((c) => (
          <Chip key={c} label={t(`shop.category.${c}`)} active={category === c} onPress={() => setCategory(category === c ? null : c)} />
        ))}
      </ScrollView>
      {loading ? (
        <GridSkeleton columns={2} count={6} />
      ) : (
        <FlatList
          data={listings}
          keyExtractor={(l) => l.id}
          numColumns={2}
          columnWrapperStyle={styles.gridRow}
          contentContainerStyle={styles.gridContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              tintColor={colors.textSecondary}
              onRefresh={async () => { setRefreshing(true); await load(search, category, sort); setRefreshing(false); }}
            />
          }
          renderItem={({ item }) => (
            <ShopListingCard listing={item} onPress={() => router.push(`/shop/listing/${item.id}`)} />
          )}
          ListEmptyComponent={<Text style={styles.emptyText}>{t('shop.exploreEmpty')}</Text>}
        />
      )}
    </View>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <TouchableOpacity style={[styles.chip, active && styles.chipActive]} onPress={onPress}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

// --- My Shop ----------------------------------------------------------------------

function MyShopTab({ myId, myAge }: { myId: string | null; myAge: number | null }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const [shop, setShop] = useState<Shop | null>(null);
  const [listings, setListings] = useState<ShopListing[]>([]);
  // Lifetime take-home (delivered sales, after Laybell's 15%) for the stats strip.
  const [earnedCents, setEarnedCents] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [agreed, setAgreed] = useState(false); // seller-terms consent (required)
  const [busy, setBusy] = useState(false);
  // Tap the shop name/description to edit them in place.
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editBio, setEditBio] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  const load = useCallback(async () => {
    if (!myId) return;
    try {
      const s = await getShop(myId);
      setShop(s);
      if (s) {
        // Earnings come from the delivered_earnings() RPC, which sums EVERY
        // delivered order server-side. Summing fetchMySales() here instead would
        // undercount: that query is page-capped and ordered by recency across all
        // statuses, so a busy seller loses every delivered order past the cap.
        const [mine, earned] = await Promise.all([
          fetchSellerListings(myId, true),
          fetchDeliveredShopEarningsCents(),
        ]);
        setListings(mine);
        setEarnedCents(earned);
      }
    } catch { /* pre-migration */ }
    setLoading(false);
  }, [myId]);
  useEffect(() => { load(); }, [load]);

  function startEdit() {
    if (!shop) return;
    setEditName(shop.name);
    setEditBio(shop.bio ?? '');
    setEditing(true);
  }

  async function saveEdit() {
    if (!shop || !editName.trim() || savingEdit) return;
    setSavingEdit(true);
    const patch = { name: editName.trim(), bio: editBio.trim() || null };
    try {
      await updateShop(patch);
      setShop({ ...shop, ...patch });
      setEditing(false);
    } catch { /* keep the editor open so nothing typed is lost */ }
    setSavingEdit(false);
  }

  async function openShop() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await createShop(name, bio);
      tabTick(); // shop opened — a small moment worth marking
      await load();
    } catch { /* surfaced by empty state */ }
    setBusy(false);
  }

  if (loading) return <ListRowsSkeleton rows={5} />;

  // Selling requires being 18+ (contract capacity) — enforced by RLS too; this
  // is the friendly face of that rule. Buying stays open to everyone.
  if (!shop && myAge != null && myAge < 18) {
    return (
      <View style={styles.createWrap}>
        <Ionicons name="storefront-outline" size={44} color={colors.textTertiary} />
        <Text style={styles.createTitle}>{t('shop.ageGateTitle')}</Text>
        <Text style={styles.createSub}>{t('shop.ageGateBody')}</Text>
      </View>
    );
  }

  if (!shop) {
    return (
      <ScrollView
        contentContainerStyle={styles.createWrap}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={colors.textSecondary}
            onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
          />
        }
      >
        <Ionicons name="storefront-outline" size={44} color={colors.textTertiary} />
        <Text style={styles.createTitle}>{t('shop.createTitle')}</Text>
        <Text style={styles.createSub}>{t('shop.createSub')}</Text>
        <TextInput
          style={styles.input}
          placeholder={t('shop.namePlaceholder')}
          placeholderTextColor={colors.textTertiary}
          value={name}
          onChangeText={setName}
          maxLength={60}
        />
        <TextInput
          style={[styles.input, styles.inputMultiline]}
          placeholder={t('shop.bioPlaceholder')}
          placeholderTextColor={colors.textTertiary}
          value={bio}
          onChangeText={setBio}
          multiline
          maxLength={300}
        />

        {/* Seller agreement — short, honest, and required. */}
        <View style={styles.agreeCard}>
          <Text style={styles.agreeTitle}>{t('shop.agreeTitle')}</Text>
          {(['agreeVenue', 'agreeRights', 'agreeFee', 'agreeConduct'] as const).map((k) => (
            <View key={k} style={styles.agreeRow}>
              <Text style={styles.agreeBullet}>·</Text>
              <Text style={styles.agreeText}>{t(`shop.${k}`)}</Text>
            </View>
          ))}
          <TouchableOpacity style={styles.agreeCheckRow} onPress={() => setAgreed(!agreed)} activeOpacity={0.7}>
            <Ionicons
              name={agreed ? 'checkbox' : 'square-outline'}
              size={20}
              color={agreed ? colors.success : colors.textTertiary}
            />
            <Text style={styles.agreeCheckText}>
              {t('shop.agreeCheck')}
              {/* The Marketplace & Beat Licensing Terms are the seller's full
                  contract (what Buy/Lease/Free grant, exclusivity, refunds);
                  the ToS still governs everything else app-wide. */}
              <Text style={styles.agreeLink} onPress={() => router.push('/marketplace-terms')}> {t('shop.agreeTerms')}</Text>
            </Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={[styles.greenBtn, (!name.trim() || !agreed) && { opacity: 0.5 }]}
          onPress={openShop}
          disabled={!name.trim() || !agreed || busy}
          activeOpacity={0.85}
        >
          {busy ? <ActivityIndicator color="#fff" /> : (
            <>
              <Ionicons name="storefront" size={17} color="#fff" />
              <Text style={styles.greenBtnText}>{t('shop.openShop')}</Text>
            </>
          )}
        </TouchableOpacity>
      </ScrollView>
    );
  }

  return (
    <FlatList
      data={listings}
      keyExtractor={(l) => l.id}
      numColumns={2}
      columnWrapperStyle={styles.gridRow}
      contentContainerStyle={styles.gridContent}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={colors.textSecondary}
          onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
        />
      }
      ListHeaderComponent={
        <View style={styles.myShopHeader}>
          <View style={styles.myShopTitleRow}>
            {editing ? (
              <View style={[styles.flex, styles.editWrap]}>
                <TextInput
                  style={styles.input}
                  placeholder={t('shop.namePlaceholder')}
                  placeholderTextColor={colors.textTertiary}
                  value={editName}
                  onChangeText={setEditName}
                  maxLength={60}
                  autoFocus
                />
                <TextInput
                  style={[styles.input, styles.inputMultiline]}
                  placeholder={t('shop.bioPlaceholder')}
                  placeholderTextColor={colors.textTertiary}
                  value={editBio}
                  onChangeText={setEditBio}
                  multiline
                  maxLength={300}
                />
                <View style={styles.editActions}>
                  <TouchableOpacity style={styles.editCancelBtn} onPress={() => setEditing(false)} disabled={savingEdit}>
                    <Text style={styles.editCancelText}>{t('common.cancel')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.editSaveBtn, (!editName.trim() || savingEdit) && { opacity: 0.5 }]}
                    onPress={saveEdit}
                    disabled={!editName.trim() || savingEdit}
                  >
                    {savingEdit
                      ? <ActivityIndicator color="#fff" size="small" />
                      : <Text style={styles.editSaveText}>{t('shop.saveListing')}</Text>}
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <TouchableOpacity style={styles.flex} onPress={startEdit} activeOpacity={0.7}>
                <Text style={styles.myShopName}>{shop.name}</Text>
                <Text style={styles.myShopBio} numberOfLines={2}>
                  {shop.bio || t('shop.bioPlaceholder')}
                </Text>
              </TouchableOpacity>
            )}
            <View style={styles.openRow}>
              <Text style={styles.openLabel}>{shop.is_open ? t('shop.open') : t('shop.closed')}</Text>
              <Switch
                value={shop.is_open}
                onValueChange={async (v) => {
                  setShop({ ...shop, is_open: v });
                  await updateShop({ is_open: v }).catch(() => setShop(shop));
                }}
                trackColor={{ true: colors.success, false: colors.surfaceLight }}
                thumbColor="#fff"
              />
            </View>
          </View>
          {/* At-a-glance seller stats — active listings, copies sold, take-home. */}
          <View style={styles.statsRow}>
            <View style={styles.statCell}>
              <Text style={styles.statValue}>{listings.filter((l) => l.status === 'active').length}</Text>
              <Text style={styles.statLabel}>{t('shop.statsActive')}</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statCell}>
              <Text style={styles.statValue}>{listings.reduce((s, l) => s + l.sales_count, 0)}</Text>
              <Text style={styles.statLabel}>{t('shop.statsSold')}</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statCell}>
              {/* Zero earnings say "None" — formatPrice(0) says "FREE", which
                  reads like a price, not a total. Green only once real. */}
              <Text style={[styles.statValue, earnedCents > 0 && { color: colors.success }]}>
                {earnedCents > 0 ? formatPrice(earnedCents) : t('shop.earnedNone')}
              </Text>
              <Text style={styles.statLabel}>{t('shop.statsEarned')}</Text>
            </View>
          </View>
          <TouchableOpacity style={styles.greenBtn} onPress={() => router.push('/shop/new-listing')} activeOpacity={0.85}>
            <Ionicons name="add" size={18} color="#fff" />
            <Text style={styles.greenBtnText}>{t('shop.newListing')}</Text>
          </TouchableOpacity>
        </View>
      }
      renderItem={({ item }) => (
        <ShopListingCard listing={item} showSeller={false} onPress={() => router.push(`/shop/listing/${item.id}`)} />
      )}
      ListEmptyComponent={<Text style={styles.emptyText}>{t('shop.noListings')}</Text>}
    />
  );
}

// --- Orders ----------------------------------------------------------------------

function OrdersTab({ onChanged }: { onChanged?: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const [sales, setSales] = useState<ShopOrder[]>([]);
  const [purchases, setPurchases] = useState<ShopOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([fetchMySales(), fetchMyPurchases()]);
      setSales(s);
      setPurchases(p);
      // Looking at the Orders tab IS seeing the outcomes — snapshot them so the
      // profile Shop button's red alert dot clears (pending sale requests keep
      // counting there until actually delivered/declined).
      markShopOrdersSeen([...s, ...p]).catch(() => {});
    } catch { /* pre-migration */ }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  // Tap the counterparty's name → their shop, or their profile when they don't
  // have one set up (buyers often won't) — so a seller can see who they're
  // selling to in one tap.
  async function openCounterparty(p?: SellerProfile) {
    if (!p?.id) return;
    const shopOpen = await hasOpenShop(p.id).catch(() => false);
    router.push(shopOpen ? `/shop/${p.id}` : `/profile/${p.id}`);
  }

  async function act(order: ShopOrder, status: 'delivered' | 'declined') {
    setSales((prev) => prev.map((o) => (o.id === order.id ? { ...o, status } : o)));
    if (status === 'delivered') {
      reactionPop(); // a sale closing deserves a tick
      // Delivering also DMs the buyer that their file is unlocked — the same
      // channel their buy request opened.
      await deliverOrder(order, t('shop.deliveredDm', { title: order.listing?.title ?? '' })).catch(() => load());
    } else {
      await setOrderStatus(order.id, status).catch(() => load());
    }
    onChanged?.(); // keep the Orders-tab badge honest
  }

  if (loading) return <ListRowsSkeleton rows={6} />;

  const sections: { title: string; orders: ShopOrder[]; sale: boolean }[] = [
    { title: t('shop.sales'), orders: sales, sale: true },
    { title: t('shop.purchases'), orders: purchases, sale: false },
  ];

  return (
    <ScrollView
      contentContainerStyle={styles.ordersContent}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={colors.textSecondary}
          onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
        />
      }
    >
      {sections.map((section) => (
        <View key={section.title} style={styles.orderSection}>
          <Text style={styles.sectionTitle}>{section.title}</Text>
          {section.orders.length === 0 && <Text style={styles.emptyText}>{t('shop.noOrders')}</Text>}
          {section.orders.map((o) => {
            const other = section.sale ? o.buyer : o.seller;
            const name = other?.display_name || other?.username || '';
            return (
              <TouchableOpacity
                key={o.id}
                style={styles.orderRow}
                activeOpacity={0.8}
                onPress={() => router.push(`/shop/listing/${o.listing_id}`)}
              >
                {o.listing?.cover_url ? (
                  <Image source={{ uri: o.listing.cover_url }} style={styles.orderCover} />
                ) : (
                  <View style={[styles.orderCover, styles.orderCoverFallback]}>
                    <Ionicons name="musical-note" size={18} color="#888" />
                  </View>
                )}
                <View style={styles.flex}>
                  <Text style={styles.orderTitle} numberOfLines={1}>{o.listing?.title ?? '—'}</Text>
                  <Text style={styles.orderMeta} numberOfLines={1}>
                    {!!name && (
                      // Nested pressable span: tapping the NAME opens the person
                      // (shop or profile); the rest of the row still opens the
                      // listing.
                      <Text style={styles.orderMetaName} suppressHighlighting onPress={() => openCounterparty(other)}>
                        {name}
                      </Text>
                    )}
                    {name ? ' · ' : ''}{formatPrice(o.price_cents, o.currency)}
                    {o.kind ? ` · ${t(`shop.kind.${o.kind}`)}` : ''} · {t(`shop.status.${o.status}`)}
                  </Text>
                </View>
                {section.sale && o.status === 'requested' ? (
                  <View style={styles.orderActions}>
                    {/* Accepting an OFFER = selling the beat outright at the
                        buyer's price (delivers + marks the listing sold). */}
                    <TouchableOpacity style={styles.deliverBtn} onPress={() => act(o, 'delivered')}>
                      <Text style={styles.deliverBtnText}>
                        {o.kind === 'offer' ? t('shop.acceptOffer') : t('shop.deliver')}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.declineBtn} onPress={() => act(o, 'declined')}>
                      <Text style={styles.declineBtnText}>{t('shop.decline')}</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <Ionicons
                    name={o.status === 'delivered' ? 'checkmark-circle' : o.status === 'refunded' ? 'arrow-undo-circle-outline' : 'time-outline'}
                    size={20}
                    color={o.status === 'delivered' ? '#22C55E' : '#888'}
                  />
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      ))}
    </ScrollView>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.background },
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', color: c.text, fontSize: 17, fontWeight: '700' },
  cartBadge: {
    position: 'absolute', top: 4, right: 3, minWidth: 15, height: 15, borderRadius: 7.5,
    paddingHorizontal: 3, backgroundColor: c.success, alignItems: 'center', justifyContent: 'center',
  },
  cartBadgeText: { color: '#fff', fontSize: 9, fontWeight: '800' },
  segment: {
    flexDirection: 'row', marginHorizontal: SPACING.md, marginTop: 4, marginBottom: 10,
    backgroundColor: c.surfaceLight, borderRadius: RADIUS.full, padding: 3,
  },
  segmentBtn: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: RADIUS.full },
  segmentBtnActive: { backgroundColor: c.surfaceElevated },
  segmentInner: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  segmentText: { color: c.textTertiary, fontSize: 13, fontWeight: '600' },
  segmentTextActive: { color: c.text },
  segmentBadge: { backgroundColor: c.success, borderRadius: RADIUS.full, minWidth: 16, height: 16, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  segmentBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  sortChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    borderRadius: RADIUS.full, backgroundColor: c.surfaceLight,
    paddingHorizontal: 12, paddingVertical: 6,
  },
  sortChipText: { color: c.text, fontSize: 12, fontWeight: '600' },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: SPACING.md, marginBottom: 8,
    backgroundColor: c.surfaceLight, borderRadius: RADIUS.md, paddingHorizontal: 12,
  },
  searchInput: { flex: 1, color: c.text, fontSize: 14, paddingVertical: 10 },
  chipRow: { flexGrow: 0, marginBottom: 8 },
  chipRowContent: { paddingHorizontal: SPACING.md, gap: 8 },
  chip: {
    borderRadius: RADIUS.full, borderWidth: 1, borderColor: c.border,
    paddingHorizontal: 12, paddingVertical: 6,
  },
  chipActive: { backgroundColor: c.text, borderColor: c.text },
  chipText: { color: c.textSecondary, fontSize: 12, fontWeight: '600' },
  chipTextActive: { color: c.background },
  gridRow: { gap: 12, paddingHorizontal: SPACING.md },
  gridContent: { gap: 14, paddingBottom: 40 },
  emptyText: { color: c.textTertiary, fontSize: 13, textAlign: 'center', marginTop: 26, paddingHorizontal: 30 },
  // Create shop
  createWrap: { alignItems: 'center', paddingHorizontal: SPACING.lg, paddingTop: 30, gap: 10 },
  agreeCard: {
    alignSelf: 'stretch', backgroundColor: c.surface, borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, padding: 14, gap: 8,
  },
  agreeTitle: { color: c.text, fontSize: 13, fontWeight: '700' },
  agreeRow: { flexDirection: 'row', gap: 8 },
  agreeBullet: { color: c.textTertiary, fontSize: 12, lineHeight: 17 },
  agreeText: { flex: 1, color: c.textSecondary, fontSize: 12, lineHeight: 17 },
  agreeCheckRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 4 },
  agreeCheckText: { flex: 1, color: c.text, fontSize: 12.5, lineHeight: 18 },
  agreeLink: { color: c.primary, fontWeight: '600' },
  createTitle: { color: c.text, fontSize: 18, fontWeight: '800', marginTop: 4 },
  createSub: { color: c.textTertiary, fontSize: 13, textAlign: 'center', lineHeight: 19, marginBottom: 8 },
  input: {
    alignSelf: 'stretch', backgroundColor: c.surfaceLight, borderRadius: RADIUS.md,
    paddingHorizontal: 14, paddingVertical: 12, color: c.text, fontSize: 15,
  },
  inputMultiline: { minHeight: 76, textAlignVertical: 'top' },
  greenBtn: {
    alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    backgroundColor: c.success, borderRadius: RADIUS.full, paddingVertical: 13, marginTop: 4,
  },
  greenBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  // My shop header
  myShopHeader: { paddingHorizontal: 0, gap: 12, marginBottom: 6, paddingTop: 2 },
  myShopTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: SPACING.md },
  myShopName: { color: c.text, fontSize: 17, fontWeight: '800' },
  myShopBio: { color: c.textTertiary, fontSize: 12, marginTop: 2 },
  statsRow: {
    flexDirection: 'row', alignItems: 'center', marginHorizontal: SPACING.md,
    backgroundColor: c.surface, borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, paddingVertical: 10,
  },
  statCell: { flex: 1, alignItems: 'center', gap: 2 },
  statValue: { color: c.text, fontSize: 15, fontWeight: '800' },
  statLabel: { color: c.textTertiary, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  statDivider: { width: StyleSheet.hairlineWidth, alignSelf: 'stretch', backgroundColor: c.border },
  editWrap: { gap: 8 },
  editActions: { flexDirection: 'row', gap: 8 },
  editCancelBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.border, borderRadius: RADIUS.full, paddingVertical: 10 },
  editCancelText: { color: c.textSecondary, fontSize: 13, fontWeight: '600' },
  editSaveBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.success, borderRadius: RADIUS.full, paddingVertical: 10 },
  editSaveText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  openRow: { alignItems: 'center', gap: 2 },
  openLabel: { color: c.textTertiary, fontSize: 11, fontWeight: '600' },
  // Orders
  ordersContent: { paddingHorizontal: SPACING.md, paddingBottom: 40, gap: 18 },
  orderSection: { gap: 10 },
  sectionTitle: { color: c.text, fontSize: 15, fontWeight: '800' },
  orderRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: c.surface, borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, padding: 10,
  },
  orderCover: { width: 44, height: 44, borderRadius: RADIUS.sm, backgroundColor: c.surfaceLight },
  orderCoverFallback: { alignItems: 'center', justifyContent: 'center' },
  orderTitle: { color: c.text, fontSize: 13, fontWeight: '700' },
  orderMeta: { color: c.textTertiary, fontSize: 12, marginTop: 1 },
  // The tappable counterparty name inside the meta line — brighter + bolder so
  // it reads as a link to their shop/profile.
  orderMetaName: { color: c.text, fontWeight: '700' },
  orderActions: { gap: 6 },
  deliverBtn: { backgroundColor: c.success, borderRadius: RADIUS.sm, paddingHorizontal: 10, paddingVertical: 5 },
  deliverBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  declineBtn: { borderWidth: 1, borderColor: c.border, borderRadius: RADIUS.sm, paddingHorizontal: 10, paddingVertical: 5, alignItems: 'center' },
  declineBtnText: { color: c.textSecondary, fontSize: 12, fontWeight: '600' },
});
