import { View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../constants/theme';

// Subtle yellow sparkle in a thumbnail's top-right corner, marking a post that
// has a LIVE spotlight. Icon only — no "Spotlight" word (that fuller badge lives
// in the feed/viewer header). Sits over media, so it's theme-independent: a faint
// dark disc keeps the sparkle readable on bright and dark thumbnails alike.
export default function SpotlightThumbBadge() {
  return (
    <View style={styles.wrap} pointerEvents="none">
      <Ionicons name="sparkles" size={11} color={COLORS.primaryLight} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute', top: 6, right: 6,
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center', justifyContent: 'center',
  },
});
