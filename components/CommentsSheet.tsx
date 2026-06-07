import { useEffect, useRef } from 'react';
import {
  Modal, View, Text, StyleSheet, TouchableOpacity, KeyboardAvoidingView, Platform,
  Pressable, Dimensions, Animated, PanResponder, Easing,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Comments from './Comments';
import { COLORS, SPACING, RADIUS } from '../constants/theme';

const SHEET_H = Math.round(Dimensions.get('window').height * 0.78);

// Instagram-style slide-up comments. Transparent so a playing reel stays visible
// and keeps playing behind it. The grab handle / header is draggable: drag down
// to dismiss (release past a threshold or flick), otherwise it springs back.
export default function CommentsSheet({ visible, postId, ownerId, onClose }: {
  visible: boolean;
  postId: string;
  ownerId?: string | null;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const translateY = useRef(new Animated.Value(SHEET_H)).current;
  const backdrop = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      translateY.setValue(SHEET_H);
      backdrop.setValue(0);
      Animated.parallel([
        Animated.timing(translateY, { toValue: 0, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(backdrop, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]).start();
    }
  }, [visible]);

  const dismiss = () => {
    Animated.parallel([
      Animated.timing(translateY, { toValue: SHEET_H, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
      Animated.timing(backdrop, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start(() => onClose());
  };

  // Drag handle/header → move the sheet; release past 25% (or a flick) closes it.
  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => g.dy > 4 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderMove: (_e, g) => { if (g.dy > 0) translateY.setValue(g.dy); },
    onPanResponderRelease: (_e, g) => {
      if (g.dy > SHEET_H * 0.25 || g.vy > 1.2) dismiss();
      else Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 2 }).start();
    },
  })).current;

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={dismiss} statusBarTranslucent>
      <View style={styles.overlay}>
        <Animated.View style={[styles.backdrop, { opacity: backdrop }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={dismiss} />
        </Animated.View>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Animated.View style={[styles.sheet, { height: SHEET_H, paddingBottom: insets.bottom, transform: [{ translateY }] }]}>
            <View style={styles.grab} {...pan.panHandlers}>
              <View style={styles.handle} />
              <View style={styles.headerRow}>
                <Text style={styles.title}>Comments</Text>
                <TouchableOpacity onPress={dismiss} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Ionicons name="close" size={22} color={COLORS.textSecondary} />
                </TouchableOpacity>
              </View>
            </View>
            {postId ? <Comments postId={postId} ownerId={ownerId} contentPadding={SPACING.md} /> : null}
          </Animated.View>
        </KeyboardAvoidingView>
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
  grab: { paddingTop: SPACING.sm },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: COLORS.border },
  headerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
    borderBottomWidth: 0.5, borderBottomColor: COLORS.border,
  },
  title: { color: COLORS.text, fontSize: 16, fontWeight: '800' },
});
