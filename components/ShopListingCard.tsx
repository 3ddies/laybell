import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { listingPriceLabel, type ShopListing } from '../lib/shop';

// One marketplace tile — used by Explore, seller shops, and My Shop grids.
// Two-column grid; the price rides the cover like a marketplace tag.

export default function ShopListingCard({
  listing,
  onPress,
  showSeller = true,
}: {
  listing: ShopListing;
  onPress: () => void;
  showSeller?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const sellerName = listing.seller?.display_name || listing.seller?.username || '';

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.85}>
      <View style={styles.coverWrap}>
        {listing.cover_url ? (
          <Image source={{ uri: listing.cover_url }} style={styles.cover} />
        ) : (
          <View style={[styles.cover, styles.coverFallback]}>
            <Ionicons name="musical-note" size={30} color={colors.textTertiary} />
          </View>
        )}
        {/* Cheapest way in, "+" when the listing offers more than one deal. */}
        <View style={styles.priceTag}>
          <Text style={styles.priceText}>{listingPriceLabel(listing, t('shop.free'))}</Text>
        </View>
        {listing.status !== 'active' && (
          <View style={styles.statusScrim}>
            <Text style={styles.statusText}>
              {listing.status === 'sold' ? t('shop.sold') : t('shop.paused')}
            </Text>
          </View>
        )}
      </View>
      <Text style={styles.title} numberOfLines={1}>{listing.title}</Text>
      <Text style={styles.meta} numberOfLines={1}>
        {t(`shop.category.${listing.category}`)}
        {showSeller && sellerName ? ` · ${sellerName}` : listing.genre ? ` · ${listing.genre}` : ''}
      </Text>
    </TouchableOpacity>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  card: { flex: 1, gap: 4 },
  coverWrap: { borderRadius: RADIUS.md, overflow: 'hidden', aspectRatio: 1, backgroundColor: c.surfaceLight },
  cover: { width: '100%', height: '100%' },
  coverFallback: { alignItems: 'center', justifyContent: 'center' },
  priceTag: {
    position: 'absolute', left: 8, bottom: 8,
    backgroundColor: c.success, borderRadius: RADIUS.sm,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  priceText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  statusScrim: {
    ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center',
  },
  statusText: { color: '#fff', fontSize: 13, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' },
  title: { color: c.text, fontSize: 13, fontWeight: '600', marginTop: 2 },
  meta: { color: c.textTertiary, fontSize: 11 },
});
