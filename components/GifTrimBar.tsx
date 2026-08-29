import { View, Text, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
//   • PINCH zooms the timeline about the FOCAL POINT, down to a couple of
//     seconds across — put two fingers on the moment you want and it grows in
//     place. This is the actual fix: zoomed in, a 3-second GIF is most of the
//     bar and can be placed on the frame.
//   • DRAG ANYWHERE moves the selection, relatively, and the viewport follows it
//     past an edge.
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
// How often the parent hears about a change mid-gesture.
//
// This is the fix for "very shaky". The bar's own state can update every frame
// cheaply, but onChange goes to GifMakerModal, which feeds trimStartSec and
// trimEndSec straight into an <AppVideo> — so at 60 reports a second the video
// player was being told to reconfigure its trim window sixty times a second,
// while a finger was on the screen. The preview does not need that resolution to
// be useful; it needs to keep up. Every gesture still flushes its final value on
// END, so nothing is ever left stale.
const EMIT_MS = 90;

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
  const gViewStart = useRef(0);
  const gFocalFrac = useRef(0.5);
  const gFocalTime = useRef(0);
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

  // Local state updates every frame — that is what makes the window track the
  // finger. The PARENT is throttled, because that is what makes it smooth.
  const lastEmit = useRef(0);
  const pending = useRef<{ s: number; d: number } | null>(null);

  const commit = useCallback((s: number, d: number) => {
    setStart(s); setDurS(d);
    const now = Date.now();
    if (now - lastEmit.current >= EMIT_MS) {
      lastEmit.current = now;
      pending.current = null;
      onChange(s, d);
    } else {
      pending.current = { s, d };
    }
  }, [onChange]);

  // Always land on the exact final value, whatever the throttle swallowed.
  const flush = useCallback(() => {
    if (!pending.current) return;
    const { s, d } = pending.current;
    pending.current = null;
    lastEmit.current = Date.now();
    onChange(s, d);
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
      gViewStart.current = viewStartRef.current;
      // The fraction along the bar the fingers are centred on, and the time that
      // sits there right now. Captured once at BEGAN: recomputing it per frame
      // would chase the focal point as it drifts and make the timeline slide.
      const frac = Math.max(0, Math.min(1, (e.nativeEvent.focalX ?? width / 2) / width));
      gFocalFrac.current = frac;
      gFocalTime.current = viewStartRef.current + frac * viewSecRef.current;
    }
  }
  function onPinchEvent(e: any) {
    const minView = Math.min(minViewFor(maxDur), duration);
    const next = Math.max(minView, Math.min(duration, gViewSec.current / (e.nativeEvent.scale || 1)));
    // Zoom about the FOCAL POINT — the time under the fingers stays under them.
    // The owner asked to "zoom into a specific area", and this is what makes that
    // true: you put two fingers on the moment you care about and it grows in
    // place. Zooming about the selection instead (the previous behaviour) meant
    // the part of the video you were looking at slid away as you pinched.
    let v = gFocalTime.current - gFocalFrac.current * next;
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
    const st = e.nativeEvent.state;
    if (st === State.END || st === State.CANCELLED || st === State.FAILED) { flush(); return; }
    if (st !== State.BEGAN) return;

    gDur.current = durRef.current;
    gStart.current = startRef.current;

    const x = e.nativeEvent.x;
    const left = (startRef.current - viewStartRef.current) * pxPerSec;
    const right = left + Math.max(MIN_WIN_PX, durRef.current * pxPerSec);

    // Edges first, then everything else moves the selection.
    //
    // There is deliberately NO jump-to-finger here. A previous version snapped
    // the window to the touch point when you started outside it, and that is
    // exactly the "teleporty" the owner reported: zoomed out the window is only
    // MIN_WIN_PX wide, so most touches land outside it and the selection leapt
    // before the drag had even begun. Relative dragging from wherever the finger
    // is has no such surprise, and it is what the component did originally.
    if (Math.abs(x - left) <= GRIP_HIT_PX) mode.current = 'left';
    else if (Math.abs(x - right) <= GRIP_HIT_PX) mode.current = 'right';
    else mode.current = 'move';
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

  const strip = useMemo(() => (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.strip]}>
      {Array.from({ length: FRAMES }).map((_, i) => (
        frames[i]
          ? <Image key={i} source={{ uri: frames[i] }} style={{ width: width / FRAMES, height }} contentFit="cover" />
          : <View key={i} style={{ width: width / FRAMES, height, backgroundColor: colors.surface }} />
      ))}
    </View>
  ), [frames, width, height, colors.surface]);

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
            {/* Filmstrip — the VISIBLE range, re-extracted as it changes.
                Memoised on the frames themselves: during a drag this component
                re-renders every frame to track the finger, and rebuilding ten
                <Image> elements each time is work the strip never needs — the
                pictures do not change while you are dragging. Part of the same
                fix as EMIT_MS. */}
            {strip}

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
