import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import type { LiveChatMessage } from '../lib/live';
import { badgeRingColors, tierRank, type Tier } from '../lib/badges';

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
  return tierRank(tier) > 0 ? { color: badgeRingColors(tier)[0] } : null;
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

const Row = memo(function Row({ m }: { m: LiveChatMessage }) {
  return (
    <Text style={styles.line} numberOfLines={3}>
      <Text style={[styles.name, nameColor(m.tier)]}>{m.name}  </Text>
      {m.text}
    </Text>
  );
});

export default function LiveChatOverlay({ messages, maxHeight = 210, style }: {
  messages: LiveChatMessage[];
  maxHeight?: number;
  style?: StyleProp<ViewStyle>;
}) {
  // Inverted list ⇒ data index 0 renders at the visual bottom, so feed newest-first.
  const data = useMemo(() => [...messages].reverse(), [messages]);
  return (
    <FlatList
      data={data}
      inverted
      keyExtractor={(m) => m.id}
      renderItem={({ item }) => <Row m={item} />}
      // flexGrow 0 + maxHeight: hugs its content while the room is quiet,
      // stops growing (and scrolls) once chat fills the strip.
      style={[{ maxHeight, flexGrow: 0 }, style]}
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
  content: { gap: 5, paddingVertical: 2 },
  line: { color: 'rgba(255,255,255,0.92)', fontSize: 13, textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 4 },
  name: { fontWeight: '700', color: '#fff' },
});
