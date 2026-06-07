import { createContext, useContext, useEffect, useRef, useState } from 'react';
import {
  Modal, View, Text, StyleSheet, TouchableOpacity,
  Pressable, Animated, PanResponder, Easing,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, RADIUS } from '../constants/theme';
import { confirmDeletePost, reportPost } from '../lib/postActions';

export type PostOptionsArgs = {
  postId: string;
  isOwn: boolean;
  onEdit?: () => void;
  onDeleted?: () => void;
};

type ContextValue = { show: (opts: PostOptionsArgs) => void };

const PostOptionsContext = createContext<ContextValue>({ show: () => {} });

export function usePostOptions() {
  return useContext(PostOptionsContext);
}

export function PostOptionsProvider({ children }: { children: React.ReactNode }) {
  const [opts, setOpts] = useState<PostOptionsArgs | null>(null);
  const [visible, setVisible] = useState(false);

  const show = (o: PostOptionsArgs) => { setOpts(o); setVisible(true); };

  return (
    <PostOptionsContext.Provider value={{ show }}>
      {children}
      <PostOptionsSheet visible={visible} opts={opts} onClose={() => setVisible(false)} />
    </PostOptionsContext.Provider>
  );
}

const DISMISS_DIST = 300;

function PostOptionsSheet({ visible, opts, onClose }: {
  visible: boolean;
  opts: PostOptionsArgs | null;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const translateY = useRef(new Animated.Value(DISMISS_DIST)).current;
  const backdrop = useRef(new Animated.Value(0)).current;
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const optsRef = useRef(opts); optsRef.current = opts;

  useEffect(() => {
    if (visible) {
      translateY.setValue(DISMISS_DIST);
      backdrop.setValue(0);
      Animated.parallel([
        Animated.timing(translateY, { toValue: 0, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(backdrop, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]).start();
    }
  }, [visible]);

  function dismiss() {
    Animated.parallel([
      Animated.timing(translateY, { toValue: DISMISS_DIST, duration: 220, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
      Animated.timing(backdrop, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start(() => closeRef.current());
  }

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 3,
    onPanResponderMove: (_e, g) => {
      const dy = Math.max(0, g.dy);
      translateY.setValue(dy);
      backdrop.setValue(Math.max(0, 1 - dy / DISMISS_DIST));
    },
    onPanResponderRelease: (_e, g) => {
      if (g.dy > 60 || g.vy > 1.2) {
        Animated.parallel([
          Animated.timing(translateY, { toValue: DISMISS_DIST, duration: 220, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
          Animated.timing(backdrop, { toValue: 0, duration: 200, useNativeDriver: true }),
        ]).start(() => closeRef.current());
      } else {
        Animated.parallel([
          Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 2, speed: 14 }),
          Animated.timing(backdrop, { toValue: 1, duration: 150, useNativeDriver: true }),
        ]).start();
      }
    },
  })).current;

  const isOwn = opts?.isOwn ?? false;

  const ownOptions = [
    {
      label: 'Edit post',
      icon: 'pencil-outline' as const,
      destructive: false,
      onPress: () => { dismiss(); setTimeout(() => optsRef.current?.onEdit?.(), 280); },
    },
    {
      label: 'Delete post',
      icon: 'trash-outline' as const,
      destructive: true,
      onPress: () => {
        dismiss();
        setTimeout(() => { const o = optsRef.current; if (o) confirmDeletePost(o.postId, o.onDeleted); }, 280);
      },
    },
  ];

  const otherOptions = [
    {
      label: 'Report post',
      icon: 'flag-outline' as const,
      destructive: true,
      onPress: () => {
        dismiss();
        setTimeout(() => { const o = optsRef.current; if (o) reportPost(o.postId); }, 280);
      },
    },
  ];

  const options = isOwn ? ownOptions : otherOptions;

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={dismiss} statusBarTranslucent>
      <View style={styles.overlay}>
        <Animated.View style={[styles.backdrop, { opacity: backdrop }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={dismiss} />
        </Animated.View>
        <Animated.View style={[styles.sheet, { paddingBottom: insets.bottom + SPACING.sm, transform: [{ translateY }] }]}>
          <View style={styles.grab} {...pan.panHandlers}>
            <View style={styles.handle} />
          </View>
          <View style={styles.divider} />
          {options.map((opt, i) => (
            <TouchableOpacity
              key={opt.label}
              style={[styles.option, i < options.length - 1 && styles.optionBorder]}
              onPress={opt.onPress}
              activeOpacity={0.7}
            >
              <View style={[styles.iconWrap, opt.destructive && styles.iconWrapDestructive]}>
                <Ionicons name={opt.icon} size={20} color={opt.destructive ? COLORS.error : COLORS.text} />
              </View>
              <Text style={[styles.optionLabel, opt.destructive && styles.destructive]}>{opt.label}</Text>
            </TouchableOpacity>
          ))}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
    overflow: 'hidden',
  },
  grab: { alignItems: 'center', paddingVertical: SPACING.sm },
  handle: { width: 40, height: 5, borderRadius: 3, backgroundColor: COLORS.border },
  divider: { height: 0.5, backgroundColor: COLORS.border },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md + SPACING.xs,
    gap: SPACING.md,
  },
  optionBorder: { borderBottomWidth: 0.5, borderBottomColor: COLORS.border },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: RADIUS.sm,
    backgroundColor: COLORS.surfaceLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrapDestructive: { backgroundColor: '#F43F5E18' },
  optionLabel: { color: COLORS.text, fontSize: 16, fontWeight: '500' },
  destructive: { color: COLORS.error },
});
