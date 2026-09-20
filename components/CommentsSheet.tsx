import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal, View, Text, StyleSheet, TouchableOpacity, Keyboard, Platform,
  Pressable, useWindowDimensions,
} from 'react-native';
import Reanimated, {
  Easing as REasing, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming,
} from 'react-native-reanimated';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Comments from './Comments';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

// Rubber-band resistance: sheet can stretch a little past its ceiling, then
// snaps back. Displacement approaches `max` asymptotically so it always feels
// like there's more resistance the further you pull.
function rubber(excess: number, max = 38): number {
  'worklet'; // read by the drag, which runs on the UI thread
  return max * (1 - Math.exp(-excess / max));
}

// Instagram-style slide-up comments with two heights — default (~78%) and full.
// Drag the grab bar UP to expand, DOWN to collapse, further DOWN to dismiss.
// Transparent so a playing reel stays visible behind it; the comment list scrolls
// on its own (only the top bar is the drag grip).
//
// memo(): hosts that re-render at a clip (CastBar re-renders on every 0.5s
// cast-position tick) must not drag the whole sheet — comment list, TextInput —
// with them; a re-render storm under an active TextInput drops/jumps typing.
// Callers with stable props (CastBar) get the bail-out; inline-arrow callers
// behave exactly as before.
function CommentsSheet({ visible, postId, ownerId, onClose, onPosted, inOverlay }: {
  visible: boolean;
  postId: string;
  ownerId?: string | null;
  onClose: () => void;
  // Forwarded to Comments — fires when a comment is actually submitted.
  onPosted?: () => void;
  // True when hosted inside the iOS FullWindowOverlay (the TV remote) — renders
  // as a plain view instead of a real Modal (see the return-site comment).
  inOverlay?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  // Window height (not a module const) so the sheet fits the CURRENT orientation —
  // landscape reels open comments without the sheet overflowing a portrait height.
  const { height: SCREEN_H } = useWindowDimensions();
  const FULL_H = SCREEN_H - insets.top;
  const DEFAULT_H = Math.min(Math.round(SCREEN_H * 0.75), FULL_H); // 3/4 at rest; drag/type → full

  // EVERYTHING the drag touches is a shared value, so the whole gesture — the
  // slide, the backdrop AND the height — runs on the UI thread.
  //
  // The old split (height on the JS driver, slide and backdrop on the native
  // one, two nested nodes so the two drivers never met) existed because RN's
  // Animated cannot drive a layout prop natively. Reanimated can, so the split
  // is gone: the detent resize no longer flushes a JS layout pass per frame
  // while a reel plays behind the sheet.
  const h = useSharedValue(DEFAULT_H);      // the sheet's height (a real layout)
  const ty = useSharedValue(DEFAULT_H);     // how far it sits below its place
  const startH = useSharedValue(DEFAULT_H); // height when the drag began
  // Geometry the worklets read. Mirrored from render, because a worklet cannot
  // reach into a JS ref.
  const fullSv = useSharedValue(FULL_H);
  const defSv = useSharedValue(DEFAULT_H);
  useEffect(() => { fullSv.value = FULL_H; defSv.value = DEFAULT_H; }, [FULL_H, DEFAULT_H, fullSv, defSv]);

  const sheetStyle = useAnimatedStyle(() => ({
    height: h.value,
    transform: [{ translateY: ty.value }],
  }));
  // Derived from the slide rather than animated beside it, so they cannot drift.
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: 1 - Math.min(1, Math.max(0, ty.value) / Math.max(1, defSv.value)),
  }));

  const closeRef = useRef(onClose); closeRef.current = onClose;
  // One frame after the slide lands, so the host's re-render and this sheet's
  // teardown are never seen happening (same reason as PostOptionsContext).
  const finishClose = useCallback(() => { requestAnimationFrame(() => closeRef.current()); }, []);

  // Height of the on-screen keyboard, used to lift the sheet's input above it.
  const [kbHeight, setKbHeight] = useState(0);

  useEffect(() => {
    if (visible) {
      setKbHeight(0);
      h.value = DEFAULT_H;
      ty.value = DEFAULT_H;
      ty.value = withTiming(0, { duration: 260, easing: REasing.out(REasing.cubic) });
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

  // The detent spring, soft and quick — the numbers the owner tuned as
  // (bounciness 2, speed 14) on RN's spring.
  const SNAP = { damping: 18, stiffness: 260, mass: 0.8 };

  // Worklet twins: the gesture settles on the UI thread, while the keyboard
  // listener and the close button call the JS ones. Both write the same values.
  const dismissW = useCallback(() => {
    'worklet';
    // Aims past the sheet's full height, so it always clears the screen.
    ty.value = withTiming(fullSv.value, { duration: 220, easing: REasing.out(REasing.quad) }, (done) => {
      'worklet';
      if (done) runOnJS(finishClose)();
    });
  }, [finishClose, ty, fullSv]);

  const snapToW = useCallback((target: 'default' | 'full') => {
    'worklet';
    h.value = withSpring(target === 'full' ? fullSv.value : defSv.value, SNAP);
    ty.value = withSpring(0, SNAP);
  }, [h, ty, fullSv, defSv]);

  function dismiss() { dismissW(); }
  function snapTo(target: 'default' | 'full') { snapToW(target); }

  // Where the drag lands. velocityY is px/SECOND here; the PanResponder's vy was
  // px/ms, hence the ×1000 on the old 1.2 thresholds.
  const settle = useCallback((dy: number, vy: number) => {
    'worklet';
    const DEF = defSv.value, FULL = fullSv.value;
    const target = startH.value - dy;
    if (target < DEF) {
      const down = DEF - target;
      // Projected rest, not raw distance: a short pull released while still
      // moving down dismisses, the same pull released dead still springs back.
      if (down + vy * 0.12 > DEF * 0.25) dismissW();
      else snapToW('default');
    } else if (target > FULL) {
      // Was in the elastic zone above full — always snap back to full.
      snapToW('full');
    } else {
      if (target > (DEF + FULL) / 2 || vy < -1200) snapToW('full');
      else snapToW('default');
    }
  }, [defSv, fullSv, startH, dismissW, snapToW]);

  const drag = useMemo(() => Gesture.Pan()
    .onBegin(() => {
      'worklet';
      // A grab mid-spring starts from where the sheet actually IS, not from the
      // detent it was heading for.
      startH.value = h.value;
    })
    .onUpdate((e) => {
      'worklet';
      const DEF = defSv.value, FULL = fullSv.value;
      const target = startH.value - e.translationY; // up → taller, down → shorter
      if (target >= DEF) {
        // Elastic stretch above the ceiling, then snap back on release.
        h.value = target > FULL ? FULL + rubber(target - FULL) : target;
        ty.value = 0;
      } else {
        // Downward (dismiss) drag: the height holds and the sheet slides.
        h.value = DEF;
        ty.value = DEF - target;
      }
    })
    .onEnd((e) => { 'worklet'; settle(e.translationY, e.velocityY); })
    // A CANCELLED touch (system alert, incoming call, app-switch gesture) must
    // resolve exactly like a release, or the sheet strands between detents.
    // onFinalize runs for both; `ended` is false only when onEnd did not.
    .onFinalize((e, ended) => { 'worklet'; if (!ended) settle(e.translationY, e.velocityY); }),
  [settle, h, ty, startH, defSv, fullSv]);

  const content = (
      <View style={styles.overlay}>
        <Reanimated.View style={[styles.backdrop, backdropStyle]}>
          {/* While typing, a tap outside the keyboard ONLY dismisses the keyboard
              (doesn't also close the sheet); otherwise it closes the sheet. */}
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => { if (kbHeight > 0) Keyboard.dismiss(); else dismiss(); }}
          />
        </Reanimated.View>
        {/* ONE node now: height and slide are both Reanimated, so they no longer
            need separate views to keep two animation drivers apart.

            Bottom clearance: the input bar already carries its own bottom
            padding (SPACING.md), so the sheet only adds the REMAINDER of the
            safe-area inset — stacking the full inset on top left a thick dead
            strip under the input. Keyboard open → reserve its exact height. */}
        <Reanimated.View
          style={[styles.sheet, { paddingBottom: kbHeight > 0 ? kbHeight : Math.max(0, insets.bottom - SPACING.md) }, sheetStyle]}
        >
          {/* Drag grip — handle + title. Claims the gesture on touch. */}
          <GestureDetector gesture={drag}>
            <View style={styles.grab}>
              <View style={styles.handle} />
              <Text style={styles.title}>{t('comments.title')}</Text>
            </View>
          </GestureDetector>
          <TouchableOpacity style={styles.closeBtn} onPress={dismiss} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} accessibilityRole="button" accessibilityLabel={t('a11y.close')}>
            <Ionicons name="close" size={22} color={colors.textSecondary} />
          </TouchableOpacity>
          <View style={styles.divider} />
          <View style={styles.body}>
            {postId ? <Comments postId={postId} ownerId={ownerId} contentPadding={SPACING.md} onNavigate={dismiss} onPosted={onPosted} /> : null}
          </View>
        </Reanimated.View>
      </View>
  );

  // Hosted inside the iOS FullWindowOverlay (the TV remote): a real <Modal>
  // presented from an overlay window deadlocks, and one presented from the main
  // window can't show over native-modal routes (/tv itself) — so the overlay
  // host renders the sheet as a plain absolute-fill view, stacked above the
  // remote by z-order. Everywhere else keeps the real Modal.
  //
  // Each host is its own native window, outside the app's root gesture handler,
  // where a GestureDetector silently does nothing — so each gets its own root.
  if (inOverlay && Platform.OS === 'ios') {
    return visible ? <GestureHandlerRootView style={[StyleSheet.absoluteFill, { zIndex: 80 }]}>{content}</GestureHandlerRootView> : null;
  }
  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={dismiss} statusBarTranslucent supportedOrientations={['portrait', 'landscape']}>
      <GestureHandlerRootView style={styles.overlay}>{content}</GestureHandlerRootView>
    </Modal>
  );
}

export default memo(CommentsSheet);

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl,
    overflow: 'hidden',
  },
  grab: { paddingTop: SPACING.sm, paddingBottom: SPACING.sm, alignItems: 'center', gap: SPACING.sm },
  handle: { width: 40, height: 5, borderRadius: 3, backgroundColor: colors.border },
  title: { color: colors.text, fontSize: 16, fontWeight: '800' },
  closeBtn: { position: 'absolute', top: SPACING.sm, right: SPACING.md, padding: 4 },
  divider: { height: 0.5, backgroundColor: colors.border },
  body: { flex: 1 },
});
