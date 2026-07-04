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
import { RADIUS, SPACING, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { useProfile } from '../../contexts/ProfileContext';
import {
  LISTING_CATEGORIES, createShop, exploreListings, fetchMyPurchases, fetchMySales,
  fetchSellerListings, formatPrice, getShop, setOrderStatus, updateShop,
  type ListingCategory, type Shop, type ShopListing, type ShopOrder,
} from '../../lib/shop';

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

  return (
    <SwipeBackPager>
      <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('shop.title')}</Text>
          <View style={styles.headerBtn} />
        </View>

        {/* Segmented tabs */}
        <View style={styles.segment}>
          {(['explore', 'mine', 'orders'] as Tab[]).map((k) => (
            <TouchableOpacity
              key={k}
              style={[styles.segmentBtn, tab === k && styles.segmentBtnActive]}
              onPress={() => setTab(k)}
            >
              <Text style={[styles.segmentText, tab === k && styles.segmentTextActive]}>
                {t(`shop.tab.${k}`)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {tab === 'explore' && <ExploreTab />}
        {tab === 'mine' && <MyShopTab myId={profile?.id ?? null} />}
        {tab === 'orders' && <OrdersTab />}
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
  const [listings, setListings] = useState<ShopListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (term: string, cat: ListingCategory | null) => {
    try { setListings(await exploreListings({ search: term, category: cat })); }
    catch { /* pre-migration */ }
    setLoading(false);
  }, []);

  // Debounced search + instant category filter.
  useEffect(() => {
    const timer = setTimeout(() => load(search, category), search ? 350 : 0);
    return () => clearTimeout(timer);
  }, [search, category, load]);

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
              onRefresh={async () => { setRefreshing(true); await load(search, category); setRefreshing(false); }}
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

function MyShopTab({ myId }: { myId: string | null }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const [shop, setShop] = useState<Shop | null>(null);
  const [listings, setListings] = useState<ShopListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!myId) return;
    try {
      const s = await getShop(myId);
      setShop(s);
      if (s) setListings(await fetchSellerListings(myId, true));
    } catch { /* pre-migration */ }
    setLoading(false);
  }, [myId]);
  useEffect(() => { load(); }, [load]);

  async function openShop() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await createShop(name, bio);
      await load();
    } catch { /* surfaced by empty state */ }
    setBusy(false);
  }

  if (loading) return <ListRowsSkeleton rows={5} />;

  if (!shop) {
    return (
      <ScrollView contentContainerStyle={styles.createWrap} keyboardShouldPersistTaps="handled">
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
        <TouchableOpacity
          style={[styles.greenBtn, !name.trim() && { opacity: 0.5 }]}
          onPress={openShop}
          disabled={!name.trim() || busy}
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
      ListHeaderComponent={
        <View style={styles.myShopHeader}>
          <View style={styles.myShopTitleRow}>
            <View style={styles.flex}>
              <Text style={styles.myShopName}>{shop.name}</Text>
              {!!shop.bio && <Text style={styles.myShopBio} numberOfLines={2}>{shop.bio}</Text>}
            </View>
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

function OrdersTab() {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const router = useRouter();
  const [sales, setSales] = useState<ShopOrder[]>([]);
  const [purchases, setPurchases] = useState<ShopOrder[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([fetchMySales(), fetchMyPurchases()]);
      setSales(s);
      setPurchases(p);
    } catch { /* pre-migration */ }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function act(order: ShopOrder, status: 'delivered' | 'declined') {
    setSales((prev) => prev.map((o) => (o.id === order.id ? { ...o, status } : o)));
    await setOrderStatus(order.id, status).catch(() => load());
  }

  if (loading) return <ListRowsSkeleton rows={6} />;

  const sections: { title: string; orders: ShopOrder[]; sale: boolean }[] = [
    { title: t('shop.sales'), orders: sales, sale: true },
    { title: t('shop.purchases'), orders: purchases, sale: false },
  ];

  return (
    <ScrollView contentContainerStyle={styles.ordersContent}>
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
                    {name} · {formatPrice(o.price_cents, o.currency)} · {t(`shop.status.${o.status}`)}
                  </Text>
                </View>
                {section.sale && o.status === 'requested' ? (
                  <View style={styles.orderActions}>
                    <TouchableOpacity style={styles.deliverBtn} onPress={() => act(o, 'delivered')}>
                      <Text style={styles.deliverBtnText}>{t('shop.deliver')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.declineBtn} onPress={() => act(o, 'declined')}>
                      <Text style={styles.declineBtnText}>{t('shop.decline')}</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <Ionicons
                    name={o.status === 'delivered' ? 'checkmark-circle' : 'time-outline'}
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
  segment: {
    flexDirection: 'row', marginHorizontal: SPACING.md, marginTop: 4, marginBottom: 10,
    backgroundColor: c.surfaceLight, borderRadius: RADIUS.full, padding: 3,
  },
  segmentBtn: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: RADIUS.full },
  segmentBtnActive: { backgroundColor: c.surfaceElevated },
  segmentText: { color: c.textTertiary, fontSize: 13, fontWeight: '600' },
  segmentTextActive: { color: c.text },
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
  orderActions: { gap: 6 },
  deliverBtn: { backgroundColor: c.success, borderRadius: RADIUS.sm, paddingHorizontal: 10, paddingVertical: 5 },
  deliverBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  declineBtn: { borderWidth: 1, borderColor: c.border, borderRadius: RADIUS.sm, paddingHorizontal: 10, paddingVertical: 5, alignItems: 'center' },
  declineBtnText: { color: c.textSecondary, fontSize: 12, fontWeight: '600' },
});
