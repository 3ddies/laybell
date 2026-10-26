import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

// The visual for a 'community' story sticker — a white pill with a people glyph and the
// community name (Instagram location/mention-chip style). Shared by the composer (drawn
// via StickerLayer's renderKind) and the viewer (wrapped in a Touchable that opens the
// community). Pure presentation.
export function CommunityStickerContent({ name }: { name?: string }) {
  return (
    <View style={styles.chip}>
      <Ionicons name="people" size={16} color="#0A0A0A" />
      <Text style={styles.text} numberOfLines={1}>{name || 'Community'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#fff', paddingHorizontal: 13, paddingVertical: 8, borderRadius: 999, maxWidth: 280,
    shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 4,
  },
  text: { color: '#0A0A0A', fontWeight: '700', fontSize: 15 },
});
