import { Image as ExpoImage } from 'expo-image';
import { ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { SPACING } from '../constants/theme';

// The background BEHIND a reshared post in the Post-to-story editor. The default is
// the post's own still, blurred edge-to-edge (Instagram's look); the picker also
// offers solid colours and gradients. Stored in the stories.stickers jsonb as a
// single { kind:'bg', bg } layer (no schema change), so absent = the blurred default
// and every existing repost keeps rendering exactly as before.

export type StoryBg =
  | { type: 'blur' }
  | { type: 'color'; color: string }
  | { type: 'gradient'; colors: [string, string] };

export const DEFAULT_BG: StoryBg = { type: 'blur' };

// Curated palette: the blurred default, a few solids, then gradients (brand first).
export const BG_PRESETS: StoryBg[] = [
  { type: 'blur' },
  { type: 'color', color: '#000000' },
  { type: 'color', color: '#FFFFFF' },
  { type: 'color', color: '#F26522' },
  { type: 'color', color: '#0A0A0A' },
  { type: 'color', color: '#1E293B' },
  { type: 'gradient', colors: ['#F26522', '#FAB525'] },
  { type: 'gradient', colors: ['#F43F5E', '#A855F7'] },
  { type: 'gradient', colors: ['#3B82F6', '#22D3EE'] },
  { type: 'gradient', colors: ['#A855F7', '#3B82F6'] },
  { type: 'gradient', colors: ['#22C55E', '#3B82F6'] },
  { type: 'gradient', colors: ['#0F172A', '#334155'] },
];

function bgKey(b: StoryBg): string {
  return b.type === 'blur' ? 'blur' : b.type === 'color' ? `c:${b.color}` : `g:${b.colors.join(',')}`;
}

// Full-screen static background — used by the editor (behind the post) and the story
// viewer. `backdropUri` is the post's still, used for the blurred default.
export function StoryBackground({ bg, backdropUri }: { bg?: StoryBg | null; backdropUri?: string | null }) {
  const b = bg ?? DEFAULT_BG;
  if (b.type === 'color') {
    return <View style={[StyleSheet.absoluteFill, { backgroundColor: b.color }]} pointerEvents="none" />;
  }
  if (b.type === 'gradient') {
    return (
      <LinearGradient
        colors={b.colors}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
    );
  }
  // blur (default)
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {backdropUri ? (
        <ExpoImage source={{ uri: backdropUri }} style={StyleSheet.absoluteFill} contentFit="cover" blurRadius={30} cachePolicy="memory-disk" />
      ) : (
        <LinearGradient colors={['#1b1b1d', '#000']} style={StyleSheet.absoluteFill} />
      )}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.5)' }]} />
    </View>
  );
}

// A single swatch in the picker rail.
function Swatch({ bg, backdropUri, active, onPress }: { bg: StoryBg; backdropUri?: string | null; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={[styles.swatch, active && styles.swatchActive]}>
      {bg.type === 'blur' ? (
        backdropUri ? (
          <ExpoImage source={{ uri: backdropUri }} style={StyleSheet.absoluteFill} contentFit="cover" blurRadius={8} cachePolicy="memory-disk" />
        ) : (
          <LinearGradient colors={['#334155', '#0F172A']} style={StyleSheet.absoluteFill} />
        )
      ) : bg.type === 'gradient' ? (
        <LinearGradient colors={bg.colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      ) : (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: bg.color }]} />
      )}
      {bg.type === 'blur' && (
        <View style={styles.blurBadge}><Ionicons name="image" size={13} color="#fff" /></View>
      )}
    </TouchableOpacity>
  );
}

// The horizontal picker rail shown when the background tool is open.
export function StoryBackgroundPicker({ value, onChange, backdropUri }: {
  value: StoryBg;
  onChange: (b: StoryBg) => void;
  backdropUri?: string | null;
}) {
  const activeKey = bgKey(value);
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.rail}
      keyboardShouldPersistTaps="always"
    >
      {BG_PRESETS.map((b) => (
        <Swatch key={bgKey(b)} bg={b} backdropUri={backdropUri} active={bgKey(b) === activeKey} onPress={() => onChange(b)} />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  rail: { paddingHorizontal: SPACING.md, paddingVertical: 8, gap: SPACING.sm, alignItems: 'center' },
  swatch: {
    width: 40, height: 40, borderRadius: 20, overflow: 'hidden',
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.4)',
  },
  swatchActive: { borderColor: '#fff', transform: [{ scale: 1.14 }] },
  blurBadge: {
    ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
});
