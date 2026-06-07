import { useEffect, useRef, useState } from 'react';
import {
  Modal, View, Text, StyleSheet, TouchableOpacity, Keyboard, Platform,
  Pressable, Dimensions, Animated, PanResponder, Easing,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Comments from './Comments';
import { COLORS, SPACING, RADIUS } from '../constants/theme';

const SCREEN_H = Dimensions.get('window').height;

// Rubber-band resistance: sheet can stretch a little past its ceiling, then
// snaps back. Displacement approaches `max` asymptotically so it always feels
// like there's more resistance the further you pull.
function rubber(excess: number, max = 38): number {
  return max * (1 - Math.exp(-excess / max));
}

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

  // Height of the on-screen keyboard, used to lift the sheet's input above it.
  const [kbHeight, setKbHeight] = useState(0);

  useEffect(() => {
    if (visible) {
      detent.current = 'default';
      setKbHeight(0);
      height.setValue(defRef.current);
      translateY.setValue(defRef.current);
      backdrop.setValue(0);
      Animated.parallel([
        Animated.timing(translateY, { toValue: 0, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
        Animated.timing(backdrop, { toValue: 1, duration: 220, useNativeDriver: false }),
      ]).start();
    }
  }, [visible]);

  // Keep the comment bar above the keyboard. A KeyboardAvoidingView is unreliable
  // inside a Modal (and a no-op on Android here), so handle it manually: reserve
  // the keyboard's height at the sheet bottom and expand to full so the list
  // still has room. snapTo is hoisted, so it's safe to reference here.
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, (e) => {
      setKbHeight(e.endCoordinates?.height ?? 0);
      snapTo('full');
    });
    const hideSub = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

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
        // Allow elastic stretch above the full-height ceiling
        const clamped = target > FULL ? FULL + rubber(target - FULL) : target;
        height.setValue(clamped);
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
      } else if (target > FULL) {
        // Was in the elastic zone above full — always snap back to full
        snapTo('full');
      } else {
        if (target > (DEF + FULL) / 2 || g.vy < -1.2) snapTo('full');
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
        <Animated.View style={[styles.sheet, { height, paddingBottom: kbHeight > 0 ? kbHeight : insets.bottom, transform: [{ translateY }] }]}>
          {/* Drag grip — handle + title. Claims the gesture on touch. */}
          <View style={styles.grab} {...pan.panHandlers}>
            <View style={styles.handle} />
            <Text style={styles.title}>Comments</Text>
          </View>
          <TouchableOpacity style={styles.closeBtn} onPress={dismiss} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Ionicons name="close" size={22} color={COLORS.textSecondary} />
          </TouchableOpacity>
          <View style={styles.divider} />
          <View style={styles.body}>
            {postId ? <Comments postId={postId} ownerId={ownerId} contentPadding={SPACING.md} onNavigate={dismiss} /> : null}
          </View>
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
