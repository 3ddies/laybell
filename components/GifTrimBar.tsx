import { View, Text, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PinchGestureHandler, PanGestureHandler, State } from 'react-native-gesture-handler';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { RADIUS } from '../constants/theme';
import { useTheme } from '../contexts/ThemeContext';

// Filmstrip trim bar for the GIF maker.
//
// WHAT WAS WRONG. The strip always spanned the WHOLE video, so on anything long
// the selection collapsed to nothing: a 9-minute clip across ~345pt is 0.64
// pt/sec, which draws a 3-second GIF as a TWO PIXEL window, and makes one pixel
// of finger movement worth 1.6 seconds. The owner's words — "for longer videos
// the gif frame is so tiny that it is hard to control" — and the arithmetic
// agrees with him exactly. Pinch existed but resized DURATION, which is capped
// at 3s, so it could never help.
//
// WHAT IT DOES NOW. The strip is a VIEWPORT onto the video rather than the whole
// of it:
//
//   • PINCH zooms the timeline, around the selection, down to a couple of
//     seconds across. This is the actual fix — zoomed in, a 3-second GIF is most
//     of the bar and can be placed on the frame.
//   • DRAG ANYWHERE moves the selection, and the viewport follows it past an
//     edge. Touching away from the window jumps it to the finger first, so a
//     single tap is coarse positioning.
//   • DRAG on an edge GRIP sets the duration. The grips used to be
//     pointerEvents="none" decoration; with pinch reassigned to zoom, they have
//     to become real, and they are the natural place for that anyway.
//
// ⚠️ THERE IS NO "PAN THE VIEWPORT" MODE, and there must not be one. The first
// version made dragging outside the window pan the timeline, which broke the
// component outright: zoomed out — the default — the viewport cannot pan, and
// the window is only MIN_WIN_PX wide, so nearly the whole bar became a region
// where dragging did nothing at all. Long videos are travelled by dragging the
// selection to the edge and letting follow() bring the viewport along.
//
// It still opens fully zoomed out, so the mental model is unchanged and the
// whole clip is one drag away. The intended flow is coarse-then-fine: drag to
// roughly the right place, pinch in, place it exactly.
//
// FRAMES ARE RE-EXTRACTED FOR THE VISIBLE RANGE, debounced to the end of a
// gesture. Without that, zooming would just magnify eight stretched thumbnails —
// more pixels, no more information, which is not zoom at all. The debounce
// matters: getThumbnailAsync is a real decode per frame and firing it per
// gesture frame would stall the interaction it is meant to serve.

const FRAMES = 10;

// The drawn selection never goes below this, however short it is in real time.
// A window you cannot hit is not a control, and at full zoom-out on a long video
// the honest width is a couple of pixels.
const MIN_WIN_PX = 46;
// Touch slop around each edge for grip drags. Generous on purpose: this is the
// precision control, and missing it drops you into "move the whole selection".
const GRIP_HIT_PX = 30;
// Closest zoom, in seconds across the bar. Tied to the longest GIF so the
// selection can always be framed with a little room either side.
const minViewFor = (maxDur: number) => Math.max(maxDur * 1.35, 1.5);

type Mode = 'move' | 'left' | 'right';

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
  // The visible slice of the video. Opens showing everything.
  const [viewStart, setViewStart] = useState(0);
  const [viewSec, setViewSec] = useState(duration || 1);
  const [frames, setFrames] = useState<string[]>([]);

  const startRef = useRef(start); startRef.current = start;
  const durRef = useRef(durS); durRef.current = durS;
  const viewStartRef = useRef(viewStart); viewStartRef.current = viewStart;
  const viewSecRef = useRef(viewSec); viewSecRef.current = viewSec;

  // Values captured at the start of a gesture.
  const gStart = useRef(0);
  const gDur = useRef(0);
  const gViewSec = useRef(0);
  const gCenter = useRef(0);
  const mode = useRef<Mode>('move');
  const pinchRef = useRef<any>(null);
  const panRef = useRef<any>(null);

  // `duration` is a PROP and it can change — the modal falls back to 15s until
  // the real value is known. viewSec is state seeded from it, so without this it
  // would keep showing a 15-second viewport of a nine-minute video forever. Only
  // resets while the user has not zoomed, so it can never yank the view out from
  // under someone mid-edit.
  const zoomedRef = useRef(false);
  useEffect(() => {
    if (zoomedRef.current || !duration) return;
    viewSecRef.current = duration; setViewSec(duration);
    viewStartRef.current = 0; setViewStart(0);
  }, [duration]);

  const pxPerSec = width / (viewSec || 1);

  // Keep the viewport containing the selection. Called after any change that
  // could push the selection out of frame — a grip drag near an edge, or a
  // move that ran past it.
  const follow = useCallback((s: number, d: number) => {
    const vs = viewSecRef.current;
    let v = viewStartRef.current;
    if (s < v) v = s;
    else if (s + d > v + vs) v = s + d - vs;
    v = Math.max(0, Math.min(Math.max(0, duration - vs), v));
    if (v !== viewStartRef.current) { viewStartRef.current = v; setViewStart(v); }
  }, [duration]);

  const commit = useCallback((s: number, d: number) => {
    setStart(s); setDurS(d); onChange(s, d);
  }, [onChange]);

  // ── Frames for the VISIBLE range ────────────────────────────────────────────
  // Debounced: a gesture changes the viewport on every frame, and each thumbnail
  // is a decode. Re-extracting mid-gesture would stall the very interaction this
  // is meant to make smooth.
  useEffect(() => {
    let active = true;
    const t = setTimeout(() => {
      (async () => {
        const out: string[] = new Array(FRAMES).fill('');
        for (let i = 0; i < FRAMES; i++) {
          const at = viewStart + (viewSec * (i + 0.5)) / FRAMES;
          try {
            // CF Stream: use the frame URL directly (the <Image> loads it).
            // Local mp4: extract with expo-video-thumbnails.
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
    }, 220);
    return () => { active = false; clearTimeout(t); };
  }, [uri, frameUrlAt, viewStart, viewSec]);

  // ── PINCH → zoom the timeline ───────────────────────────────────────────────
  function onPinchState(e: any) {
    if (e.nativeEvent.state === State.BEGAN) {
      gViewSec.current = viewSecRef.current;
      gCenter.current = startRef.current + durRef.current / 2;
    }
  }
  function onPinchEvent(e: any) {
    const minView = Math.min(minViewFor(maxDur), duration);
    const next = Math.max(minView, Math.min(duration, gViewSec.current / (e.nativeEvent.scale || 1)));
    // Zoom about the SELECTION, not the pinch focal point. The selection is the
    // thing being placed, and keeping it under the fingers is what makes zooming
    // feel like it is helping rather than like the bar is running away.
    let v = gCenter.current - next / 2;
    v = Math.max(0, Math.min(Math.max(0, duration - next), v));
    // Once the user has zoomed, a late `duration` must not reset their view.
    zoomedRef.current = next < duration - 0.01;
    viewSecRef.current = next; viewStartRef.current = v;
    setViewSec(next); setViewStart(v);
  }

  // ── PAN → move or resize, decided by where the finger landed ────────────────
  //
  // There is deliberately NO "pan the viewport" mode. There was one, and it was
  // a regression: zoomed out (the default) the viewport cannot pan at all, and
  // the window is only MIN_WIN_PX wide, so almost the whole bar became a region
  // where dragging did nothing. The original component let you drag ANYWHERE to
  // move the selection, and that was right — it is restored here.
  //
  // Travelling a long video is handled by follow() instead: drag the selection
  // to the edge of the viewport and the viewport comes with it.
  function onPanState(e: any) {
    if (e.nativeEvent.state !== State.BEGAN) return;
    gDur.current = durRef.current;

    const x = e.nativeEvent.x;
    const left = (startRef.current - viewStartRef.current) * pxPerSec;
    const right = left + Math.max(MIN_WIN_PX, durRef.current * pxPerSec);

    if (Math.abs(x - left) <= GRIP_HIT_PX) { mode.current = 'left'; gStart.current = startRef.current; return; }
    if (Math.abs(x - right) <= GRIP_HIT_PX) { mode.current = 'right'; gStart.current = startRef.current; return; }

    mode.current = 'move';
    if (x > left && x < right) { gStart.current = startRef.current; return; }
    // Touched away from the window: JUMP it here first, centred on the finger,
    // then let the drag refine from there. Coarse positioning in one tap, which
    // is most of what the old drag-anywhere was actually being used for.
    const s = Math.max(0, Math.min(
      duration - durRef.current,
      viewStartRef.current + x / pxPerSec - durRef.current / 2,
    ));
    gStart.current = s;
    commit(s, durRef.current);
    follow(s, durRef.current);
  }

  function onPanEvent(e: any) {
    const dt = e.nativeEvent.translationX / pxPerSec;

    if (mode.current === 'move') {
      const s = Math.max(0, Math.min(duration - durRef.current, gStart.current + dt));
      commit(s, durRef.current);
      follow(s, durRef.current);
      return;
    }

    if (mode.current === 'left') {
      // The right edge is the anchor: pulling the left grip changes where the
      // GIF starts AND how long it is, and the end must not drift.
      const end = gStart.current + gDur.current;
      const s = Math.max(0, Math.min(end - minDur, Math.max(end - maxDur, gStart.current + dt)));
      commit(s, end - s);
      follow(s, end - s);
      return;
    }

    // 'right' — the start is the anchor.
    const d = Math.max(minDur, Math.min(Math.min(maxDur, duration - gStart.current), gDur.current + dt));
    commit(gStart.current, d);
    follow(gStart.current, d);
  }

  // ── Geometry ────────────────────────────────────────────────────────────────
  const rawLeft = (start - viewStart) * pxPerSec;
  const rawWin = durS * pxPerSec;
  // Never draw the window smaller than a finger. Zoomed out on a long video the
  // honest width is a couple of pixels, and a control you cannot hit is not one.
  const winW = Math.max(MIN_WIN_PX, rawWin);
  const leftX = Math.max(0, Math.min(width - winW, rawLeft));
  const zoomed = viewSec < duration - 0.01;

  const clock = (s: number) => {
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${r.toString().padStart(2, '0')}`;
  };

  return (
    <View>
      <PinchGestureHandler ref={pinchRef} simultaneousHandlers={panRef} onGestureEvent={onPinchEvent} onHandlerStateChange={onPinchState}>
        <PanGestureHandler ref={panRef} simultaneousHandlers={pinchRef} maxPointers={1} onGestureEvent={onPanEvent} onHandlerStateChange={onPanState}>
          <View style={[styles.track, { width, height, borderRadius: RADIUS.md, backgroundColor: colors.surfaceLight }]}>
            {/* Filmstrip — the VISIBLE range, re-extracted as it changes. */}
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.strip]}>
              {Array.from({ length: FRAMES }).map((_, i) => (
                frames[i]
                  ? <Image key={i} source={{ uri: frames[i] }} style={{ width: width / FRAMES, height }} contentFit="cover" />
                  : <View key={i} style={{ width: width / FRAMES, height, backgroundColor: colors.surface }} />
              ))}
            </View>

            {/* Dim outside the selection */}
            <View pointerEvents="none" style={[styles.dim, { left: 0, width: leftX, height }]} />
            <View pointerEvents="none" style={[styles.dim, { left: leftX + winW, width: Math.max(0, width - leftX - winW), height }]} />

            {/* Selection window + edge grips. Still drawn, not touched: the pan
                handler decides by x, which keeps one gesture owner for the bar
                and avoids nested handlers fighting over the same finger. */}
            <View pointerEvents="none" style={[styles.window, { left: leftX, width: winW, height, borderColor: colors.primary }]} />
            <View pointerEvents="none" style={[styles.gripPad, { left: leftX, height, backgroundColor: colors.primary }]}>
              <View style={styles.gripLine} />
            </View>
            <View pointerEvents="none" style={[styles.gripPad, { left: leftX + winW - 12, height, backgroundColor: colors.primary }]}>
              <View style={styles.gripLine} />
            </View>
          </View>
        </PanGestureHandler>
      </PinchGestureHandler>

      {/* Where in the video you actually are — the one thing the strip alone
          cannot tell you once it is a viewport rather than the whole clip.
          Deliberately numbers only: this app ships in ten languages and the gif
          keys are English-with-fallback, so a hardcoded hint here would be
          English for everyone. The instructional copy lives in the translated
          gif.make.clipLength line the modal already renders below this. */}
      <View style={styles.meta}>
        <Text style={[styles.metaText, { color: colors.textMeta }]}>
          {clock(start)} – {clock(start + durS)}
        </Text>
        {zoomed ? (
          <Text style={[styles.metaText, { color: colors.primary }]}>
            {`${Math.round(duration / viewSec)}×`}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  track: { overflow: 'hidden', justifyContent: 'center' },
  strip: { flexDirection: 'row' },
  dim: { position: 'absolute', top: 0, backgroundColor: 'rgba(0,0,0,0.55)' },
  window: { position: 'absolute', top: 0, borderWidth: 3, borderRadius: RADIUS.md, backgroundColor: 'transparent' },
  // A visible bar rather than the old 3pt sliver — it has to look grabbable now
  // that it actually is.
  gripPad: {
    position: 'absolute', top: 0, width: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  gripLine: { width: 2, height: 18, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.9)' },
  meta: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6, paddingHorizontal: 2 },
  metaText: { fontSize: 11, fontVariant: ['tabular-nums'] },
});
