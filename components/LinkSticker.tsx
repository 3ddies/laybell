import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

// The visual for a 'link' story sticker — an Instagram-style tappable chip. Shared
// by the composer (drawn via StickerLayer's renderKind, non-interactive) and the
// story viewer (wrapped in a Touchable that opens the link through the safety
// interstitial), so a link sticker looks identical where it's placed and where it's
// seen. Pure presentation: no gestures, no navigation.

/** Human label for a link chip: the title if given, else a tidied URL. */
export function linkLabel(url: string, title?: string): string {
  if (title && title.trim()) return title.trim();
  const s = (url || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '');
  return s.length > 32 ? s.slice(0, 31) + '…' : s || 'Link';
}

export function LinkStickerContent({ url, title }: { url: string; title?: string }) {
  return (
    <View style={styles.chip}>
      <Ionicons name="link" size={16} color="#0A0A0A" />
      <Text style={styles.text} numberOfLines={1}>{linkLabel(url, title)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#fff',
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 999,
    maxWidth: 280,
    // Reads on bright or dark media.
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  text: { color: '#0A0A0A', fontWeight: '700', fontSize: 15 },
});
