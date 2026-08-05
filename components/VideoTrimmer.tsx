import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, PanResponder, Dimensions, Image } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

const SCREEN_W = Dimensions.get('window').width;
// Frames sampled across the whole clip to build the scrubber's filmstrip. Eight
// is the sweet spot at phone widths (~45px each): enough to recognise scenes,
// few enough that generating them doesn't stall the composer.
const STRIP_COUNT = 8;
// Shortest selection the edges can be pinched to.
const MIN_SEC = 1;

function fmt(t: number) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Choose which segment of a longer video to post. The window can be DRAGGED as a
// whole, and either edge can be dragged independently to shorten the selection —
// so a clip can be cut at the start, the end, or both, down to well under the
// cap (`windowSec` — per-orientation, set by the composer). The track shows a
// filmstrip so you can see what you're selecting
// rather than guessing from timestamps.
//
// The poster (ph:// via expo-image) backs every frame cell so the strip is never
// a blank grey bar, even before thumbnails land or if they fail outright.
export default function VideoTrimmer({ uri, posterUri, duration, windowSec, frameW, frameH, onChange, initialStart = 0, initialEnd }: {
  uri: string;
  posterUri?: string;
  duration: number;
  windowSec: number;
  frameW: number;
  frameH: number;
  onChange: (start: number, end: number) => void;
  // Seconds to open the window at — used when re-entering trim for a resumed
  // draft so the saved selection is shown (and kept) instead of resetting.
  initialStart?: number;
  initialEnd?: number;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const trackW = SCREEN_W - SPACING.md * 2;
  const safeDur = duration > 0 ? duration : 1;
  const secToX = (s: number) => (s / safeDur) * trackW;
  const xToSec = (x: number) => (x / trackW) * safeDur;

  // Max window = the cap (or the whole clip if it's shorter); min = MIN_SEC.
  const maxW = secToX(Math.min(windowSec, safeDur));
  const minW = Math.min(secToX(MIN_SEC), maxW);

  const init0 = Math.min(Math.max(secToX(initialStart), 0), trackW - minW);
  const init1 = Math.min(
    Math.max(secToX(initialEnd ?? Math.min(initialStart + windowSec, safeDur)), init0 + minW),
    Math.min(init0 + maxW, trackW),
  );

  const [frameUri, setFrameUri] = useState<string | null>(null);
  // Filmstrip behind the track. Without it the scrubber is a featureless grey
  // bar, so there is no way to tell WHERE in the clip the window sits — you can
  // read the timestamps but not see the content you're selecting.
  const [strip, setStrip] = useState<(string | null)[]>(() => new Array(STRIP_COUNT).fill(null));
  const [startX, setStartX] = useState(init0);
  const [endX, setEndX] = useState(init1);
  const startXRef = useRef(init0);
  const endXRef = useRef(init1);
  const grabA = useRef(0);
  const grabB = useRef(0);
  const genId = useRef(0);

  const startSec = xToSec(startX);
  const endSec = xToSec(endX);
  const winSec = Math.max(0, endSec - startSec);

  async function genFrame(sec: number) {
    const id = ++genId.current;
    try {
      const r = await VideoThumbnails.getThumbnailAsync(uri, { time: Math.max(0, Math.floor(sec * 1000)), quality: 0.3 });
      if (id === genId.current) setFrameUri(r.uri);
    } catch {
      // keep the poster underneath
    }
  }

  useEffect(() => { genFrame(xToSec(startXRef.current)); }, [uri]);

  // Build the filmstrip. SEQUENTIAL on purpose: eight concurrent native decodes
  // spike memory on a long 4K clip and can stutter the composer as it opens.
  // Each frame is committed as it lands, so the strip fills in left-to-right
  // instead of appearing all at once after a pause.
  useEffect(() => {
    if (!uri || !(duration > 0)) return;
    let cancelled = false;
    setStrip(new Array(STRIP_COUNT).fill(null));
    (async () => {
      for (let i = 0; i < STRIP_COUNT; i++) {
        if (cancelled) return;
        // Sample the CENTRE of each slot, so the strip represents the whole clip
        // rather than being offset by half a slot toward the start.
        const sec = ((i + 0.5) / STRIP_COUNT) * duration;
        try {
          const r = await VideoThumbnails.getThumbnailAsync(uri, {
            time: Math.max(0, Math.floor(sec * 1000)),
            quality: 0.2, // thumbnails are ~45px wide on screen
          });
          if (cancelled) return;
          setStrip((prev) => { const next = [...prev]; next[i] = r.uri; return next; });
        } catch {
          // Leave the poster showing in that slot — a missing frame must never
          // turn the strip back into a blank bar.
        }
      }
    })();
    return () => { cancelled = true; };
  }, [uri, duration]);

  // All three gestures write through refs and only commit on release: onChange
  // sets state on the ~1800-line composer, and calling it per drag frame was a
  // literal "slider lags" reproducer. The window still tracks the finger 1:1 via
  // local state.
  const apply = (a: number, b: number) => {
    startXRef.current = a; endXRef.current = b;
    setStartX(a); setEndX(b);
  };
  const commit = () => {
    onChange(xToSec(startXRef.current), xToSec(endXRef.current));
    genFrame(xToSec(startXRef.current));
  };

  // Whole-window drag: slide the selection, keeping its length.
  const bodyPan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { grabA.current = startXRef.current; grabB.current = endXRef.current; },
    onPanResponderMove: (_e, g) => {
      const w = grabB.current - grabA.current;
      const a = Math.min(Math.max(grabA.current + g.dx, 0), trackW - w);
      apply(a, a + w);
    },
    onPanResponderRelease: commit,
    onPanResponderTerminate: commit,
  })).current;

  // Left edge: move the START only, clamped so the window stays between the
  // minimum length and the cap, and never crosses the right edge.
  const leftPan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { grabA.current = startXRef.current; },
    onPanResponderMove: (_e, g) => {
      const b = endXRef.current;
      const a = Math.min(Math.max(grabA.current + g.dx, Math.max(0, b - maxW)), b - minW);
      apply(a, b);
    },
    onPanResponderRelease: commit,
    onPanResponderTerminate: commit,
  })).current;

  // Right edge: move the END only, same clamps mirrored.
  const rightPan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { grabB.current = endXRef.current; },
    onPanResponderMove: (_e, g) => {
      const a = startXRef.current;
      const b = Math.max(Math.min(grabB.current + g.dx, Math.min(trackW, a + maxW)), a + minW);
      apply(a, b);
    },
    onPanResponderRelease: commit,
    onPanResponderTerminate: commit,
  })).current;

  const winW = Math.max(minW, endX - startX);

  return (
    <View style={styles.wrap}>
      <View style={[styles.previewBox, { width: frameW, height: frameH }]}>
        {posterUri ? (
          <ExpoImage source={{ uri: posterUri }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : null}
        {frameUri ? (
          <Image source={{ uri: frameUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : null}
      </View>

      <View style={[styles.track, { width: trackW }]}>
        {/* Filmstrip first so the dim overlays and the window draw on top of it.
            Each cell falls back to the poster, so the strip always shows SOMETHING. */}
        <View style={styles.strip} pointerEvents="none">
          {strip.map((u, i) => (
            <View key={i} style={styles.stripCell}>
              {posterUri ? (
                <ExpoImage source={{ uri: posterUri }} style={StyleSheet.absoluteFill} contentFit="cover" />
              ) : null}
              {u ? <Image source={{ uri: u }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
            </View>
          ))}
        </View>
        <View style={[styles.dim, { left: 0, width: startX }]} pointerEvents="none" />
        <View style={[styles.dim, { left: startX + winW, right: 0 }]} pointerEvents="none" />
        <View style={[styles.window, { width: winW, left: startX }]}>
          {/* Body layer first, handles after, so the edges win the touch. */}
          <View style={StyleSheet.absoluteFill} {...bodyPan.panHandlers} />
          <View style={[styles.handle, styles.handleLeft]} hitSlop={{ left: 12, right: 12, top: 8, bottom: 8 }} {...leftPan.panHandlers}>
            <Ionicons name="chevron-back" size={14} color={colors.text} />
          </View>
          <View style={[styles.handle, styles.handleRight]} hitSlop={{ left: 12, right: 12, top: 8, bottom: 8 }} {...rightPan.panHandlers}>
            <Ionicons name="chevron-forward" size={14} color={colors.text} />
          </View>
        </View>
      </View>

      {/* Clock format throughout: the landscape window is 9 minutes, and "540s"
          is a unit conversion nobody should have to do mid-drag. */}
      <Text style={styles.label}>{fmt(startSec)} – {fmt(endSec)} · {fmt(winSec)}</Text>
      <Text style={styles.hint}>{t('videoTrimmer.edgeHint', { sec: fmt(windowSec) })}</Text>
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  wrap: { alignItems: 'center', gap: SPACING.sm },
  previewBox: { backgroundColor: colors.background, borderRadius: RADIUS.md, overflow: 'hidden', alignSelf: 'center', alignItems: 'center', justifyContent: 'center' },
  track: {
    height: 52, borderRadius: RADIUS.sm, overflow: 'hidden', justifyContent: 'center',
    marginTop: SPACING.sm, backgroundColor: colors.surfaceElevated, width: '100%',
  },
  strip: { ...StyleSheet.absoluteFillObject, flexDirection: 'row' },
  stripCell: { flex: 1, overflow: 'hidden' },
  dim: { position: 'absolute', top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.55)' },
  window: {
    position: 'absolute', top: 0, bottom: 0,
    borderRadius: RADIUS.sm, borderWidth: 2, borderColor: colors.primary,
  },
  // Wider than they look: an 18px visual bar with a 22px touch target plus
  // hitSlop, because pinching an edge on a phone is a fingertip-sized gesture.
  handle: {
    position: 'absolute', top: 0, bottom: 0, width: 22,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
  },
  handleLeft: { left: 0 },
  handleRight: { right: 0 },
  label: { color: colors.text, fontSize: 13, fontWeight: '700' },
  hint: { color: colors.textTertiary, fontSize: 12 },
});
