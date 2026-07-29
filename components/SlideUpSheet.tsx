import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Modal, Pressable, StyleSheet, Animated, Easing, Dimensions,
  KeyboardAvoidingView, Platform, type StyleProp, type ViewStyle,
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
  const translateY = useRef(new Animated.Value(SCREEN_H)).current;
  // Derived, not animated separately — see the note above.
  const backdropOpacity = useRef(
    translateY.interpolate({ inputRange: [0, SCREEN_H], outputRange: [1, 0], extrapolate: 'clamp' }),
  ).current;

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

  if (!mounted) return null;

  const inner = (
    <Pressable style={styles.fill} onPress={onClose}>
      {/* Stop taps inside the sheet from closing it. */}
      <Animated.View style={{ transform: [{ translateY }] }}>
        <Pressable style={sheetStyle} onPress={onSheetPress ?? (() => {})}>
          {children}
        </Pressable>
      </Animated.View>
    </Pressable>
  );

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      <Animated.View style={[styles.backdrop, backdropStyle, { backgroundColor: `rgba(0,0,0,${dim})`, opacity: backdropOpacity }]}>
        {avoidKeyboard ? (
          <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            {inner}
          </KeyboardAvoidingView>
        ) : inner}
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  fill: { flex: 1, justifyContent: 'flex-end' },
});
