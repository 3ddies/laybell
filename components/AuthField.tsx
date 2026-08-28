import { useState, type ReactNode } from 'react';
import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { RADIUS, SPACING, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';

// A text field on the auth screens.
//
// THE PROBLEM, as the owner put it: "something about them just doesn't seem like
// it's at its full potential". He is right, and it is worth naming precisely
// rather than restyling at random — there were three things.
//
//  1. NO FOCUS STATE AT ALL. Tapping a field changed nothing: same fill, same
//     edge, same icon. The keyboard appeared and that was the only evidence
//     anything had happened. This is the big one. Every field a person trusts
//     with a password tells them which field they are in.
//  2. NO EDGE. A filled box with no border on a dark ground has no defined
//     shape — it reads as a slightly lighter smudge rather than a control. A
//     hairline is the difference between "a box" and "a field".
//  3. THE ICON WAS textTertiary (#484848 on dark), which is dimmer than the
//     placeholder next to it. It sat there as grey furniture instead of
//     labelling the field.
//
// So: a hairline at rest that turns brand-warm on focus, a fill that lifts one
// step, and an icon that goes from muted to full brand when the field is live.
//
// DELIBERATELY NOT ANIMATED. Focus happens at exactly the moment the keyboard is
// animating up, and a JS-driven colour interpolation competing with that is how
// you get a stutter on the first interaction of the app. Native fields snap too.
// The instant change is also clearer feedback than a 150ms fade.

type Props = TextInputProps & {
  icon: keyof typeof Ionicons.glyphMap;
  /** Trailing control — the password eye toggle on the screens that have one. */
  right?: ReactNode;
  /** Shown under the field, e.g. a per-field rule. */
  hint?: string;
};

export default function AuthField({ icon, right, hint, onFocus, onBlur, ...input }: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [focused, setFocused] = useState(false);

  return (
    <View>
      <View style={[styles.wrap, focused && styles.wrapFocused]}>
        <Ionicons
          name={icon}
          size={18}
          color={focused ? colors.text : colors.textMeta}
          style={styles.icon}
        />
        <TextInput
          {...input}
          style={[styles.input, input.style]}
          placeholderTextColor={colors.textMeta}
          // Kept, not replaced: callers may pass their own handlers and both
          // must run — swallowing a caller's onFocus here would be a silent bug.
          onFocus={(e) => { setFocused(true); onFocus?.(e); }}
          onBlur={(e) => { setFocused(false); onBlur?.(e); }}
        />
        {right}
      </View>
      {!!hint && <Text style={styles.hint}>{hint}</Text>}
    </View>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  wrap: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: c.surface,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: SPACING.md,
    height: 52,
  },
  wrapFocused: {
    // NEUTRAL, not brand (owner, 2026-08-28): "instead of the text boxes
    // highlighting orange, have them highlight a more neutral color like black".
    // c.text is the right token for that rather than a hardcoded black — it is
    // #16161A on the light theme he runs, and #F5F5F5 on dark, so the focus ring
    // is the strongest neutral available in whichever theme is active instead of
    // being invisible in one of them.
    //
    // Orange was also doing real harm here beyond taste: it made the focused
    // field compete with the gradient submit button, so two different things
    // were shouting brand colour at once on a screen with only one action.
    borderColor: c.text,
    // One step up the surface ramp, so the live field separates from the page
    // without changing size and shoving the layout around.
    backgroundColor: c.surfaceLight,
  },
  // Fixed width so the text baseline does not shift by a pixel between fields
  // whose glyphs happen to be different widths.
  icon: { width: 20, textAlign: 'center' },
  input: { flex: 1, color: c.text, fontSize: 15, height: '100%' },
  hint: { color: c.textMeta, fontSize: 12, marginTop: 6, marginLeft: SPACING.xs },
});
