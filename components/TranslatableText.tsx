import React from 'react';
import { Text, TouchableOpacity, type StyleProp, type TextStyle } from 'react-native';
import { useAutoTranslate } from '../hooks/useAutoTranslate';
import { useTranslation } from '../contexts/LanguageContext';
import { useTheme } from '../contexts/ThemeContext';

// Drop-in for user-typed text (comments, captions, bios, message bodies) that
// auto-translates into the viewer's app language with a "Show original" toggle.
//
// For plain text just pass `text` + `style`. For text that needs custom
// rendering (e.g. @mention linking, inline URL parsing) pass `render`, which
// receives the string to display (original or translated) and returns the node:
//
//   <TranslatableText text={post.caption} render={(s) => <MentionText text={s} style={styles.caption} numberOfLines={3} />} />
//
// Renders a Fragment (the body + an optional toggle link), so place it where a
// View child is valid — not inside another <Text>.
export default function TranslatableText({
  text, style, numberOfLines, render, linkStyle,
}: {
  text?: string | null;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  render?: (shown: string) => React.ReactNode;
  linkStyle?: StyleProp<TextStyle>;
}) {
  const tr = useAutoTranslate(text);
  const { t } = useTranslation();
  const { colors } = useTheme();

  if (!text) return null;

  const body = render
    ? render(tr.shown)
    : <Text style={style} numberOfLines={tr.loading ? undefined : numberOfLines}>{tr.shown}</Text>;

  let label: string | null = null;
  if (tr.loading) label = t('translate.translating');
  else if (tr.hasTranslation) label = tr.showingOriginal ? t('translate.showTranslation') : t('translate.showOriginal');
  // Offer "tap to translate" ONLY when the text is a different real language
  // than the viewer's (gibberish / same-language text gets no link).
  else if (tr.canTranslate) label = t('translate.see');

  return (
    <>
      {body}
      {label && (
        <TouchableOpacity onPress={tr.toggle} disabled={tr.loading} hitSlop={6} activeOpacity={0.7}>
          <Text style={[{ color: colors.textTertiary, fontSize: 12, fontWeight: '600', marginTop: 2 }, linkStyle]}>
            {label}
          </Text>
        </TouchableOpacity>
      )}
    </>
  );
}
