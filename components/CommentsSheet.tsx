import { useEffect, useRef } from 'react';
import {
  Modal, View, Text, StyleSheet, TouchableOpacity, KeyboardAvoidingView, Platform,
  Pressable, Dimensions, Animated, PanResponder, Easing,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Comments from './Comments';
import { COLORS, SPACING, RADIUS } from '../constants/theme';

const SCREEN_H = Dimensions.get('window').height;

// Instagram-style slide-up comments with two heights:
//   • default  ~78% of the screen
//   • expanded ~full screen
// Drag the grab bar / header UP to expand, DOWN to collapse, and further DOWN to
// dismiss. Transparent so a playing reel stays visible behind it. The comment
// list scrolls on its own — only the top bar is the drag grip.
export default function CommentsSheet({ visible, postId, ownerId, onClose }: {
  visible: boolean;
  postId: string;
  ownerId?: string | null;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const FULL_H = SCREEN_H - insets.top;
  const DEFAULT_H = Math.min(Math.round(SCREEN_H * 0.78), FULL_H);

  const height = useRef(new Animated.Value(DEFAULT_H)).current;
  const translateY = useRef(new Animated.Value(DEFAULT_H)).current; // off-screen until opened
  const backdrop = useRef(new Animated.Value(0)).current;
  const detent = useRef<'default' | 'full'>('default');
  const startH = useRef(DEFAULT_H);

  useEffect(() => {
    if (visible) {
      detent.current = 'default';
      height.setValue(DEFAULT_H);
      translateY.setValue(DEFAULT_H);
      backdrop.setValue(0);
      Animated.parallel([
        Animated.timing(translateY, { toValue: 0, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
        Animated.timing(backdrop, { toValue: 1, duration: 220, useNativeDriver: false }),
      ]).start();
    }
  }, [visible]);

  const dismiss = () => {
    Animated.parallel([
      Animated.timing(translateY, { toValue: FULL_H, duration: 220, easing: Easing.in(Easing.cubic), useNativeDriver: false }),
      Animated.timing(backdrop, { toValue: 0, duration: 220, useNativeDriver: false }),
    ]).start(() => onClose());
  };

  const snapTo = (target: 'default' | 'full') => {
    detent.current = target;
    Animated.parallel([
      Animated.spring(height, { toValue: target === 'full' ? FULL_H : DEFAULT_H, useNativeDriver: false, bounciness: 2, speed: 14 }),
      Animated.spring(translateY, { toValue: 0, useNativeDriver: false, bounciness: 2, speed: 14 }),
      Animated.timing(backdrop, { toValue: 1, duration: 150, useNativeDriver: false }),
    ]).start();
  };

  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 4 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderGrant: () => { startH.current = detent.current === 'full' ? FULL_H : DEFAULT_H; },
    onPanResponderMove: (_e, g) => {
      const target = startH.current - g.dy; // drag up → taller, down → shorter
      if (target >= DEFAULT_H) {
        height.setValue(Math.min(target, FULL_H));
        translateY.setValue(0);
        backdrop.setValue(1);
      } else {
        // Below the default height: keep the sheet at default size and slide it down.
        height.setValue(DEFAULT_H);
        const down = DEFAULT_H - target;
        translateY.setValue(down);
        backdrop.setValue(Math.max(0, 1 - down / DEFAULT_H));
      }
    },
    onPanResponderRelease: (_e, g) => {
      const target = startH.current - g.dy;
      if (target < DEFAULT_H) {
        const down = DEFAULT_H - target;
        if (down > DEFAULT_H * 0.25 || g.vy > 1.2) dismiss();
        else snapTo('default');
      } else {
        const h = Math.min(target, FULL_H);
        if (h > (DEFAULT_H + FULL_H) / 2 || g.vy < -1.2) snapTo('full');
        else snapTo('default');
      }
    },
  })).current;

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={dismiss} statusBarTranslucent>
      <View style={styles.overlay}>
        <Animated.View style={[styles.backdrop, { opacity: backdrop }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={dismiss} />
        </Animated.View>
        <Animated.View style={[styles.sheet, { height, paddingBottom: insets.bottom, transform: [{ translateY }] }]}>
          <View style={styles.grab} {...pan.panHandlers}>
            <View style={styles.handle} />
            <View style={styles.headerRow}>
              <Text style={styles.title}>Comments</Text>
              <TouchableOpacity onPress={dismiss} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color={COLORS.textSecondary} />
              </TouchableOpacity>
            </View>
          </View>
          <KeyboardAvoidingView style={styles.body} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            {postId ? <Comments postId={postId} ownerId={ownerId} contentPadding={SPACING.md} /> : null}
          </KeyboardAvoidingView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl,
    overflow: 'hidden',
  },
  body: { flex: 1 },
  grab: { paddingTop: SPACING.sm },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: COLORS.border },
  headerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
    borderBottomWidth: 0.5, borderBottomColor: COLORS.border,
  },
  title: { color: COLORS.text, fontSize: 16, fontWeight: '800' },
});
