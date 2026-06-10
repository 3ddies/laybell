import { Text, type StyleProp, type TextStyle } from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '../lib/supabase';
import { COLORS } from '../constants/theme';

// Renders caption / comment text with @mentions as tappable, highlighted spans
// that open the mentioned user's profile. Drop-in replacement for a plain <Text>.
// Resolves username → id on tap (usernames are stored lowercase; matched ci).

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
  text, style, mentionStyle, numberOfLines,
}: {
  text?: string | null;
  style?: StyleProp<TextStyle>;
  mentionStyle?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  const router = useRouter();
  if (!text) return null;

  const segs = parse(text);
  // No mentions → just a plain Text (avoids the nested-Text overhead).
  if (!segs.some((s) => s.t === 'm')) {
    return <Text style={style} numberOfLines={numberOfLines}>{text}</Text>;
  }

  async function go(username: string) {
    const { data } = await supabase.from('profiles').select('id').ilike('username', username).maybeSingle();
    if (data?.id) router.push(`/profile/${data.id}`);
  }

  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {segs.map((s, i) =>
        s.t === 'm' ? (
          <Text key={i} style={[{ color: COLORS.primary, fontWeight: '600' }, mentionStyle]} onPress={() => go(s.u!)}>
            {s.v}
          </Text>
        ) : (
          <Text key={i}>{s.v}</Text>
        ),
      )}
    </Text>
  );
}
