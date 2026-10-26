import { View, Text, StyleSheet } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';

export type MusicStickerStyle = 'card' | 'square';

// The visual for a 'music' story sticker — Instagram-style. Two looks the user cycles
// by tapping the sticker: a horizontal 'card' (cover + title + artist) and a 'square'
// album-art tile with the title + artist centered beneath the cover. Shared by the
// composer (drawn via StickerLayer's renderKind) and the story viewer, so it's
// identical where it's placed and watched. The song plays as the story's audio; this
// is pure presentation.
export function MusicStickerContent({
  title, artist, cover, variant = 'card',
}: { title?: string; artist?: string; cover?: string | null; variant?: MusicStickerStyle }) {
  if (variant === 'square') {
    return (
      <View style={styles.squareWrap}>
        {cover ? (
          <ExpoImage source={{ uri: cover }} style={styles.squareCover} contentFit="cover" />
        ) : (
          <View style={[styles.squareCover, styles.coverFallback]}>
            <Ionicons name="musical-notes" size={40} color="#fff" />
          </View>
        )}
        <View style={styles.squareText}>
          <Text style={styles.squareTitle} numberOfLines={1}>{title || 'Audio'}</Text>
          {!!artist && <Text style={styles.squareArtist} numberOfLines={1}>{artist}</Text>}
        </View>
      </View>
    );
  }
  return (
    <View style={styles.card}>
      {cover ? (
        <ExpoImage source={{ uri: cover }} style={styles.cover} contentFit="cover" />
      ) : (
        <View style={[styles.cover, styles.coverFallback]}>
          <Ionicons name="musical-notes" size={16} color="#fff" />
        </View>
      )}
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>{title || 'Audio'}</Text>
        {!!artist && <Text style={styles.artist} numberOfLines={1}>{artist}</Text>}
      </View>
      <Ionicons name="musical-note" size={15} color="rgba(255,255,255,0.85)" />
    </View>
  );
}

const SHADOW = { shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 5 } as const;
const TEXT_SHADOW = { textShadowColor: 'rgba(0,0,0,0.5)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 } as const;

const styles = StyleSheet.create({
  // Horizontal card
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 9,
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 14,
    paddingLeft: 6, paddingRight: 12, paddingVertical: 6, maxWidth: 260,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.22)', ...SHADOW,
  },
  cover: { width: 38, height: 38, borderRadius: 9 },
  title: { color: '#fff', fontWeight: '800', fontSize: 14 },
  artist: { color: 'rgba(255,255,255,0.7)', fontWeight: '600', fontSize: 12, marginTop: 1 },
  // Square album-art tile: lightly-rounded cover with centered title/artist beneath it.
  squareWrap: { alignItems: 'center', maxWidth: 200 },
  squareCover: { width: 158, height: 158, borderRadius: 8, ...SHADOW },
  squareText: { marginTop: 9, alignItems: 'center', maxWidth: 190 },
  squareTitle: { color: '#fff', fontWeight: '800', fontSize: 15, textAlign: 'center', ...TEXT_SHADOW },
  squareArtist: { color: 'rgba(255,255,255,0.88)', fontWeight: '600', fontSize: 12.5, textAlign: 'center', marginTop: 2, ...TEXT_SHADOW },
  // Shared
  coverFallback: { backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' },
  text: { flexShrink: 1 },
});
