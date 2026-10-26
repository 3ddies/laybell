import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

// The visual for a 'poll' story sticker. Shared by the composer (a static preview,
// no results, no voting) and the story viewer (tappable, with live result bars).
// Fixed colors — it always sits over story media, so it doesn't follow the app theme.

export type PollResults = { counts: number[]; total: number; myChoice: number };

// Options are color-coded by meaning: yes (and its cousins) → green, no → red, and
// anything else → orange. Shared with the viewers-list choice pill so the author
// sees the same color there.
export type PollTone = 'yes' | 'no' | 'other';
export const POLL_TONE_HEX: Record<PollTone, string> = { yes: '#22C55E', no: '#F43F5E', other: '#F26522' };

const YES = new Set(['yes', 'yeah', 'yep', 'yup', 'ya', 'yah', 'yea', 'aye', 'sure', 'ok', 'okay', 'agree', 'agreed', 'true', 'definitely', 'absolutely', 'totally', 'affirmative', 'si', 'oui', 'ja']);
const NO = new Set(['no', 'nope', 'nah', 'naw', 'never', 'disagree', 'false', 'nay', 'non', 'nein', 'incorrect', 'negative']);

export function pollOptionTone(text: string): PollTone {
  const w = (text || '').toLowerCase().match(/[a-z]+/)?.[0] ?? '';
  if (YES.has(w) || /^y+e+s+$/.test(w) || /^y+u+p+$/.test(w)) return 'yes';       // "yesss", "yuuup"
  if (NO.has(w) || /^n+o+$/.test(w) || /^n+a+h+$/.test(w)) return 'no';           // "nooo", "nahhh"
  return 'other';
}

export function PollStickerContent({
  question, options, results, onVote,
}: {
  question: string;
  options: string[];
  results?: PollResults | null; // absent → plain options (composer / pre-vote)
  onVote?: (i: number) => void; // present only in the viewer, before a vote is cast
}) {
  const voted = !!results;
  return (
    <View style={styles.card}>
      <Text style={styles.q} numberOfLines={3}>{question || 'Ask a question…'}</Text>
      <View style={styles.opts}>
        {options.map((opt, i) => {
          const hex = POLL_TONE_HEX[pollOptionTone(opt)];
          const count = results?.counts[i] ?? 0;
          const pct = results && results.total > 0 ? Math.round((count / results.total) * 100) : 0;
          const mine = results?.myChoice === i;
          return (
            <Pressable
              key={i}
              disabled={!onVote || voted}
              onPress={() => onVote?.(i)}
              style={[styles.opt, { backgroundColor: hex + '2E' }]}
            >
              {voted && <View style={[styles.bar, { backgroundColor: hex + (mine ? 'CC' : '80'), width: `${pct}%` }]} />}
              <View style={styles.optRow}>
                <Text style={[styles.optText, mine && styles.optTextMine]} numberOfLines={1}>
                  {opt || `Option ${i + 1}`}
                </Text>
                {voted && (
                  <View style={styles.pctWrap}>
                    {mine && <Ionicons name="checkmark-circle" size={14} color="#fff" />}
                    <Text style={styles.pct}>{pct}%</Text>
                  </View>
                )}
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 256, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 20,
    paddingHorizontal: 14, paddingVertical: 14,
    shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 4,
  },
  q: { color: '#fff', fontSize: 17, fontWeight: '800', textAlign: 'center' },
  opts: { gap: 8, marginTop: 12 },
  opt: { borderRadius: 12, overflow: 'hidden', minHeight: 40, justifyContent: 'center' },
  bar: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  optRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 9, gap: 8 },
  optText: { color: '#fff', fontSize: 15, fontWeight: '700', flexShrink: 1 },
  optTextMine: { fontWeight: '800' },
  pctWrap: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pct: { color: '#fff', fontSize: 14, fontWeight: '800' },
});
