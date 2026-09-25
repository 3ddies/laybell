import { View, Text, StyleSheet } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTranslation } from '../contexts/LanguageContext';
import type { CompositionKind } from '../lib/composition';

// A small "Remix" pill for the FEED and REEL cards. Those surfaces keep their
// pooled, idle-aware players (FeedVideo/ReelVideo) and show only the creator's
// own clip — this pill marks the post as a remix so it reads right, and opening
// the post shows the two composed (CompositionPlayer). The native follow-up bakes
// the composite into one file, at which point every surface plays it composed for
// free and this pill can come off.
const ICON: Record<CompositionKind, keyof typeof MaterialCommunityIcons.glyphMap> = {
  pip: 'picture-in-picture-top-right',
  pip_flip: 'picture-in-picture-top-right',
  side_by_side: 'view-split-vertical',
  top_bottom: 'view-split-horizontal',
  green_screen: 'image-multiple-outline',
  add: 'ray-start-arrow',
};

export default function CompositionBadge({ kind, style }: { kind: CompositionKind; style?: any }) {
  const { t } = useTranslation();
  return (
    <View style={[styles.pill, style]} pointerEvents="none">
      <MaterialCommunityIcons name={ICON[kind] ?? 'view-split-vertical'} size={12} color="#fff" />
      <Text style={styles.text}>{t('remix.title')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 999,
    paddingHorizontal: 9, paddingVertical: 4,
  },
  text: { color: '#fff', fontSize: 11, fontWeight: '700' },
});
