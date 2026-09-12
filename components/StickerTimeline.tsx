import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { View, Text, StyleSheet, PanResponder, Dimensions, Image, TouchableOpacity } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from '../contexts/LanguageContext';
import { getPlaybackPosition, subscribePlayback } from '../lib/playbackClock';
import { MIN_SHOW_SEC } from '../lib/stickerTiming';
import { useFilmstrip } from '../hooks/useFilmstrip';

// The caption editor's timeline: play, scrub the posted window over a filmstrip,
// and — for the selected caption — drag the ends of its bar to choose when it
// shows (lib/stickerTiming). Always dark: it sits on the video, not the theme.
//
// Everything a gesture reads lives behind a ref refreshed each render, because a
// PanResponder made in useRef closes over its first render forever. Range drags
// track the finger in local state and commit on release — per-frame parent
// updates are how VideoTrimmer's "slider lags" happened.
//
// The playhead is read from lib/playbackClock by two tiny children, so the
// player's progress ticks re-render a line and a label, not the panel.

const SCREEN_W = Dimensions.get('window').width;
const STRIP_COUNT = 8;
const H_PAD = 14;
const PLAY_W = 40;
const GAP = 10;
/** Panel height above the bottom safe-area inset — the editor keeps its hint and tray clear of it. */
export const TIMELINE_H = 126;

function fmt(t: number) {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

function usePosition(clockId: string) {
  const subscribe = useCallback((cb: () => void) => subscribePlayback(clockId, cb), [clockId]);
  return useSyncExternalStore(subscribe, () => getPlaybackPosition(clockId));
}

function PlayheadLine({ clockId, windowStart, span, trackW }: { clockId: string; windowStart: number; span: number; trackW: number }) {
  const pos = usePosition(clockId);
  const x = Math.min(trackW, Math.max(0, ((pos - windowStart) / span) * trackW));
  return <View pointerEvents="none" style={[styles.playhead, { left: x - 1 }]} />;
}

function PlayheadTime({ clockId, windowStart, windowEnd }: { clockId: string; windowStart: number; windowEnd: number }) {
  const pos = usePosition(clockId);
  return <Text style={styles.time}>{fmt(pos - windowStart)} / {fmt(windowEnd - windowStart)}</Text>;
}

type Props = {
  /** The lib/playbackClock id the editor's player writes its position to. */
  clockId: string;
  /** A playable local clip for the filmstrip; null shows the poster in every cell. */
  uri: string | null;
  posterUri: string | null;
  /** The part of the clip that gets posted, in seconds on the source's clock. */
  windowStart: number;
  windowEnd: number;
  canPlay: boolean;
  playing: boolean;
  onTogglePlay: () => void;
  /** Live while the strip is scrubbed or a range end is dragged. */
  onScrub: (sec: number) => void;
  onScrubEnd: () => void;
  /** The selected caption's window, or null when none is selected. */
  selected: { start: number; end: number } | null;
  /** The selected caption shows for the whole posted window. */
  wholeVideo: boolean;
  /** Committed when a range drag is released. */
  onRangeChange: (start: number, end: number) => void;
  bottomInset: number;
  /** The line shown while no caption is selected; the timing hint by default. */
  idleHint?: string;
};

export default function StickerTimeline({
  clockId, uri, posterUri, windowStart, windowEnd, canPlay, playing, onTogglePlay,
  onScrub, onScrubEnd, selected, wholeVideo, onRangeChange, bottomInset, idleHint,
}: Props) {
  const { t } = useTranslation();
  const trackW = SCREEN_W - H_PAD * 2 - PLAY_W - GAP;
  const span = Math.max(0.001, windowEnd - windowStart);
  const secToX = (s: number) => Math.min(trackW, Math.max(0, ((s - windowStart) / span) * trackW));
  const minW = Math.min(trackW, (MIN_SHOW_SEC / span) * trackW);

  // Filmstrip across the POSTED window — decoded one frame at a time, filling left
  // to right, and kept for the session (hooks/useFilmstrip).
  const strip = useFilmstrip(uri, windowStart, windowEnd, STRIP_COUNT);

  // Latest values for the once-created responders.
  const live = useRef({ trackW, span, windowStart, minW, onScrub, onScrubEnd, onRangeChange, selected });
  live.current = { trackW, span, windowStart, minW, onScrub, onScrubEnd, onRangeChange, selected };
  const xToSec = (x: number) => {
    const L = live.current;
    return L.windowStart + (Math.min(L.trackW, Math.max(0, x)) / L.trackW) * L.span;
  };

  // pageX, not locationX: locationX is relative to whichever child view the
  // finger landed on (a filmstrip cell), not the strip.
  const stripRef = useRef<View>(null);
  const stripX = useRef(H_PAD + PLAY_W + GAP);
  const measureStrip = () => {
    stripRef.current?.measureInWindow((x) => { if (Number.isFinite(x)) stripX.current = x; });
  };
  const scrubPan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => live.current.onScrub(xToSec(e.nativeEvent.pageX - stripX.current)),
    onPanResponderMove: (e) => live.current.onScrub(xToSec(e.nativeEvent.pageX - stripX.current)),
    onPanResponderRelease: () => live.current.onScrubEnd(),
    onPanResponderTerminate: () => live.current.onScrubEnd(),
  })).current;

  // The selected caption's bar, in px while a handle or the bar itself is held;
  // null means "follow `selected`". The video follows the edge being dragged, so
  // you see the exact frame the caption will appear or leave on.
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const grab = useRef({ a: 0, b: 0 });
  const cur = useRef({ a: 0, b: 0 });
  const makeRangePan = (kind: 'start' | 'end' | 'body') => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => {
      const L = live.current;
      const s = L.selected;
      if (!s) return;
      const a = ((s.start - L.windowStart) / L.span) * L.trackW;
      const b = ((s.end - L.windowStart) / L.span) * L.trackW;
      grab.current = { a, b };
      cur.current = { a, b };
    },
    onPanResponderMove: (_e, g) => {
      const L = live.current;
      if (!L.selected) return;
      const { a: ga, b: gb } = grab.current;
      let a = ga;
      let b = gb;
      if (kind === 'start') a = Math.min(Math.max(ga + g.dx, 0), gb - L.minW);
      else if (kind === 'end') b = Math.max(Math.min(gb + g.dx, L.trackW), ga + L.minW);
      else {
        const w = gb - ga;
        a = Math.min(Math.max(ga + g.dx, 0), L.trackW - w);
        b = a + w;
      }
      cur.current = { a, b };
      setDrag({ a, b });
      L.onScrub(xToSec(kind === 'end' ? b : a));
    },
    onPanResponderRelease: () => {
      const L = live.current;
      if (L.selected) L.onRangeChange(xToSec(cur.current.a), xToSec(cur.current.b));
      setDrag(null);
      L.onScrubEnd();
    },
    onPanResponderTerminate: () => {
      setDrag(null);
      live.current.onScrubEnd();
    },
  });
  const startPan = useRef(makeRangePan('start')).current;
  const endPan = useRef(makeRangePan('end')).current;
  const bodyPan = useRef(makeRangePan('body')).current;

  const bar = drag ?? (selected ? { a: secToX(selected.start), b: secToX(selected.end) } : null);

  return (
    <View style={[styles.panel, { paddingBottom: bottomInset + 10 }]}>
      <View style={styles.row}>
        {canPlay ? (
          <TouchableOpacity
            style={styles.playBtn}
            onPress={onTogglePlay}
            accessibilityRole="button"
            accessibilityLabel={playing ? t('a11y.pause') : t('a11y.play')}
          >
            <Ionicons name={playing ? 'pause' : 'play'} size={20} color="#fff" />
          </TouchableOpacity>
        ) : (
          <View style={styles.playBtnGhost} />
        )}
        <View style={{ width: trackW }}>
          <View ref={stripRef} onLayout={measureStrip} style={styles.strip} {...scrubPan.panHandlers}>
            {strip.map((u, i) => (
              <View key={i} style={styles.stripCell} pointerEvents="none">
                {posterUri ? <ExpoImage source={{ uri: posterUri }} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
                {u ? <Image source={{ uri: u }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
              </View>
            ))}
            <PlayheadLine clockId={clockId} windowStart={windowStart} span={span} trackW={trackW} />
          </View>
          <View style={styles.rangeRow}>
            {bar ? (
              <View style={[styles.rangeBar, { left: bar.a, width: Math.max(minW, bar.b - bar.a) }]}>
                {/* Body first, handles after, so the ends win the touch. */}
                <View style={StyleSheet.absoluteFill} {...bodyPan.panHandlers} />
                <View style={[styles.handle, styles.handleStart]} hitSlop={{ left: 14, right: 8, top: 10, bottom: 10 }} {...startPan.panHandlers}>
                  <View style={styles.grip} />
                </View>
                <View style={[styles.handle, styles.handleEnd]} hitSlop={{ left: 8, right: 14, top: 10, bottom: 10 }} {...endPan.panHandlers}>
                  <View style={styles.grip} />
                </View>
              </View>
            ) : null}
          </View>
        </View>
      </View>
      <View style={styles.labels}>
        <PlayheadTime clockId={clockId} windowStart={windowStart} windowEnd={windowEnd} />
        <Text style={styles.hint} numberOfLines={1}>
          {selected
            ? `${wholeVideo ? t('topcap.wholeVideo') : `${fmt(selected.start - windowStart)}–${fmt(selected.end - windowStart)}`} · ${t('topcap.timingDrag')}`
            : idleHint ?? t('topcap.timingHint')}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingTop: 10, paddingHorizontal: H_PAD, backgroundColor: 'rgba(0,0,0,0.6)',
  },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: GAP },
  playBtn: {
    width: PLAY_W, height: 44, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.16)',
  },
  playBtnGhost: { width: PLAY_W, height: 44 },
  strip: { height: 44, borderRadius: 8, overflow: 'hidden', flexDirection: 'row', backgroundColor: '#1a1a1a' },
  stripCell: { flex: 1, height: '100%' },
  playhead: {
    position: 'absolute', top: 0, bottom: 0, width: 2, borderRadius: 1, backgroundColor: '#fff',
    shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 2, shadowOffset: { width: 0, height: 0 },
  },
  rangeRow: { height: 28, marginTop: 8, borderRadius: 7, backgroundColor: 'rgba(255,255,255,0.1)' },
  rangeBar: { position: 'absolute', top: 0, bottom: 0, borderRadius: 7, backgroundColor: '#FAB525' },
  handle: { position: 'absolute', top: 0, bottom: 0, width: 16, alignItems: 'center', justifyContent: 'center' },
  handleStart: { left: 0 },
  handleEnd: { right: 0 },
  grip: { width: 3, height: 12, borderRadius: 2, backgroundColor: 'rgba(0,0,0,0.5)' },
  labels: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10,
    marginTop: 8, paddingLeft: PLAY_W + GAP,
  },
  time: { color: '#fff', fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
  hint: { color: 'rgba(255,255,255,0.78)', fontSize: 12, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
});
