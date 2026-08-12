import { memo, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

// Emoji that people type in the chat float up the screen for everyone.
//
// There is deliberately NO new broadcast for this. Every client already
// receives every chat message, so each one can read the emoji out of the text
// it just got and animate them locally. Same input, same output, on every
// device — a second channel event would only add a way for the two to disagree.
//
// It also means the feature is free of round trips: the emoji lift off at the
// same moment the message lands, rather than a beat behind it.

/** Cheap and Hermes-safe: property escapes (\p{...}) are not reliable there. */
const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F0FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2764}]/gu;

/** Per message, so one person cannot fill the screen with a wall of emoji. */
const MAX_PER_MESSAGE = 4;
/** Concurrent floaters. Past this the oldest are dropped rather than queued. */
const MAX_ON_SCREEN = 18;
const RISE_MS = 2900;

type Floater = { key: string; char: string; lane: number; drift: number; delay: number; size: number };

let seq = 0;

/** Pull the emoji out of a message, in order, deduped only by run. */
export function emojiFrom(text: string): string[] {
  const found = text.match(EMOJI_RE);
  if (!found) return [];
  // Variation selectors ride along on their own; they are invisible alone.
  const real = found.filter((c) => c !== '️');
  return real.slice(0, MAX_PER_MESSAGE);
}

const Bubble = memo(function Bubble({ item, onDone }: { item: Floater; onDone: (key: string) => void }) {
  const { height } = useWindowDimensions();
  const t = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.timing(t, {
      toValue: 1,
      duration: RISE_MS,
      delay: item.delay,
      easing: Easing.out(Easing.quad),   // quick lift, slow drift at the top
      useNativeDriver: true,
    });
    anim.start(({ finished }) => { if (finished) onDone(item.key); });
    return () => anim.stop();
  }, [item, onDone, t]);

  const rise = Math.min(height * 0.55, 420);
  return (
    <Animated.Text
      style={[
        styles.bubble,
        {
          left: `${item.lane}%`,
          fontSize: item.size,
          opacity: t.interpolate({ inputRange: [0, 0.1, 0.72, 1], outputRange: [0, 1, 1, 0] }),
          transform: [
            { translateY: t.interpolate({ inputRange: [0, 1], outputRange: [0, -rise] }) },
            // A lazy S rather than a straight line — three stops is enough to
            // read as drift and costs nothing.
            { translateX: t.interpolate({ inputRange: [0, 0.35, 0.7, 1], outputRange: [0, item.drift, -item.drift * 0.6, item.drift * 0.3] }) },
            { scale: t.interpolate({ inputRange: [0, 0.14, 1], outputRange: [0.5, 1.15, 0.95] }) },
          ],
        },
      ]}
    >
      {item.char}
    </Animated.Text>
  );
});

/**
 * Floats the emoji from `messages` as they arrive.
 *
 * Render it ABOVE the content and below the input — it is pointer-transparent,
 * so it never eats a tap meant for anything underneath.
 */
function FloatingReactions({ messages }: { messages: Array<{ id: string; text: string }> }) {
  const [items, setItems] = useState<Floater[]>([]);
  // Messages already accounted for. Without this, any re-render that changed
  // the array identity would re-float the whole visible backlog.
  const seen = useRef<Set<string>>(new Set());
  const [reduce, setReduce] = useState(false);

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (alive) setReduce(!!v); });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => setReduce(!!v));
    return () => { alive = false; sub?.remove?.(); };
  }, []);

  useEffect(() => {
    if (reduce) return;
    const fresh: Floater[] = [];
    for (const m of messages) {
      if (!m?.id || seen.current.has(m.id)) continue;
      seen.current.add(m.id);
      emojiFrom(m.text || '').forEach((char, i) => {
        fresh.push({
          key: `${m.id}-${i}-${seq++}`,
          char,
          // Kept off the edges so a wide glyph is never half off-screen.
          lane: 12 + Math.floor(((seq * 37) % 76)),
          drift: 14 + ((seq * 13) % 26),
          delay: i * 140,
          size: 26 + ((seq * 7) % 12),
        });
      });
    }
    if (!fresh.length) return;
    setItems((prev) => [...prev, ...fresh].slice(-MAX_ON_SCREEN));
  }, [messages, reduce]);

  // A chat that has scrolled past its cap would otherwise grow this set forever.
  useEffect(() => {
    if (seen.current.size > 400) seen.current = new Set(messages.map((m) => m.id));
  }, [messages]);

  const remove = useRef((key: string) => {
    setItems((prev) => prev.filter((i) => i.key !== key));
  }).current;

  if (!items.length) return null;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {items.map((i) => <Bubble key={i.key} item={i} onDone={remove} />)}
    </View>
  );
}

const styles = StyleSheet.create({
  // Anchored near the bottom, where the chat is — they rise out of the
  // conversation rather than appearing from nowhere.
  bubble: { position: 'absolute', bottom: 90, textShadowColor: 'rgba(0,0,0,0.45)', textShadowRadius: 6 },
});

export default memo(FloatingReactions);
