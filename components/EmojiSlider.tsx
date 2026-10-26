import { useRef, useState } from 'react';
import { View, Text, StyleSheet, PanResponder, type GestureResponderEvent } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

// Instagram-style emoji slider: an optional prompt over a gradient track with an emoji
// knob. Static in the composer/tray preview; in the viewer `interactive` makes the knob
// draggable and fires onRelease(0–100) when the viewer lets go. Pure presentation + a
// local drag — the host decides what the released value does.
const FILL = ['#F58529', '#DD2A7B'] as const;

export function EmojiSliderContent({
  prompt, emoji, interactive, onRelease, compact,
}: { prompt?: string; emoji?: string; interactive?: boolean; onRelease?: (pct: number) => void; compact?: boolean }) {
  const e = emoji || '😍';
  const trackW = compact ? 132 : 210;
  const knob = compact ? 24 : 38;
  const [frac, setFrac] = useState(interactive ? 0.08 : 0.3);
  const live = useRef(frac); live.current = frac;
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !!interactive,
      onMoveShouldSetPanResponder: () => !!interactive,
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (ev: GestureResponderEvent) => setFrac(Math.max(0, Math.min(1, ev.nativeEvent.locationX / trackW))),
      onPanResponderRelease: () => onRelease?.(Math.round(live.current * 100)),
    }),
  ).current;
  const knobLeft = frac * (trackW - knob);
  return (
    <View style={[styles.card, compact && styles.cardCompact]}>
      {!!prompt && <Text style={[styles.prompt, compact && styles.promptCompact]} numberOfLines={2}>{prompt}</Text>}
      <View style={[styles.track, { width: trackW }]} {...(interactive ? pan.panHandlers : {})}>
        <LinearGradient colors={FILL} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={[styles.fill, { width: knobLeft + knob / 2 }]} />
        <View style={[styles.knob, { left: knobLeft, width: knob, height: knob, borderRadius: knob / 2 }]}>
          <Text style={{ fontSize: knob * 0.64 }}>{e}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff', borderRadius: 22, paddingHorizontal: 18, paddingVertical: 16, alignItems: 'center', gap: 16,
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 9, shadowOffset: { width: 0, height: 3 }, elevation: 5,
  },
  cardCompact: { borderRadius: 16, paddingHorizontal: 12, paddingVertical: 11, gap: 11 },
  prompt: { color: '#17171A', fontSize: 16, fontWeight: '800', textAlign: 'center' },
  promptCompact: { fontSize: 12 },
  track: { height: 7, borderRadius: 4, backgroundColor: '#E6E6EB', justifyContent: 'center' },
  fill: { position: 'absolute', left: 0, height: 7, borderRadius: 4 },
  knob: {
    position: 'absolute', backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 3,
  },
});
