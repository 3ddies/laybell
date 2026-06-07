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

// Instagram-style slide-up comments with two heights — default (~78%) and full.
// Drag the grab bar UP to expand, DOWN to collapse, further DOWN to dismiss.
// Transparent so a playing reel stays visible behind it; the comment list scrolls
// on its own (only the top bar is the drag grip).
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
  const translateY = useRef(new Animated.Value(DEFAULT_H)).current;
  const backdrop = useRef(new Animated.Value(0)).current;
  const detent = useRef<'default' | 'full'>('default');
  const startH = useRef(DEFAULT_H);

  // Live geometry for the (once-created) pan handlers.
  const fullRef = useRef(FULL_H); fullRef.current = FULL_H;
  const defRef = useRef(DEFAULT_H); defRef.current = DEFAULT_H;
  const closeRef = useRef(onClose); closeRef.current = onClose;

  useEffect(() => {
    if (visible) {
      detent.current = 'default';
      height.setValue(defRef.current);
      translateY.setValue(defRef.current);
      backdrop.setValue(0);
      Animated.parallel([
        Animated.timing(translateY, { toValue: 0, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
        Animated.timing(backdrop, { toValue: 1, duration: 220, useNativeDriver: false }),
      ]).start();
    }
  }, [visible]);

  function dismiss() {
    Animated.parallel([
      Animated.timing(translateY, { toValue: fullRef.current, duration: 220, easing: Easing.in(Easing.cubic), useNativeDriver: false }),
      Animated.timing(backdrop, { toValue: 0, duration: 220, useNativeDriver: false }),
    ]).start(() => closeRef.current());
  }

  function snapTo(target: 'default' | 'full') {
    detent.current = target;
    Animated.parallel([
      Animated.spring(height, { toValue: target === 'full' ? fullRef.current : defRef.current, useNativeDriver: false, bounciness: 2, speed: 14 }),
      Animated.spring(translateY, { toValue: 0, useNativeDriver: false, bounciness: 2, speed: 14 }),
      Animated.timing(backdrop, { toValue: 1, duration: 150, useNativeDriver: false }),
    ]).start();
  }

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { startH.current = detent.current === 'full' ? fullRef.current : defRef.current; },
    onPanResponderMove: (_e, g) => {
      const DEF = defRef.current, FULL = fullRef.current;
      const target = startH.current - g.dy; // up → taller, down → shorter
      if (target >= DEF) {
        height.setValue(Math.min(target, FULL));
        translateY.setValue(0);
        backdrop.setValue(1);
      } else {
        height.setValue(DEF);
        const down = DEF - target;
        translateY.setValue(down);
        backdrop.setValue(Math.max(0, 1 - down / DEF));
      }
    },
    onPanResponderRelease: (_e, g) => {
      const DEF = defRef.current, FULL = fullRef.current;
      const target = startH.current - g.dy;
      if (target < DEF) {
        const down = DEF - target;
        if (down > DEF * 0.25 || g.vy > 1.2) dismiss();
        else snapTo('default');
      } else {
        const h = Math.min(target, FULL);
        if (h > (DEF + FULL) / 2 || g.vy < -1.2) snapTo('full');
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
          {/* Drag grip — handle + title. Claims the gesture on touch. */}
          <View style={styles.grab} {...pan.panHandlers}>
            <View style={styles.handle} />
            <Text style={styles.title}>Comments</Text>
          </View>
          <TouchableOpacity style={styles.closeBtn} onPress={dismiss} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Ionicons name="close" size={22} color={COLORS.textSecondary} />
          </TouchableOpacity>
          <View style={styles.divider} />
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
  grab: { paddingTop: SPACING.sm, paddingBottom: SPACING.sm, alignItems: 'center', gap: SPACING.sm },
  handle: { width: 40, height: 5, borderRadius: 3, backgroundColor: COLORS.border },
  title: { color: COLORS.text, fontSize: 16, fontWeight: '800' },
  closeBtn: { position: 'absolute', top: SPACING.sm, right: SPACING.md, padding: 4 },
  divider: { height: 0.5, backgroundColor: COLORS.border },
  body: { flex: 1 },
});
