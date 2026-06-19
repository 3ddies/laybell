import { useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, Dimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';

const { width: SCREEN_W } = Dimensions.get('window');

// One-time "what you can do on Laybell" tour, shown right after onboarding
// completes (see app/onboarding.tsx step 5). It's gated by profiles.onboarded —
// once that's true the user routes straight to the tabs, so this never reappears.
type Slide = { icon: any; title: string; body: string };

const SLIDES: Slide[] = [
  {
    icon: 'add-circle-outline',
    title: 'Post',
    body: 'Share photos, videos, audio, and slideshows. Tag songs and people — your posts reach the feed and Explore.',
  },
  {
    icon: 'musical-notes-outline',
    title: 'Listen',
    body: 'Stream tracks from creators, build playlists, like and save songs, and tap Listen mode for a focused music flow.',
  },
  {
    icon: 'chatbubble-ellipses-outline',
    title: 'Message',
    body: 'Send direct messages, reply to stories, and share posts privately with friends.',
  },
  {
    icon: 'sparkles-outline',
    title: 'Badges',
    body: 'Earn tiered badges — Bronze to Diamond — by posting, listening, and engaging. Your badge shows on your profile.',
  },
  {
    icon: 'megaphone-outline',
    title: 'Promotion',
    body: 'Get seen. Spotlight pushes one of your posts up into the feed, and the Ad Manager runs ads across the feed, reels, and audio.',
  },
];

export default function WelcomeTour({ onDone }: { onDone: () => void }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList>(null);
  const [index, setIndex] = useState(0);
  const isLast = index === SLIDES.length - 1;

  function next() {
    if (isLast) { onDone(); return; }
    listRef.current?.scrollToIndex({ index: index + 1, animated: true });
    setIndex(index + 1);
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom + SPACING.lg }]}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={onDone} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={styles.skip}>Skip</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        ref={listRef}
        data={SLIDES}
        keyExtractor={(s) => s.title}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        getItemLayout={(_, i) => ({ length: SCREEN_W, offset: SCREEN_W * i, index: i })}
        onMomentumScrollEnd={(e) => setIndex(Math.round(e.nativeEvent.contentOffset.x / SCREEN_W))}
        renderItem={({ item }) => (
          <View style={styles.slide}>
            <LinearGradient colors={GRADIENTS.primary} style={styles.iconCircle}>
              <Ionicons name={item.icon} size={48} color={colors.text} />
            </LinearGradient>
            <Text style={styles.title}>{item.title}</Text>
            <Text style={styles.body}>{item.body}</Text>
          </View>
        )}
      />

      <View style={styles.dots}>
        {SLIDES.map((_, i) => (
          <View key={i} style={[styles.dot, i === index && styles.dotActive]} />
        ))}
      </View>

      <TouchableOpacity style={styles.primaryBtn} onPress={next} activeOpacity={0.85}>
        <LinearGradient colors={GRADIENTS.primary} style={styles.primaryBtnInner}>
          <Text style={styles.primaryBtnText}>{isLast ? 'Get Started' : 'Next'}</Text>
          <Ionicons name={isLast ? 'checkmark' : 'arrow-forward'} size={20} color={colors.text} />
        </LinearGradient>
      </TouchableOpacity>
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  topBar: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: SPACING.lg, height: 44, alignItems: 'center' },
  skip: { color: colors.textSecondary, fontSize: 15, fontWeight: '600' },
  slide: { width: SCREEN_W, alignItems: 'center', justifyContent: 'center', paddingHorizontal: SPACING.xl, gap: SPACING.lg },
  iconCircle: { width: 112, height: 112, borderRadius: 56, alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.3 },
  body: { color: colors.textSecondary, fontSize: 16, lineHeight: 24, textAlign: 'center' },
  dots: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, paddingVertical: SPACING.lg },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.border },
  dotActive: { width: 24, backgroundColor: colors.primary },
  primaryBtn: { marginHorizontal: SPACING.lg, borderRadius: RADIUS.full, overflow: 'hidden' },
  primaryBtnInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, paddingVertical: SPACING.md + 2 },
  primaryBtnText: { color: colors.text, fontSize: 16, fontWeight: '700' },
});
