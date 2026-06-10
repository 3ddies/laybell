import { useRef } from 'react';
import { Animated, PanResponder, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';

// Multiple draggable/pinch-resizable text stickers over story media, managed by a
// SINGLE full-screen gesture layer:
//  • the gesture routes to the sticker NEAREST the touch (so you don't have to hit
//    it exactly); a touch far from any sticker counts as "open area".
//  • a tap on a sticker → edit it; a tap on open area → create a new one.
//  • drag / pinch manipulate the active sticker, computed from the RAW touches and
//    re-baselined whenever the finger count changes — so the gesture stays
//    continuous as long as ≥1 finger remains (you can swap fingers without it
//    releasing or jumping).

export type CaptionStyle = { x: number; y: number; scale: number; rotation: number };
export const DEFAULT_CAPTION_STYLE: CaptionStyle = { x: 0.5, y: 0.5, scale: 1, rotation: 0 };

export type Sticker = { id: string; text: string } & CaptionStyle;

// Shared so the editor sticker and the viewer render identically.
export const captionStickerTextStyle = {
  color: '#fff',
  fontSize: 26,
  fontWeight: '700' as const,
  textAlign: 'center' as const,
  maxWidth: 300,
  paddingHorizontal: 10,
  paddingVertical: 4,
  textShadowColor: 'rgba(0,0,0,0.6)',
  textShadowRadius: 6,
  textShadowOffset: { width: 0, height: 1 },
};

const NEAR_PX = 140; // a touch within this of a sticker's center "grabs" it

type Anim = { pan: Animated.ValueXY; scale: Animated.Value; rot: Animated.Value };
type Cur = { x: number; y: number; scale: number; rotation: number }; // pan offset (px) from frame center

function centroid(touches: any[]) {
  let x = 0, y = 0;
  for (const t of touches) { x += t.pageX; y += t.pageY; }
  return { x: x / touches.length, y: y / touches.length };
}
function pinch(touches: any[]) {
  const dx = touches[1].pageX - touches[0].pageX;
  const dy = touches[1].pageY - touches[0].pageY;
  return { dist: Math.hypot(dx, dy), angle: (Math.atan2(dy, dx) * 180) / Math.PI };
}

export default function StickerLayer({
  stickers, frameW, frameH, editingId, onManipulate, onTapSticker, onTapEmpty,
}: {
  stickers: Sticker[];
  frameW: number;
  frameH: number;
  editingId: string | null;
  onManipulate: (id: string, style: CaptionStyle) => void;
  onTapSticker: (id: string) => void;
  onTapEmpty: (xNorm: number, yNorm: number) => void;
}) {
  const animRef = useRef<Record<string, Anim>>({});
  const curRef = useRef<Record<string, Cur>>({});

  function getAnim(s: Sticker): Anim {
    let a = animRef.current[s.id];
    if (!a) {
      const px = (s.x - 0.5) * frameW, py = (s.y - 0.5) * frameH;
      a = { pan: new Animated.ValueXY({ x: px, y: py }), scale: new Animated.Value(s.scale), rot: new Animated.Value(s.rotation) };
      animRef.current[s.id] = a;
      curRef.current[s.id] = { x: px, y: py, scale: s.scale, rotation: s.rotation };
    }
    return a;
  }

  // Latest props for the once-created PanResponder.
  const stickersRef = useRef(stickers); stickersRef.current = stickers;
  const cbRef = useRef({ onManipulate, onTapSticker, onTapEmpty });
  cbRef.current = { onManipulate, onTapSticker, onTapEmpty };

  const active = useRef<string | null>(null);
  const moved = useRef(false);
  const grant = useRef({ x: 0, y: 0 });
  const base = useRef({ cx: 0, cy: 0, dist: 0, angle: 0, px: 0, py: 0, scale: 1, rotation: 0 });
  const prevCount = useRef(0);

  function rebaseline(touches: any[]) {
    const c = centroid(touches);
    const cur = active.current ? curRef.current[active.current] : undefined;
    const p = touches.length >= 2 ? pinch(touches) : { dist: 0, angle: 0 };
    base.current = {
      cx: c.x, cy: c.y, dist: p.dist, angle: p.angle,
      px: cur?.x ?? 0, py: cur?.y ?? 0, scale: cur?.scale ?? 1, rotation: cur?.rotation ?? 0,
    };
    prevCount.current = touches.length;
  }

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // Never give the gesture up (e.g. to the tab pager) — keeps it continuous.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e: GestureResponderEvent) => {
        const touches = e.nativeEvent.touches;
        const c = centroid(touches);
        grant.current = { x: c.x, y: c.y };
        moved.current = false;
        // Pick the nearest sticker to the touch (by committed center).
        let nearest: string | null = null, best = Infinity;
        for (const s of stickersRef.current) {
          const sx = s.x * frameW, sy = s.y * frameH;
          const d = Math.hypot(c.x - sx, c.y - sy);
          if (d < best) { best = d; nearest = s.id; }
        }
        active.current = nearest && best <= NEAR_PX ? nearest : null;
        rebaseline(touches);
      },
      onPanResponderMove: (e: GestureResponderEvent) => {
        const touches = e.nativeEvent.touches;
        if (touches.length === 0) return;
        if (touches.length !== prevCount.current) rebaseline(touches); // finger added/removed → no jump
        const c = centroid(touches);
        if (Math.abs(c.x - grant.current.x) > 5 || Math.abs(c.y - grant.current.y) > 5) moved.current = true;
        const id = active.current;
        if (!id) return; // open-area drag: nothing to manipulate
        const a = animRef.current[id]; const cur = curRef.current[id];
        if (!a || !cur) return;
        const nx = base.current.px + (c.x - base.current.cx);
        const ny = base.current.py + (c.y - base.current.cy);
        let ns = base.current.scale, nr = base.current.rotation;
        if (touches.length >= 2 && base.current.dist > 0) {
          const p = pinch(touches);
          ns = Math.max(0.4, Math.min(5, base.current.scale * (p.dist / base.current.dist)));
          nr = base.current.rotation + (p.angle - base.current.angle);
          moved.current = true;
        }
        a.pan.setValue({ x: nx, y: ny }); a.scale.setValue(ns); a.rot.setValue(nr);
        cur.x = nx; cur.y = ny; cur.scale = ns; cur.rotation = nr;
      },
      onPanResponderRelease: () => {
        const id = active.current;
        if (!moved.current) {
          if (id) cbRef.current.onTapSticker(id);
          else cbRef.current.onTapEmpty(grant.current.x / frameW, grant.current.y / frameH);
        } else if (id) {
          const cur = curRef.current[id];
          if (cur) cbRef.current.onManipulate(id, { x: cur.x / frameW + 0.5, y: cur.y / frameH + 0.5, scale: cur.scale, rotation: cur.rotation });
        }
        active.current = null;
      },
    }),
  ).current;

  return (
    <View style={StyleSheet.absoluteFill} {...responder.panHandlers}>
      {stickers.map((s) => {
        if (s.id === editingId || !s.text) return null;
        const a = getAnim(s);
        return (
          <View key={s.id} style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
            <Animated.View
              style={{
                transform: [
                  { translateX: a.pan.x },
                  { translateY: a.pan.y },
                  { scale: a.scale },
                  { rotate: a.rot.interpolate({ inputRange: [-360, 360], outputRange: ['-360deg', '360deg'] }) },
                ],
              }}
            >
              <Text style={captionStickerTextStyle}>{s.text}</Text>
            </Animated.View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
});
