import { useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Dimensions, PanResponder } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { barsFor } from '../lib/waveformBars';
import { percent } from '../lib/songMix';

// The video studio's sound controls (components/VideoStudio): the song strip that
// chooses which part of the song plays, and a plain volume slider. Always dark —
// they sit over the video, not on the theme.

const { width: SCREEN_W } = Dimensions.get('window');
/** Horizontal padding of the panel these sit in; the strip spans the rest. */
export const SOUND_H_PAD = 16;
const BAR_COUNT = 56;
const BAR_GAP = 2;

// The whole song as a strip of bars, with a window the length of the video that
// drags along it: where the window starts is where the song starts. Dragging
// anywhere on the strip moves the window, the way a waveform scrolls under a fixed
// selection elsewhere. The start commits on release; the label follows the finger.
export function SongPartStrip({ seed, songSec, windowSec, startSec, onDrag, onCommit }: {
  seed: string;
  songSec: number;
  windowSec: number;
  startSec: number;
  onDrag: (sec: number | null) => void;
  onCommit: (sec: number) => void;
}) {
  const trackW = SCREEN_W - SOUND_H_PAD * 2;
  const bars = useMemo(() => barsFor(seed, BAR_COUNT), [seed]);
  const barW = (trackW - BAR_GAP * (BAR_COUNT - 1)) / BAR_COUNT;
  const fit = Math.min(windowSec > 0 ? windowSec : songSec, songSec);
  const winW = Math.max(28, Math.min(trackW, (fit / songSec) * trackW));
  const room = Math.max(0, songSec - fit);   // seconds the start can travel
  const maxX = Math.max(0, trackW - winW);
  const secToX = (s: number) => (room > 0 ? (Math.min(room, Math.max(0, s)) / room) * maxX : 0);

  const [dragX, setDragX] = useState<number | null>(null);
  // Everything the once-created responder reads, refreshed each render.
  const live = useRef({ room, maxX, startSec, onDrag, onCommit });
  live.current = { room, maxX, startSec, onDrag, onCommit };
  const grab = useRef(0);
  const xToSec = (x: number) => {
    const L = live.current;
    return L.maxX > 0 ? (Math.min(L.maxX, Math.max(0, x)) / L.maxX) * L.room : 0;
  };
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => live.current.room > 0,
    onMoveShouldSetPanResponder: () => live.current.room > 0,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => {
      const L = live.current;
      grab.current = L.room > 0 ? (Math.min(L.room, L.startSec) / L.room) * L.maxX : 0;
    },
    onPanResponderMove: (_e, g) => {
      const x = Math.min(live.current.maxX, Math.max(0, grab.current + g.dx));
      setDragX(x);
      live.current.onDrag(xToSec(x));
    },
    onPanResponderRelease: (_e, g) => {
      const x = Math.min(live.current.maxX, Math.max(0, grab.current + g.dx));
      setDragX(null);
      live.current.onDrag(null);
      live.current.onCommit(xToSec(x));
    },
    onPanResponderTerminate: () => { setDragX(null); live.current.onDrag(null); },
  })).current;

  const x = dragX ?? secToX(startSec);
  return (
    <View style={[styles.strip, { width: trackW }]} {...pan.panHandlers}>
      <View style={styles.bars} pointerEvents="none">
        {bars.map((b, i) => {
          const cx = i * (barW + BAR_GAP) + barW / 2;
          const inside = cx >= x && cx <= x + winW;
          return (
            <View
              key={i}
              style={[
                styles.bar,
                { width: barW, height: `${Math.round(b * 100)}%`, marginRight: i === BAR_COUNT - 1 ? 0 : BAR_GAP },
                inside && styles.barInside,
              ]}
            />
          );
        })}
      </View>
      <View pointerEvents="none" style={[styles.window, { left: x, width: winW }]} />
    </View>
  );
}

// A plain 0–100% slider. No slider ships with React Native and this project adds
// no native modules without asking, so it is a track and a responder: pageX
// against the measured track, because locationX is relative to whichever child
// the finger lands on.
export function VolumeSlider({ icon, label, value, onChange }: {
  icon: 'musical-notes' | 'videocam';
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  const trackRef = useRef<View>(null);
  const trackX = useRef(0);
  const trackW = useRef(1);
  const live = useRef({ onChange });
  live.current = { onChange };
  const [drag, setDrag] = useState<number | null>(null);
  const measure = () => {
    trackRef.current?.measureInWindow((x, _y, w) => {
      if (Number.isFinite(x)) trackX.current = x;
      if (w > 0) trackW.current = w;
    });
  };
  const toValue = (pageX: number) => Math.min(1, Math.max(0, (pageX - trackX.current) / trackW.current));
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => { const v = toValue(e.nativeEvent.pageX); setDrag(v); live.current.onChange(v); },
    onPanResponderMove: (e) => { const v = toValue(e.nativeEvent.pageX); setDrag(v); live.current.onChange(v); },
    onPanResponderRelease: () => setDrag(null),
    onPanResponderTerminate: () => setDrag(null),
  })).current;
  const v = drag ?? value;
  return (
    <View style={styles.sliderRow}>
      <Ionicons name={icon} size={16} color="#fff" />
      <Text style={styles.sliderLabel} numberOfLines={1}>{label}</Text>
      <View ref={trackRef} onLayout={measure} style={styles.sliderHit} {...pan.panHandlers}>
        <View style={styles.sliderTrack} pointerEvents="none">
          <View style={[styles.sliderFill, { width: `${v * 100}%` }]} />
        </View>
        <View pointerEvents="none" style={[styles.sliderThumb, { left: `${v * 100}%` }]} />
      </View>
      <Text style={styles.sliderValue}>{percent(v)}%</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { height: 56, justifyContent: 'center' },
  bars: { ...StyleSheet.absoluteFillObject, flexDirection: 'row', alignItems: 'center' },
  bar: { borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.28)' },
  barInside: { backgroundColor: '#FAB525' },
  window: {
    position: 'absolute', top: 0, bottom: 0, borderRadius: 10,
    borderWidth: 2, borderColor: '#fff', backgroundColor: 'rgba(255,255,255,0.08)',
  },
  sliderRow: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 36 },
  sliderLabel: { width: 108, color: '#fff', fontSize: 13, fontWeight: '700' },
  sliderHit: { flex: 1, height: 36, justifyContent: 'center' },
  sliderTrack: { height: 4, borderRadius: 2, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.25)' },
  sliderFill: { height: '100%', backgroundColor: '#fff' },
  sliderThumb: {
    position: 'absolute', width: 18, height: 18, marginLeft: -9, top: 9, borderRadius: 9, backgroundColor: '#fff',
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 3, shadowOffset: { width: 0, height: 1 },
  },
  sliderValue: { width: 42, color: '#fff', fontSize: 12, fontWeight: '700', textAlign: 'right', fontVariant: ['tabular-nums'] },
});
