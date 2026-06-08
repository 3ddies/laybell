import { Text } from 'react-native';

// Renders `text` with every (case-insensitive) occurrence of `query` wrapped in
// `highlightStyle`. Used to highlight search matches in usernames and message text.
export default function HighlightText({ text, query, style, highlightStyle, numberOfLines }: {
  text?: string | null;
  query?: string;
  style?: any;
  highlightStyle?: any;
  numberOfLines?: number;
}) {
  const t = text ?? '';
  const q = (query ?? '').trim();
  if (!q) return <Text style={style} numberOfLines={numberOfLines}>{t}</Text>;

  const lower = t.toLowerCase();
  const ql = q.toLowerCase();
  const segments: { s: string; hl: boolean }[] = [];
  let i = 0;
  while (i < t.length) {
    const idx = lower.indexOf(ql, i);
    if (idx < 0) { segments.push({ s: t.slice(i), hl: false }); break; }
    if (idx > i) segments.push({ s: t.slice(i, idx), hl: false });
    segments.push({ s: t.slice(idx, idx + ql.length), hl: true });
    i = idx + ql.length;
  }

  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {segments.map((seg, k) => (seg.hl ? <Text key={k} style={highlightStyle}>{seg.s}</Text> : seg.s))}
    </Text>
  );
}
