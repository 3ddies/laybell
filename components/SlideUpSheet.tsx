import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Modal, Pressable, StyleSheet, Animated, Easing, Dimensions,
  Keyboard, Platform, type StyleProp, type ViewStyle,
} from 'react-native';

const SCREEN_H = Dimensions.get('window').height;

// A bottom sheet that darkens the screen behind it.
//
// WHY THIS EXISTS: `<Modal animationType="slide">` translates the ENTIRE modal
// up from the bottom — backdrop included. So the dim didn't settle over the
// page, it swept up as a dark rectangle alongside the sheet, reading as two
// things sliding rather than one sheet rising over a dimming page.
//
// Here ONE Animated.Value drives both, and the backdrop's opacity is an
// interpolation OF that value rather than a second animation. They are
// mathematically locked — there is no timing to keep in step and no way for
// them to desync, which is the same construction the report sheet uses.
//
// The Modal stays mounted through the close so the exit animation can actually
// play; `visible={false}` alone would cut it off mid-flight.
export default function SlideUpSheet({
  visible,
  onClose,
  children,
  sheetStyle,
  backdropStyle,
  dim = 0.55,
  avoidKeyboard = false,
  onSheetPress,
}: {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
  sheetStyle?: StyleProp<ViewStyle>;
  /** Extra style for the backdrop (layout only — the colour comes from `dim`). */
  backdropStyle?: StyleProp<ViewStyle>;
  /** Peak darkness of the page behind the sheet. */
  dim?: number;
  /** Lift the sheet above the keyboard — needed when it contains a text input. */
  avoidKeyboard?: boolean;
  /**
   * Tap on the SHEET itself (not the backdrop). Defaults to swallowing the tap
   * so it doesn't fall through and close. Sheets with a text field pass
   * Keyboard.dismiss here.
   */
  onSheetPress?: () => void;
}) {
  const [mounted, setMounted] = useState(visible);
  // Keyboard lift, done with explicit listeners instead of KeyboardAvoidingView.
  //
  // KAV wrapped the FULL-HEIGHT container, so ANY padding it computed pushed the
  // sheet up off the bottom edge of the screen — leaving a strip of dimmed page
  // between the sheet and the bottom of the display. That's the "sheet is cut off
  // and floating" bug: it showed on the one sheet that opens with the keyboard
  // CLOSED (Add to playlist), while sheets that immediately focus a text field
  // hid it, because there the lift looked deliberate.
  //
  // Listening directly makes the offset exactly the keyboard height while the
  // keyboard is up, and exactly ZERO while it isn't — so a sheet with no focused
  // input is always flush with the bottom of the screen.
  const keyboardLift = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(SCREEN_H)).current;
  // Derived, not animated separately — see the note above.
  const backdropOpacity = useRef(
    translateY.interpolate({ inputRange: [0, SCREEN_H], outputRange: [1, 0], extrapolate: 'clamp' }),
  ).current;
  // The sheet's final offset: its slide position MINUS the keyboard lift. Both
  // are native-driver values composed at the transform, so the lift rides the
  // same UI-thread animation as the slide and the two can't desync (the same
  // construction the backdrop uses).
  const sheetOffset = useRef(Animated.subtract(translateY, keyboardLift)).current;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      translateY.setValue(SCREEN_H);
      // ARRIVING and LEAVING are deliberately not mirror images. Entry launches
      // fast and takes a long, soft landing (an expo-style ease-out) so the
      // sheet reads as settling into place rather than being dragged up.
      Animated.timing(translateY, {
        toValue: 0, duration: 340, easing: Easing.bezier(0.16, 1, 0.3, 1), useNativeDriver: true,
      }).start();
    } else if (mounted) {
      // Exit is shorter and accelerates away — dismissal should feel decisive,
      // not like the entry played backwards.
      Animated.timing(translateY, {
        toValue: SCREEN_H, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: true,
      }).start(({ finished }) => { if (finished) setMounted(false); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // iOS ONLY, matching what KAV did before: Android runs adjustResize, so the
  // window already shrinks for the keyboard and adding our own lift would
  // double-count it. (The old code passed behavior=undefined on Android, which
  // made KAV a no-op there — this keeps that behaviour byte-for-byte.)
  useEffect(() => {
    if (!avoidKeyboard || Platform.OS !== 'ios') return;
    // `keyboardWillShow` fires BEFORE the keyboard slides in and carries its
    // duration, so matching it here keeps the sheet glued to the keyboard's top
    // edge for the whole travel rather than snapping ahead of it.
    const to = (toValue: number, duration: number) =>
      Animated.timing(keyboardLift, { toValue, duration: duration || 250, useNativeDriver: true }).start();
    const show = Keyboard.addListener('keyboardWillShow', (e) => to(e.endCoordinates?.height ?? 0, e.duration));
    const hide = Keyboard.addListener('keyboardWillHide', (e) => to(0, e.duration));
    return () => { show.remove(); hide.remove(); };
  }, [avoidKeyboard, keyboardLift]);

  if (!mounted) return null;

  const inner = (
    <>
      {/* Tap-to-close layer, BEHIND the sheet (so sheet taps never reach it). */}
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      {/* The wrapper spans the whole screen and bottom-aligns the sheet (see
          sheetWrap for why a content-sized wrapper broke percentage heights).
          The slide-in and the keyboard lift are folded into its one transform.
          box-none so it doesn't swallow taps meant for the close layer behind
          it — only the sheet itself takes touches. */}
      <Animated.View
        pointerEvents="box-none"
        style={[styles.sheetWrap, { transform: [{ translateY: sheetOffset }] }]}
      >
        <Pressable style={sheetStyle} onPress={onSheetPress ?? (() => {})}>
          {children}
        </Pressable>
      </Animated.View>
    </>
  );

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      <Animated.View style={[styles.backdrop, backdropStyle, { backgroundColor: `rgba(0,0,0,${dim})`, opacity: backdropOpacity }]}>
        {inner}
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1 },
  // FULL-SCREEN on purpose, with the sheet bottom-aligned inside it — NOT a
  // content-sized box pinned to the bottom.
  //
  // This is what caused the "sheet floats above the bottom edge" bug. A sheet
  // style of `maxHeight: '70%'` (several of them have one) resolves that
  // percentage against THIS wrapper. When the wrapper was content-sized, the
  // percentage was self-referential: the wrapper grew to the sheet's natural
  // height, the sheet was then clamped to 70% OF THAT, and the leftover 30% sat
  // under the sheet as empty wrapper — which is exactly the gap, and why the gap
  // scaled with the sheet's content instead of being a fixed inset.
  //
  // Spanning the screen gives the percentage a stable base (the display), so
  // `maxHeight: '70%'` means what it reads as, and flex-end keeps the sheet on
  // the bottom edge.
  sheetWrap: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end' },
});
