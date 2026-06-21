import { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, Dimensions, Pressable, Animated,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, RADIUS, GRADIENTS, SHADOWS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

const { width: SCREEN_W } = Dimensions.get('window');

// One-shot AsyncStorage flag. Onboarding sets it on finish; the root layout
// reads-and-clears it the first time the user lands on the tabs, then mounts
// this card. Cleared on first show, so the tour is shown exactly once.
export const WELCOME_TOUR_FLAG = 'laybell:welcome_tour';

// Border gap so the live app shows through AROUND the card. Keeping this
// generous is what makes the tour read as a floating, dismissible card the user
// can tap out of — rather than a full-screen wall they're forced to swipe past.
const CARD_MARGIN = 24;
const CARD_W = SCREEN_W - CARD_MARGIN * 2;
const CARD_PAD = SPACING.lg;
const SLIDE_W = CARD_W - CARD_PAD * 2; // each pager page == card inner width
const SLIDE_H = 260;

// One-time "what you can do on Laybell" tour. It floats as a miniaturized card
// OVER the live app (mounted from app/_layout.tsx right after onboarding), so
// the real app is visible around its borders. Tapping the × or anywhere outside
// the card calls onDone — which just dismisses the card and leaves the user in
// the app. It's gated by a one-shot flag, so it never reappears.
type T = (key: string, vars?: Record<string, string | number>) => string;
type Slide = { key: string; icon: any; title: string; body: string };

// Built per-render so the slide copy follows the active language. `key` stays
// stable (English-independent) so the pager/keyExtractor don't churn on switch.
const buildSlides = (t: T): Slide[] => [
  {
    key: 'post',
    icon: 'add-circle-outline',
    title: t('welcomeTour.postTitle'),
    body: t('welcomeTour.postBody'),
  },
  {
    key: 'listen',
    icon: 'musical-notes-outline',
    title: t('welcomeTour.listenTitle'),
    body: t('welcomeTour.listenBody'),
  },
  {
    key: 'message',
    icon: 'chatbubble-ellipses-outline',
    title: t('welcomeTour.messageTitle'),
    body: t('welcomeTour.messageBody'),
  },
  {
    key: 'badges',
    icon: 'sparkles-outline',
    title: t('welcomeTour.badgesTitle'),
    // Tier names stay English (interpolated) per brand rules.
    body: t('welcomeTour.badgesBody', { from: 'Bronze', to: 'Diamond' }),
  },
  {
    key: 'promotion',
    icon: 'megaphone-outline',
    title: t('welcomeTour.promotionTitle'),
    body: t('welcomeTour.promotionBody'),
  },
];

export default function WelcomeTour({ onDone }: { onDone: () => void }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const SLIDES = buildSlides(t);
  const listRef = useRef<FlatList>(null);
  const [index, setIndex] = useState(0);
  const isLast = index === SLIDES.length - 1;

  // Fade the scrim up and lift the card in, so the tour floats up over the live
  // app instead of snapping in — reinforces that it's a card, not a wall.
  const enter = useRef(new Animated.Value(0)).current;
  const closingRef = useRef(false);
  useEffect(() => {
    Animated.timing(enter, { toValue: 1, duration: 240, useNativeDriver: true }).start();
  }, [enter]);

  // Reverse the entrance (fade the scrim out + sink the card) BEFORE unmounting,
  // so closing feels as polished as opening instead of snapping away. The ref
  // guards against a double-tap firing two dismissals mid-animation.
  function dismiss() {
    if (closingRef.current) return;
    closingRef.current = true;
    Animated.timing(enter, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => onDone());
  }

  function next() {
    if (isLast) { dismiss(); return; }
    listRef.current?.scrollToIndex({ index: index + 1, animated: true });
    setIndex(index + 1);
  }

  const cardStyle = {
    opacity: enter,
    transform: [
      { scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) },
      { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) },
    ],
  };

  return (
    <View style={styles.overlay}>
      {/* Tap the visible app border (anywhere outside the card) to dismiss. */}
      <Animated.View style={[styles.scrim, { opacity: enter }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={dismiss} />
      </Animated.View>

      <Animated.View style={[styles.card, cardStyle]}>
        <TouchableOpacity
          style={styles.closeBtn}
          onPress={dismiss}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="close" size={20} color={colors.textSecondary} />
        </TouchableOpacity>

        <FlatList
          ref={listRef}
          data={SLIDES}
          keyExtractor={(s) => s.key}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          style={styles.list}
          getItemLayout={(_, i) => ({ length: SLIDE_W, offset: SLIDE_W * i, index: i })}
          onMomentumScrollEnd={(e) => setIndex(Math.round(e.nativeEvent.contentOffset.x / SLIDE_W))}
          renderItem={({ item }) => (
            <View style={styles.slide}>
              <LinearGradient colors={GRADIENTS.primary} style={styles.iconCircle}>
                <Ionicons name={item.icon} size={40} color={colors.text} />
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
            <Text style={styles.primaryBtnText}>{isLast ? t('welcomeTour.getStarted') : t('welcomeTour.next')}</Text>
            <Ionicons name={isLast ? 'checkmark' : 'arrow-forward'} size={18} color={colors.text} />
          </LinearGradient>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  card: {
    width: CARD_W,
    backgroundColor: colors.surfaceElevated,
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: CARD_PAD,
    paddingTop: SPACING.xl,
    paddingBottom: SPACING.lg,
    ...SHADOWS.md,
  },
  closeBtn: {
    position: 'absolute', top: SPACING.sm, right: SPACING.sm,
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center', zIndex: 2,
  },
  list: { height: SLIDE_H, flexGrow: 0 },
  slide: { width: SLIDE_W, height: SLIDE_H, alignItems: 'center', justifyContent: 'center', gap: SPACING.md, paddingHorizontal: SPACING.xs },
  iconCircle: { width: 88, height: 88, borderRadius: 44, alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.text, fontSize: 24, fontWeight: '800', letterSpacing: -0.3 },
  body: { color: colors.textSecondary, fontSize: 15, lineHeight: 22, textAlign: 'center' },
  dots: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 7, paddingVertical: SPACING.md },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.border },
  dotActive: { width: 22, backgroundColor: colors.primary },
  primaryBtn: { borderRadius: RADIUS.full, overflow: 'hidden' },
  primaryBtnInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, paddingVertical: SPACING.md },
  primaryBtnText: { color: colors.text, fontSize: 16, fontWeight: '700' },
});
