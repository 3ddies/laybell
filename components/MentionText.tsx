import { Text, type StyleProp, type TextStyle } from 'react-native';
import { useState, type ReactNode } from 'react';
import { useRouter } from 'expo-router';
import { supabase } from '../lib/supabase';
import { useTheme } from '../contexts/ThemeContext';

// Renders caption / comment text with @mentions as tappable, highlighted spans
// that open the mentioned user's profile. Drop-in replacement for a plain <Text>.
// Resolves username → id on tap (usernames are stored lowercase; matched ci).

const styles_underline = { textDecorationLine: 'underline' } as const;

type Seg = { t: 'x' | 'm'; v: string; u?: string };

function parse(text: string): Seg[] {
  const segs: Seg[] = [];
  let last = 0;
  const re = /@(\w{2,30})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const prev = m.index > 0 ? text[m.index - 1] : ' ';
    if (/\w/.test(prev)) continue; // '@' inside a word (e.g. an email) → not a mention
    if (m.index > last) segs.push({ t: 'x', v: text.slice(last, m.index) });
    segs.push({ t: 'm', v: m[0], u: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ t: 'x', v: text.slice(last) });
  return segs;
}

export default function MentionText({
  text, style, mentionStyle, numberOfLines, suffix, onPress, onBeforeNavigate,
}: {
  text?: string | null;
  style?: StyleProp<TextStyle>;
  mentionStyle?: StyleProp<TextStyle>;
  numberOfLines?: number;
  // Optional trailing node rendered INLINE at the end of the text (flows with it
  // and wraps naturally) — e.g. a post's community hashtag. Must be <Text>-based.
  suffix?: ReactNode;
  // Tap handler for the plain (non-mention, non-suffix) text. Putting it HERE
  // instead of wrapping this in a TouchableOpacity lets the inner tappable spans
  // (mentions, the community tag) win their own taps — a wrapping touchable
  // steals them and makes the inline tag almost impossible to hit.
  onPress?: () => void;
  // Called right before a mention tap pushes the profile, so a host overlay/sheet
  // (e.g. Now Playing) can close first — otherwise the profile opens BEHIND it.
  onBeforeNavigate?: () => void;
}) {
  const { colors } = useTheme();
  const router = useRouter();
  // Which mention span is currently held — drives a brief press underline (a clean
  // link-style tap cue, matching the name tap feedback in the live chat).
  const [pressedIdx, setPressedIdx] = useState<number | null>(null);
  if (!text) return suffix ? <Text style={style} numberOfLines={numberOfLines}>{suffix}</Text> : null;

  const segs = parse(text);
  // No mentions → just a plain Text (avoids the nested-Text overhead).
  if (!segs.some((s) => s.t === 'm')) {
    return <Text style={style} numberOfLines={numberOfLines} onPress={onPress} suppressHighlighting>{text}{suffix}</Text>;
  }

  async function go(username: string) {
    const { data } = await supabase.from('profiles').select('id').ilike('username', username).maybeSingle();
    if (data?.id) { onBeforeNavigate?.(); router.push(`/profile/${data.id}`); }
  }

  return (
    <Text style={style} numberOfLines={numberOfLines} onPress={onPress} suppressHighlighting>
      {segs.map((s, i) =>
        s.t === 'm' ? (
          <Text
            key={i}
            // Neutral and bold, not brand orange (owner, 2026-08-28): near-black
            // on the light theme, white on dark. Themed rather than the static
            // COLORS import, which is the DARK palette — a mention rendered on
            // the light theme was reading a dark-theme colour.
            //
            // Weight is what carries it now that hue does not: mentions have to
            // stay obviously tappable inside a run of body text, and 700 against
            // the surrounding 400 does that without a second colour competing
            // with everything else on the screen.
            // The SAME token community hashtags use, so the two kinds of link in
            // a caption look like the same kind of thing. A mention used to be
            // colors.text in bold, which made it read as emphasis rather than as
            // something you could tap. Theme-aware: the violet deepens in light
            // mode, where the on-dark one falls under 3:1.
            style={[{ color: colors.communityTint, fontWeight: '700' }, mentionStyle, pressedIdx === i && styles_underline]}
            onPressIn={() => setPressedIdx(i)}
            onPressOut={() => setPressedIdx(null)}
            onPress={() => go(s.u!)}
            suppressHighlighting
          >
            {s.v}
          </Text>
        ) : (
          <Text key={i}>{s.v}</Text>
        ),
      )}
      {suffix}
    </Text>
  );
}
