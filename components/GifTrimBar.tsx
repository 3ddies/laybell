import { View, Text, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { useEffect, useRef, useState } from 'react';
import { PinchGestureHandler, PanGestureHandler, State } from 'react-native-gesture-handler';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { RADIUS } from '../constants/theme';
import { useTheme } from '../contexts/ThemeContext';

// Filmstrip trim bar for the GIF maker: a row of frames (the "render bar") with a
// selection window drawn on it. The WHOLE bar is interactive — DRAG (1 finger)
// anywhere to move where the GIF starts, PINCH (2 fingers) anywhere to grow/shrink
// the duration (around the window centre), clamped to [minDur, maxDur]. The window
// + edge grips are visual only. Reports (startSec, durSec) live.
//
//
// ZOOM — added 2026-08-28, and added THIS way for a reason.
//
// The problem: the strip spans the whole video, so on a long one the selection
// is drawn a couple of pixels wide and a pixel of finger movement is worth more
// than a second. Unusable past a few minutes.
//
// A previous attempt fixed that by rebuilding the gestures — pinch became zoom,
// a viewport was introduced, drag modes were added. It took four rounds and the
// verdict was "everything just feels bad, not nearly as good as it did
// originally". It was reverted. The lesson stuck: the gestures on this bar are
// good and must not be touched.
//
// So zoom is a SEPARATE SLIDER (the owner's suggestion, and the right one). The
// pan and pinch handlers below are byte-for-byte what they were; all that
// changes is the SCALE they work at, which is exactly the thing that was wrong.
//
// Two properties make this safe, and both are worth preserving in any edit:
//
//  1. `viewStart` is DERIVED, never state. It is always the window that centres
//     the selection, clamped to the video. There is no follow(), no paging, no
//     auto-scroll — the previous attempt's worst bug was a viewport that tracked
//     the selection 1:1, which pinned the window against the edge while the
//     video kept moving. A derivation cannot do that.
//  2. At zoom = 1 the maths collapses to the original exactly: viewSec ==
//     duration, so viewStart clamps to 0 and pxPerSec is width/duration. The
//     zoomed-out bar IS the old bar, not an approximation of it.
//
// The strip is not re-extracted when zooming. The same whole-video frames are
// laid out `zoom` times wider and translated, so the filmstrip scrolls smoothly
// for free and gets stretched rather than re-cut. Stretching is the honest
// trade: the point of zooming is finer CONTROL, and the video preview above the
// bar is what shows the actual frame.
//
// COLOUR. The selection window, its grips and the zoom slider are colors.text —
// white on dark, near-black on light — not the brand orange they used to be.
// Owner's call, and it earns it twice over: these sit on ARBITRARY VIDEO FRAMES,
// where a mid-tone orange can land on orange content and vanish, while the
// theme's strongest neutral is the one colour guaranteed to separate from the
// surface behind it. It also stops the trim controls competing with the Create
// button, which is the only thing on this screen that should be reading as brand.
const FRAMES = 8;

// Tightest view, in seconds across the bar — enough for the longest GIF plus
// room either side.
const MIN_VIEW_SEC = 4;
// Zoom is exponential across the slider. Linear would spend most of the travel
// in zoom levels nobody wants: on a 9-minute video the useful range is the last
// few percent of a linear scale.
const zoomFor = (t: number, maxZoom: number) => Math.pow(Math.max(1, maxZoom), Math.max(0, Math.min(1, t)));

export default function GifTrimBar({
  uri, frameUrlAt, duration, minDur, maxDur, width, height = 64, initialStart = 0, initialDur, onChange,
}: {
  uri: string;
  // Cloudflare Stream: a per-time frame URL (HLS can't be frame-grabbed on-device),
  // used directly as the thumbnail source instead of expo-video-thumbnails.
  frameUrlAt?: ((timeSec: number) => string | null) | null;
  duration: number;
  minDur: number;
  maxDur: number;
  width: number;
  height?: number;
  initialStart?: number;
  initialDur?: number;
  onChange: (startSec: number, durSec: number) => void;
}) {
  const { colors } = useTheme();

  const [start, setStart] = useState(initialStart);
  const [durS, setDurS] = useState(Math.min(initialDur ?? maxDur, duration));
  const [frames, setFrames] = useState<string[]>([]);
  // 0 = whole video (the original bar), 1 = tightest view.
  const [zoomT, setZoomT] = useState(0);

  const startRef = useRef(start); startRef.current = start;
  const durRef = useRef(durS); durRef.current = durS;
  // Values captured at the start of a gesture.
  const gStart = useRef(0);
  const gDur = useRef(0);
  const gCenter = useRef(0);
  const pinchRef = useRef<any>(null);
  const panRef = useRef<any>(null);

  // ── The view, entirely derived ──────────────────────────────────────────────
  const maxZoom = duration > MIN_VIEW_SEC ? duration / MIN_VIEW_SEC : 1;
  const zoom = zoomFor(zoomT, maxZoom);
  const viewSec = Math.min(duration || 1, (duration || 1) / zoom);
  // Centre the selection. At zoom 1 this clamps to 0 and the bar is the old bar.
  const viewStart = Math.max(0, Math.min(
    Math.max(0, duration - viewSec),
    start + durS / 2 - viewSec / 2,
  ));
  const pxPerSec = width / (viewSec || 1);

  useEffect(() => {
    let active = true;
    (async () => {
      const out: string[] = new Array(FRAMES).fill('');
      for (let i = 0; i < FRAMES; i++) {
        const at = (duration * (i + 0.5)) / FRAMES;
        try {
          // CF Stream: use the frame URL directly (the <Image> loads it). Local
          // mp4: extract with expo-video-thumbnails.
          if (frameUrlAt) {
            out[i] = frameUrlAt(at) ?? '';
          } else {
            const r = await VideoThumbnails.getThumbnailAsync(uri, { time: Math.floor(at * 1000), quality: 0.3 });
            if (r?.uri) out[i] = r.uri;
          }
        } catch { /* leave blank */ }
        if (!active) return;
        setFrames([...out]);
      }
    })();
    return () => { active = false; };
  }, [uri, duration, frameUrlAt]);

  // ── Gestures — UNCHANGED from the version that worked ───────────────────────
  // DRAG anywhere → move the window (duration fixed).
  function onPanEvent(e: any) {
    let s = gStart.current + e.nativeEvent.translationX / pxPerSec;
    s = Math.max(0, Math.min(duration - durRef.current, s));
    setStart(s); onChange(s, durRef.current);
  }
  function onPanState(e: any) {
    if (e.nativeEvent.state === State.BEGAN) gStart.current = startRef.current;
  }
  // PINCH anywhere → resize duration around the window centre.
  function onPinchEvent(e: any) {
    const d = Math.max(minDur, Math.min(maxDur, gDur.current * e.nativeEvent.scale));
    const s = Math.max(0, Math.min(duration - d, gCenter.current - d / 2));
    setStart(s); setDurS(d); onChange(s, d);
  }
  function onPinchState(e: any) {
    if (e.nativeEvent.state === State.BEGAN) {
      gDur.current = durRef.current;
      gStart.current = startRef.current;
      gCenter.current = startRef.current + durRef.current / 2;
    }
  }

  const leftX = (start - viewStart) * pxPerSec;
  const winW = durS * pxPerSec;
  // The whole video laid out at the current scale; translated to show the view.
  const stripW = width * zoom;

  return (
    <View>
      <PinchGestureHandler ref={pinchRef} simultaneousHandlers={panRef} onGestureEvent={onPinchEvent} onHandlerStateChange={onPinchState}>
        <PanGestureHandler ref={panRef} simultaneousHandlers={pinchRef} maxPointers={1} onGestureEvent={onPanEvent} onHandlerStateChange={onPanState}>
          <View style={[styles.track, { width, height, borderRadius: RADIUS.md, backgroundColor: colors.surfaceLight }]}>
            {/* Filmstrip. Same whole-video frames at every zoom — laid out
                `zoom` times wider and slid, so it scrolls smoothly and costs
                nothing. Stretched rather than re-cut when zoomed in. */}
            <View
              pointerEvents="none"
              style={[styles.strip, { width: stripW, height, transform: [{ translateX: -viewStart * pxPerSec }] }]}
            >
              {Array.from({ length: FRAMES }).map((_, i) => (
                frames[i]
                  ? <Image key={i} source={{ uri: frames[i] }} style={{ width: stripW / FRAMES, height }} contentFit="cover" />
                  : <View key={i} style={{ width: stripW / FRAMES, height, backgroundColor: colors.surface }} />
              ))}
            </View>

            {/* Dim outside the selection */}
            <View pointerEvents="none" style={[styles.dim, { left: 0, width: Math.max(0, leftX), height }]} />
            <View pointerEvents="none" style={[styles.dim, { left: leftX + winW, width: Math.max(0, width - leftX - winW), height }]} />

            {/* Selection window + edge grips (visual only) */}
            <View pointerEvents="none" style={[styles.window, { left: leftX, width: winW, height, borderColor: colors.text }]} />
            <View pointerEvents="none" style={[styles.grip, { left: leftX + 3, backgroundColor: colors.text }]} />
            <View pointerEvents="none" style={[styles.grip, { left: leftX + winW - 6, backgroundColor: colors.text }]} />
          </View>
        </PanGestureHandler>
      </PinchGestureHandler>

      {/* Zoom — its own control, with its own gesture handler, deliberately
          OUTSIDE the strip. Nothing here can reach the pan/pinch above. Hidden
          when the video is short enough that the bar was never the problem. */}
      {maxZoom > 1.2 ? (
        <ZoomSlider
          width={width}
          value={zoomT}
          onChange={setZoomT}
          label={zoomT > 0.02 ? `${Math.round(zoom)}×` : ''}
        />
      ) : null}
    </View>
  );
}

// A minimal slider. Built rather than pulled in — there is no slider dependency
// in this project, and adding a native one would force a rebuild for a track and
// a knob.
function ZoomSlider({ width, value, onChange, label }: {
  width: number; value: number; onChange: (v: number) => void; label: string;
}) {
  const { colors } = useTheme();
  const KNOB = 22;
  const travel = width - KNOB;
  const gStart = useRef(0);

  function set(v: number) { onChange(Math.max(0, Math.min(1, v))); }
  function onState(e: any) {
    if (e.nativeEvent.state === State.BEGAN) gStart.current = value;
  }
  function onEvent(e: any) {
    set(gStart.current + e.nativeEvent.translationX / (travel || 1));
  }

  return (
    <View style={styles.zoomRow}>
      <View style={styles.zoomHead}>
        <Text style={[styles.zoomLabel, { color: colors.textMeta }]}>Zoom</Text>
        <Text style={[styles.zoomLabel, { color: colors.text }]}>{label}</Text>
      </View>
      <PanGestureHandler onGestureEvent={onEvent} onHandlerStateChange={onState}>
        <View style={[styles.zoomTrackHit, { width }]}>
          <View style={[styles.zoomTrack, { backgroundColor: colors.surfaceLight }]} />
          <View style={[styles.zoomFill, { width: value * travel + KNOB / 2, backgroundColor: colors.text }]} />
          <View style={[styles.zoomKnob, {
            left: value * travel, width: KNOB, height: KNOB,
            backgroundColor: colors.text, borderColor: colors.background,
          }]} />
        </View>
      </PanGestureHandler>
    </View>
  );
}

const styles = StyleSheet.create({
  track: { overflow: 'hidden', justifyContent: 'center' },
  strip: { flexDirection: 'row', position: 'absolute', left: 0, top: 0 },
  dim: { position: 'absolute', top: 0, backgroundColor: 'rgba(0,0,0,0.55)' },
  window: { position: 'absolute', top: 0, borderWidth: 3, borderRadius: RADIUS.md, backgroundColor: 'transparent' },
  grip: { position: 'absolute', top: '50%', marginTop: -9, width: 3, height: 18, borderRadius: 2 },

  zoomRow: { marginTop: 10 },
  zoomHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  zoomLabel: { fontSize: 11, fontWeight: '700' },
  // A tall touch target around a thin track — the track is 4pt, the finger gets 28.
  zoomTrackHit: { height: 28, justifyContent: 'center' },
  zoomTrack: { position: 'absolute', left: 0, right: 0, height: 4, borderRadius: 2 },
  zoomFill: { position: 'absolute', left: 0, height: 4, borderRadius: 2 },
  zoomKnob: { position: 'absolute', borderRadius: 11, borderWidth: 2 },
});
