import { useEffect, useRef, type ComponentProps } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, Pressable, Animated, Dimensions, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { isDarkPalette, type ThemePalette } from '../constants/theme';
import { selection } from '../lib/haptics';

// An iOS-style pull-down menu — the UIMenu a menu button opens — anchored to the
// control that opened it: a rounded card that springs out of that control's corner,
// the chosen option ticked on the leading side, each option's symbol trailing, and
// hairlines between. Pure JS: a native menu would be a native module, on an app with
// no over-the-air updates.
//
// An option that opens a sheet of its own (`presents`) runs once this menu's Modal
// has finished dismissing on iOS, which will not present a modal while another is
// still leaving — the rule the composer's mode menu already follows.

type IconName = ComponentProps<typeof Ionicons>['name'];

/** The opening control, as measureInWindow reports it. */
export type MenuAnchor = { x: number; y: number; width: number; height: number };

export type MenuOption = {
  key: string;
  label: string;
  sub?: string;
  icon?: IconName;
  selected?: boolean;
  /** Opens a modal of its own — on iOS it runs after this menu has fully closed. */
  presents?: boolean;
  onPress: () => void;
};

const MENU_W = 256;
const EDGE = 12;
const GAP = 8;

export default function PullDownMenu({ visible, anchor, options, onClose }: {
  visible: boolean;
  anchor: MenuAnchor | null;
  options: MenuOption[];
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const grow = useRef(new Animated.Value(0)).current;
  const pending = useRef<(() => void) | null>(null);
  // Held through the close, so the card keeps its place and its rows while the
  // Modal leaves.
  const held = useRef<{ anchor: MenuAnchor; options: MenuOption[] } | null>(null);
  if (visible && anchor) held.current = { anchor, options };

  useEffect(() => {
    if (!visible) return;
    selection();
    grow.setValue(0);
    Animated.spring(grow, { toValue: 1, friction: 9, tension: 160, useNativeDriver: true }).start();
  }, [visible, grow]);

  const menu = held.current;
  if (!menu) return null;

  const { width: screenW, height: screenH } = Dimensions.get('window');
  const width = Math.min(MENU_W, screenW - EDGE * 2);
  const a = menu.anchor;
  // A control on the right half opens its menu toward the left, as on iOS.
  const trailing = a.x + a.width / 2 > screenW / 2;
  const left = Math.min(Math.max(EDGE, trailing ? a.x + a.width - width : a.x), screenW - EDGE - width);
  // Below the control, or above it when the menu would run off the bottom.
  const estimate = menu.options.reduce((h, o) => h + (o.sub ? 64 : 46), 0);
  const openUp = a.y + a.height + GAP + estimate > screenH - EDGE * 3;
  const place = openUp ? { bottom: screenH - a.y + GAP } : { top: a.y + a.height + GAP };
  const origin = `${openUp ? 'bottom' : 'top'} ${trailing ? 'right' : 'left'}`;

  function choose(o: MenuOption) {
    const later = !!o.presents && Platform.OS === 'ios';
    if (later) pending.current = o.onPress;
    onClose();
    if (!later) o.onPress();
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
      onDismiss={() => {
        const run = pending.current;
        pending.current = null;
        run?.();
      }}
    >
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessible={false} />
      <Animated.View
        style={[
          styles.shadow,
          place,
          {
            left,
            width,
            opacity: grow,
            transform: [{ scale: grow.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] }) }],
            transformOrigin: origin,
          },
        ]}
      >
        <View style={styles.card} accessibilityRole="menu">
          {menu.options.map((o, i) => (
            <TouchableOpacity
              key={o.key}
              style={[styles.row, i > 0 && styles.rowDivider]}
              onPress={() => choose(o)}
              activeOpacity={0.6}
              accessibilityRole="menuitem"
              accessibilityState={{ selected: !!o.selected }}
            >
              <View style={styles.check}>
                {o.selected ? <Ionicons name="checkmark" size={17} color={colors.text} /> : null}
              </View>
              <View style={styles.text}>
                <Text style={styles.label} numberOfLines={1}>{o.label}</Text>
                {!!o.sub && <Text style={styles.sub} numberOfLines={2}>{o.sub}</Text>}
              </View>
              {o.icon ? <Ionicons name={o.icon} size={19} color={colors.text} /> : null}
            </TouchableOpacity>
          ))}
        </View>
      </Animated.View>
    </Modal>
  );
}

const makeStyles = (colors: ThemePalette) => {
  const dark = isDarkPalette(colors);
  return StyleSheet.create({
    shadow: {
      position: 'absolute', borderRadius: 14,
      shadowColor: '#000', shadowOffset: { width: 0, height: 10 },
      shadowOpacity: dark ? 0.5 : 0.16, shadowRadius: 28, elevation: 14,
    },
    card: {
      borderRadius: 14, overflow: 'hidden',
      backgroundColor: dark ? '#2C2C2E' : '#FFFFFF',
      borderWidth: StyleSheet.hairlineWidth, borderColor: dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)',
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 46, paddingVertical: 11, paddingLeft: 10, paddingRight: 16 },
    rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: dark ? 'rgba(255,255,255,0.14)' : 'rgba(60,60,67,0.2)' },
    check: { width: 22, alignItems: 'center' },
    text: { flex: 1 },
    label: { color: colors.text, fontSize: 16, letterSpacing: -0.3 },
    sub: { color: colors.textSecondary, fontSize: 12.5, lineHeight: 16, marginTop: 2 },
  });
};
