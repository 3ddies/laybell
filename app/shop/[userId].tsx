import { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList, Image, RefreshControl } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import SwipeBackPager from '../../components/SwipeBackPager';
import ShopListingCard from '../../components/ShopListingCard';
import { GridSkeleton } from '../../components/Skeleton';
import { GRADIENTS, RADIUS, SPACING, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { supabase } from '../../lib/supabase';
import { fetchSellerListings, getShop, type Shop, type ShopListing } from '../../lib/shop';

// A specific seller's storefront — opened from the green Shop button on their
// profile. Header shows the shop identity; the grid is their active listings.

export default function SellerShopScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { userId } = useLocalSearchParams<{ userId: string }>();

  const [shop, setShop] = useState<Shop | null>(null);
  const [seller, setSeller] = useState<{ username: string | null; display_name: string | null; avatar_url: string | null } | null>(null);
  const [listings, setListings] = useState<ShopListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!userId) return;
    try {
      const [s, l, { data: p }] = await Promise.all([
        getShop(userId),
        fetchSellerListings(userId),
        supabase.from('profiles').select('username, display_name, avatar_url').eq('id', userId).maybeSingle(),
      ]);
      setShop(s);
      setListings(l);
      setSeller(p ?? null);
    } catch { /* pre-migration */ }
    setLoading(false);
  }, [userId]);
  useEffect(() => { load(); }, [load]);

  const name = seller?.display_name || seller?.username || '';

  return (
    <SwipeBackPager>
      <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle} numberOfLines={1}>{shop?.name ?? t('shop.title')}</Text>
          <View style={styles.headerBtn} />
        </View>

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
                onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
              />
            }
            ListHeaderComponent={
              <TouchableOpacity
                style={styles.sellerRow}
                onPress={() => router.push(`/profile/${userId}`)}
                activeOpacity={0.8}
              >
                {seller?.avatar_url ? (
                  <Image source={{ uri: seller.avatar_url }} style={styles.avatar} />
                ) : (
                  <LinearGradient colors={GRADIENTS.primary} style={styles.avatar}>
                    <Text style={styles.avatarInitial}>{(name || '?').charAt(0).toUpperCase()}</Text>
                  </LinearGradient>
                )}
                <View style={styles.flex}>
                  <Text style={styles.sellerName}>{name}</Text>
                  {!!shop?.bio && <Text style={styles.sellerBio} numberOfLines={2}>{shop.bio}</Text>}
                </View>
              </TouchableOpacity>
            }
            renderItem={({ item }) => (
              <ShopListingCard listing={item} showSeller={false} onPress={() => router.push(`/shop/listing/${item.id}`)} />
            )}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Ionicons name="storefront-outline" size={40} color={colors.textTertiary} />
                <Text style={styles.emptyText}>{shop ? t('shop.noListings') : t('shop.noShop')}</Text>
              </View>
            }
          />
        )}
      </View>
    </SwipeBackPager>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.background },
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, gap: 6 },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', color: c.text, fontSize: 17, fontWeight: '700' },
  gridRow: { gap: 12, paddingHorizontal: SPACING.md },
  gridContent: { gap: 14, paddingBottom: 40 },
  sellerRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginHorizontal: SPACING.md, marginBottom: 8,
    backgroundColor: c.surface, borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, padding: 10,
  },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarInitial: { color: '#fff', fontSize: 17, fontWeight: '700' },
  sellerName: { color: c.text, fontSize: 14, fontWeight: '700' },
  sellerBio: { color: c.textTertiary, fontSize: 12, marginTop: 2 },
  empty: { alignItems: 'center', gap: 10, marginTop: 30 },
  emptyText: { color: c.textTertiary, fontSize: 13 },
});
