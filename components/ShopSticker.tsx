import { View, Text, StyleSheet } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';

// The visual for a 'shop' story sticker — the same square album-art look as the music
// sticker, but showing a shop listing's cover with a "Shop" badge (so it clearly reads
// as a product, not a song) and the title + price beneath. Shared by the composer
// (via StickerLayer's renderKind) and the viewer (tap opens the listing).
export function ShopStickerContent({ title, price, cover }: { title?: string; price?: string; cover?: string | null }) {
  return (
    <View style={styles.wrap}>
      <View>
        {cover ? (
          <ExpoImage source={{ uri: cover }} style={styles.cover} contentFit="cover" />
        ) : (
          <View style={[styles.cover, styles.coverFallback]}>
            <Ionicons name="bag-handle" size={38} color="#fff" />
          </View>
        )}
        {/* The "this is a product" marker — distinguishes it from a music sticker. */}
        <View style={styles.badge}>
          <Ionicons name="bag-handle" size={11} color="#fff" />
          <Text style={styles.badgeText}>Shop</Text>
        </View>
      </View>
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>{title || 'Shop item'}</Text>
        {!!price && <Text style={styles.price} numberOfLines={1}>{price}</Text>}
      </View>
    </View>
  );
}

const SHADOW = { shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 5 } as const;
const TEXT_SHADOW = { textShadowColor: 'rgba(0,0,0,0.5)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 } as const;

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', maxWidth: 200 },
  cover: { width: 158, height: 158, borderRadius: 8, ...SHADOW },
  coverFallback: { backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute', top: 8, left: 8, flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: '#F26522', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4,
  },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 0.3 },
  text: { marginTop: 9, alignItems: 'center', maxWidth: 190 },
  title: { color: '#fff', fontWeight: '800', fontSize: 15, textAlign: 'center', ...TEXT_SHADOW },
  price: { color: 'rgba(255,255,255,0.92)', fontWeight: '700', fontSize: 13, textAlign: 'center', marginTop: 2, ...TEXT_SHADOW },
});
