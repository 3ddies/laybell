import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

// A white "info" pill shared by the time / temperature / location stickers — an icon
// plus a short captured value (the time it was placed, the temperature, the place).
// Instagram location/time-chip style. Pure presentation.
export function InfoStickerContent({ icon, text }: { icon: keyof typeof Ionicons.glyphMap; text?: string }) {
  return (
    <View style={styles.chip}>
      <Ionicons name={icon} size={16} color="#0A0A0A" />
      <Text style={styles.text} numberOfLines={1}>{text || ''}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#fff', paddingHorizontal: 13, paddingVertical: 8, borderRadius: 999, maxWidth: 300,
    shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 4,
  },
  text: { color: '#0A0A0A', fontWeight: '700', fontSize: 15 },
});
