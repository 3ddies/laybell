import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import type { LiveChatMessage } from '../lib/live';
import { badgeRingColors, tierRank, type Tier } from '../lib/badges';
import MentionText from './MentionText';

// Live-chat overlay shared by the viewer feed (app/live/index.tsx) and the
// broadcaster screen (app/live/go-live.tsx). Built for busy rooms:
//  • useBufferedChat coalesces message bursts into ~3 renders/second instead of
//    one render per message, and caps scrollback so memory stays flat.
//  • The list is inverted (newest pinned at the visual bottom) and scrollable —
//    reading history holds position while new messages keep arriving, and
//    snaps back to live once scrolled near the bottom again.

// Names on lives are tinted with the sender's displayed badge-tier color; no
// badge (or an unrecognized tier from an older/foreign payload — tierRank 0)
// keeps the default white from the base style.
export function nameColor(tier: Tier | null | undefined) {
  if (tierRank(tier) <= 0) return null;
  // Gold's badge color (#F59E0B, amber-500) reads as bronze against the dark live
  // overlay — use a brighter, unmistakably-gold tone for names here so a gold host
  // never looks like a bronze one.
  if (tier === 'gold') return { color: '#FFC72C' };
  return { color: badgeRingColors(tier)[0] };
}

const KEEP = 80;      // scrollback cap — plenty to read back, flat memory
const FLUSH_MS = 350; // burst-coalescing window

export function useBufferedChat() {
  const [messages, setMessages] = useState<LiveChatMessage[]>([]);
  const buf = useRef<LiveChatMessage[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (!buf.current.length) return;
    const batch = buf.current;
    buf.current = [];
    setMessages((prev) => {
      // Realtime can redeliver on reconnect — drop ids we already show.
      const seen = new Set(prev.map((m) => m.id));
      const next = [...prev, ...batch.filter((m) => !seen.has(m.id))];
      return next.length > KEEP ? next.slice(next.length - KEEP) : next;
    });
  }, []);

  const push = useCallback((m: LiveChatMessage) => {
    buf.current.push(m);
    if (timer.current) return; // a flush window is already open — batch into it
    flush();                   // quiet room: show the message instantly
    timer.current = setTimeout(() => { timer.current = null; flush(); }, FLUSH_MS);
  }, [flush]);

  const clear = useCallback(() => {
    buf.current = [];
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setMessages([]);
  }, []);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return { messages, push, clear };
}

const Row = memo(function Row({ m, onPressName, onPressComment }: {
  m: LiveChatMessage;
  onPressName?: (m: LiveChatMessage) => void;
  onPressComment?: (m: LiveChatMessage) => void;
}) {
  // Press feedback for the name: instead of the boxy native highlight, we suppress
  // that and briefly underline the name while it's held (a clean, link-style cue
  // for which name was tapped).
  const [pressed, setPressed] = useState(false);
  return (
    // Tapping the comment body fires onPressComment; tapping the name (a nested
    // Text, so it wins the touch) fires onPressName; @mentions inside the text are
    // their own tappable blue spans (MentionText → open that user's profile).
    <Text
      style={styles.line}
      numberOfLines={3}
      suppressHighlighting
      onPress={onPressComment ? () => onPressComment(m) : undefined}
    >
      <Text
        style={[styles.name, nameColor(m.tier), pressed && styles.namePressed]}
        suppressHighlighting
        onPressIn={onPressName ? () => setPressed(true) : undefined}
        onPressOut={onPressName ? () => setPressed(false) : undefined}
        onPress={onPressName ? () => onPressName(m) : undefined}
      >
        {m.name}
      </Text>
      {'  '}
      <MentionText text={m.text} mentionStyle={styles.mention} />
    </Text>
  );
});

/** Rendered without virtualization; see `plain` below. */
const PLAIN_KEEP = 25;

export default function LiveChatOverlay({ messages, maxHeight = 210, style, plain = false, fill = false, onPressName, onPressComment }: {
  messages: LiveChatMessage[];
  maxHeight?: number;
  style?: StyleProp<ViewStyle>;
  /**
   * Render as plain Views instead of a FlatList.
   *
   * For the ONE place this sits inside a vertical ScrollView — the studio
   * session room. A VirtualizedList nested in a ScrollView of the same
   * orientation is not merely a console warning: windowing breaks, and the
   * inner list can steal drags meant for the outer scroll. Virtualization buys
   * nothing at this size anyway (the buffer caps at 80 and the strip shows
   * about five), so the nested case renders the tail directly and the problem
   * stops existing rather than being suppressed.
   *
   * The cost is scrollback inside the strip, which is why it is opt-in: the
   * live screens are not nested and keep the real list.
   */
  plain?: boolean;
  /**
   * Fill the parent instead of hugging the messages.
   *
   * A real prop rather than something a caller can pass through `style`,
   * because the two cannot be merged: the default carries flexGrow:0, and
   * layering flex:1 on top leaves BOTH on the resolved style — flexBasis 0 with
   * no permission to grow, i.e. a list of zero height that renders nothing.
   *
   * Use it wherever the chat sits in a fixed-height strip: hugging makes the
   * empty space above the messages belong to something else, so a drag there
   * does not scroll.
   */
  fill?: boolean;
  // Tap a name / comment → the host or viewer screen decides (open profile,
  // prefill a reply, …). Both receive the full message.
  onPressName?: (m: LiveChatMessage) => void;
  onPressComment?: (m: LiveChatMessage) => void;
}) {
  // Inverted list ⇒ data index 0 renders at the visual bottom, so feed newest-first.
  const data = useMemo(() => [...messages].reverse(), [messages]);

  if (plain) {
    // Natural order with the newest last is the same picture an inverted list
    // paints, without the list.
    const tail = messages.slice(-PLAIN_KEEP);
    return (
      <View style={[{ maxHeight, overflow: 'hidden' }, styles.content, style]}>
        {tail.map((m) => (
          <Row key={m.id} m={m} onPressName={onPressName} onPressComment={onPressComment} />
        ))}
      </View>
    );
  }

  return (
    <FlatList
      data={data}
      inverted
      keyExtractor={(m) => m.id}
      // Let a tap on a chat name register while the keyboard is up instead of
      // being swallowed just to dismiss it.
      keyboardShouldPersistTaps="handled"
      renderItem={({ item }) => <Row m={item} onPressName={onPressName} onPressComment={onPressComment} />}
      // Hug the messages (flexGrow 0 + maxHeight) unless asked to fill — the two
      // are mutually exclusive and must not be combined; see `fill`.
      style={[fill ? { flex: 1 } : { maxHeight, flexGrow: 0 }, style]}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      nestedScrollEnabled
      // Pinned-to-live unless the user scrolled up to read history; snaps back
      // to following once they return near the newest message.
      maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 40 }}
    />
  );
}

const styles = StyleSheet.create({
  content: { gap: 6, paddingVertical: 2 },
  line: { color: 'rgba(255,255,255,0.92)', fontSize: 15, lineHeight: 20, textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 4 },
  name: { fontWeight: '700', color: '#fff' },
  namePressed: { textDecorationLine: 'underline' },
  // @mentions inside a chat message — a bright, clearly-blue tappable span that
  // stays legible over the dark broadcast.
  mention: { color: '#4DA6FF', fontWeight: '600' },
});
