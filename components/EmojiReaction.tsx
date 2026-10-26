import { View, Text, StyleSheet } from 'react-native';

// Emoji reaction sticker: a single emoji in a soft circle. In the viewer it's wrapped in
// a Touchable that likes the story and comments the emoji. Pure presentation.
export function EmojiReactionContent({ emoji, compact }: { emoji?: string; compact?: boolean }) {
  const size = compact ? 40 : 66;
  return (
    <View style={[styles.wrap, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={{ fontSize: size * 0.6 }}>{emoji || '❤️'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.3)',
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.7)',
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 4,
  },
});
