import { useRef } from 'react';
import {
  Animated, PanResponder, Platform, StyleSheet, Text, View,
  type GestureResponderEvent, type TextStyle, type ViewStyle,
} from 'react-native';

// Multiple draggable/pinch-resizable text + emoji stickers over story media,
// managed by a SINGLE full-screen gesture layer:
//  • the gesture routes to the sticker NEAREST the touch (so you don't have to hit
//    it exactly); a touch far from any sticker counts as "open area".
//  • a tap on a sticker → edit it; a tap on open area → create a new one.
//  • drag / pinch manipulate the active sticker, computed from the RAW touches and
//    re-baselined whenever the finger count changes — so the gesture stays
//    continuous as long as ≥1 finger remains (you can swap fingers without it
//    releasing or jumping).
//  • while a sticker is being dragged the host can show a trash zone; the release
//    position is reported so dropping a sticker there deletes it.

export type CaptionStyle = { x: number; y: number; scale: number; rotation: number };
export const DEFAULT_CAPTION_STYLE: CaptionStyle = { x: 0.5, y: 0.5, scale: 1, rotation: 0 };

// ─── Text styling (iOS-style font presets, colors, backgrounds) ────────────────
// All of this is PURE METADATA stored in the stories.stickers jsonb — the editor,
// the live preview, and the story viewer all render through resolveSticker() so a
// story looks identical everywhere. Every field is optional: stickers posted
// before these existed render exactly as they used to.

export type StickerFont = 'classic' | 'bold' | 'typewriter' | 'serif' | 'neon';
// 'boxy' = the TikTok-caption look (see components/TopCaption.tsx): every LINE
// gets its own rounded pill, stacked and slightly fused.
export type StickerBg = 'none' | 'pill' | 'soft' | 'boxy';

export type Sticker = {
  id: string;
  text: string;
  font?: StickerFont;
  color?: string;
  bg?: StickerBg;
  size?: number;   // base font size chosen with the editor's slider (wrap density)
  emoji?: boolean; // emoji sticker: rendered large, no shadow/background
} & CaptionStyle;

export const STICKER_FONTS: { key: StickerFont; label: string }[] = [
  { key: 'classic', label: 'Classic' },
  { key: 'bold', label: 'Bold' },
  { key: 'typewriter', label: 'Typewriter' },
  { key: 'serif', label: 'Serif' },
  { key: 'neon', label: 'Neon' },
];

export const STICKER_COLORS = [
  '#FFFFFF', '#0A0A0A', '#F26522', '#FAB525', '#F43F5E',
  '#22C55E', '#3B82F6', '#A855F7', '#67E8F9', '#FB7185',
];

// Perceived luminance → black or white text over a colored pill.
function contrastOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#0A0A0A' : '#FFFFFF';
}

// Explicit lineHeights matter: these styles also dress the EDITOR's multiline
// TextInput, which auto-grows — custom families (Georgia/Menlo) misreport
// their line metrics without one and clip as you type. textTransform is
// deliberately absent (uppercase on a TextInput garbles measurement on iOS).
const FONT_FACES: Record<StickerFont, TextStyle> = {
  classic: { fontWeight: '700', fontSize: 26, lineHeight: 33 },
  bold: { fontWeight: '900', fontSize: 30, letterSpacing: 0.3, lineHeight: 38 },
  typewriter: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontWeight: '600', fontSize: 22, lineHeight: 29,
  },
  serif: {
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
    fontWeight: '600', fontSize: 26, lineHeight: 34,
  },
  neon: { fontWeight: '700', fontSize: 28, letterSpacing: 0.5, lineHeight: 36 },
};

// The full visual for a sticker: text style + the box (pill) behind it.
export function resolveSticker(s: {
  font?: StickerFont; color?: string; bg?: StickerBg; size?: number; emoji?: boolean;
}): { textStyle: TextStyle; boxStyle: ViewStyle } {
  if (s.emoji) {
    return {
      textStyle: { fontSize: 64, textAlign: 'center' },
      boxStyle: { paddingHorizontal: 6, paddingVertical: 2 },
    };
  }
  const font = FONT_FACES[s.font ?? 'classic'] ?? FONT_FACES.classic;
  const color = s.color ?? '#FFFFFF';
  const bg = s.bg ?? 'none';

  const textStyle: TextStyle = {
    ...font,
    color,
    textAlign: 'center',
    maxWidth: 300,
  };
  // Slider-chosen size overrides the face's default (lineHeight tracks it so
  // the auto-growing editor input never clips a wrapped line).
  if (s.size) {
    textStyle.fontSize = s.size;
    textStyle.lineHeight = Math.round(s.size * 1.28);
  }
  const boxStyle: ViewStyle = { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10 };

  if (bg === 'pill' || bg === 'boxy') {
    // 'boxy' renders as per-line pills via StickerContent; this single-box
    // fallback (same colors) dresses the editor's TextInput while typing.
    boxStyle.backgroundColor = color;
    textStyle.color = contrastOn(color);
  } else if (bg === 'soft') {
    boxStyle.backgroundColor = 'rgba(0,0,0,0.45)';
  } else if (s.font === 'neon') {
    // Free-floating neon: the glow IS the separation from the media.
    textStyle.textShadowColor = color;
    textStyle.textShadowRadius = 14;
    textStyle.textShadowOffset = { width: 0, height: 0 };
  } else {
    textStyle.textShadowColor = 'rgba(0,0,0,0.6)';
    textStyle.textShadowRadius = 6;
    textStyle.textShadowOffset = { width: 0, height: 1 };
  }
  return { textStyle, boxStyle };
}

/**
 * The one true sticker renderer — standard single box, or per-line fused
 * pills for bg 'boxy' (the TikTok-caption look shared with video captions).
 * Every surface that shows a COMMITTED sticker goes through this so a story
 * looks identical in the editor layer and the viewer.
 */
export function StickerContent({ sticker }: {
  sticker: { text: string; font?: StickerFont; color?: string; bg?: StickerBg; size?: number; emoji?: boolean };
}) {
  const { textStyle, boxStyle } = resolveSticker(sticker);
  if (sticker.bg === 'boxy' && !sticker.emoji) {
    const color = sticker.color ?? '#FFFFFF';
    const fontSize = (textStyle.fontSize as number) ?? 26;
    const radius = Math.round(fontSize * 0.42);
    const lines = sticker.text.split('\n').map((l) => l.trim()).filter(Boolean);
    return (
      <View style={{ alignItems: 'center', maxWidth: 300 }}>
        {lines.map((line, i) => (
          <View
            key={i}
            style={{
              backgroundColor: color,
              borderRadius: radius,
              paddingHorizontal: Math.round(fontSize * 0.46),
              paddingVertical: Math.round(fontSize * 0.16),
              marginTop: i === 0 ? 0 : -2,
            }}
          >
            <Text style={[textStyle, { maxWidth: undefined, textShadowColor: undefined, textShadowRadius: undefined }]}>
              {line}
            </Text>
          </View>
        ))}
      </View>
    );
  }
  return (
    <View style={boxStyle}>
      <Text style={textStyle}>{sticker.text}</Text>
    </View>
  );
}

/**
 * Non-interactive render of a committed sticker set over a frame — used by the
 * reel viewer and the home feed to show a vertical video's captions. Positions
 * are normalized to (frameW, frameH), so the same data renders correctly at any
 * size (full-screen reel or a feed card).
 */
export function PlacedStickers({ stickers, frameW, frameH }: {
  stickers: Sticker[];
  frameW: number;
  frameH: number;
}) {
  if (!stickers?.length) return null;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {stickers.map((s, i) => (
        s.text ? (
          <View key={s.id ?? i} style={[StyleSheet.absoluteFill, styles.center]}>
            <View
              style={{
                transform: [
                  { translateX: (s.x - 0.5) * frameW },
                  { translateY: (s.y - 0.5) * frameH },
                  { scale: s.scale ?? 1 },
                  { rotate: `${s.rotation ?? 0}deg` },
                ],
              }}
            >
              <StickerContent sticker={s} />
            </View>
          </View>
        ) : null
      ))}
    </View>
  );
}

// Legacy export — the viewer's old single-caption placement renders with this.
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
  onDragActive, onDragMove, onRelease,
}: {
  stickers: Sticker[];
  frameW: number;
  frameH: number;
  editingId: string | null;
  onManipulate: (id: string, style: CaptionStyle) => void;
  onTapSticker: (id: string) => void;
  onTapEmpty: (xNorm: number, yNorm: number) => void;
  // Fired when a sticker drag starts/ends — the host shows its trash zone.
  onDragActive?: (active: boolean) => void;
  // Live centroid (normalized) during a drag — lets the host highlight the trash.
  onDragMove?: (xNorm: number, yNorm: number) => void;
  // Release position of a finished drag; the host deletes the sticker if it was
  // dropped on the trash. Fired after the placement has been committed.
  onRelease?: (id: string, xNorm: number, yNorm: number) => void;
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
  const cbRef = useRef({ onManipulate, onTapSticker, onTapEmpty, onDragActive, onDragMove, onRelease });
  cbRef.current = { onManipulate, onTapSticker, onTapEmpty, onDragActive, onDragMove, onRelease };

  const active = useRef<string | null>(null);
  const nearTap = useRef(false); // was the touch-down close enough to count a TAP as "edit this sticker"
  const moved = useRef(false);
  const dragSignalled = useRef(false);
  const grant = useRef({ x: 0, y: 0 });
  const last = useRef({ x: 0, y: 0 });
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

  // End of a gesture (last finger up, or the system terminated it). A tap edits
  // the nearest sticker / creates one in open area; a drag commits the new placement.
  function endGesture() {
    const id = active.current;
    if (!moved.current) {
      if (id && nearTap.current) cbRef.current.onTapSticker(id);
      else cbRef.current.onTapEmpty(grant.current.x / frameW, grant.current.y / frameH);
    } else if (id) {
      const cur = curRef.current[id];
      if (cur) cbRef.current.onManipulate(id, { x: cur.x / frameW + 0.5, y: cur.y / frameH + 0.5, scale: cur.scale, rotation: cur.rotation });
      cbRef.current.onRelease?.(id, last.current.x / frameW, last.current.y / frameH);
    }
    if (dragSignalled.current) { cbRef.current.onDragActive?.(false); dragSignalled.current = false; }
    active.current = null;
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
        last.current = { x: c.x, y: c.y };
        moved.current = false;
        // Pick the nearest sticker to the touch (by committed center).
        let nearest: string | null = null, best = Infinity;
        for (const s of stickersRef.current) {
          const sx = s.x * frameW, sy = s.y * frameH;
          const d = Math.hypot(c.x - sx, c.y - sy);
          if (d < best) { best = d; nearest = s.id; }
        }
        // Grab the nearest sticker ALWAYS, so a drag/pinch anywhere on the screen
        // manipulates it. The distance only gates a TAP (near → edit; far → create).
        active.current = nearest;
        nearTap.current = !!nearest && best <= NEAR_PX;
        rebaseline(touches);
      },
      onPanResponderMove: (e: GestureResponderEvent) => {
        const touches = e.nativeEvent.touches;
        if (touches.length === 0) return;
        if (touches.length !== prevCount.current) rebaseline(touches); // finger added/removed → no jump
        const c = centroid(touches);
        last.current = { x: c.x, y: c.y };
        if (Math.abs(c.x - grant.current.x) > 5 || Math.abs(c.y - grant.current.y) > 5) moved.current = true;
        const id = active.current;
        if (!id) return; // open-area drag: nothing to manipulate
        const a = animRef.current[id]; const cur = curRef.current[id];
        if (!a || !cur) return;
        if (moved.current && !dragSignalled.current) {
          dragSignalled.current = true;
          cbRef.current.onDragActive?.(true);
        }
        if (moved.current) cbRef.current.onDragMove?.(c.x / frameW, c.y / frameH);
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
      onPanResponderRelease: endGesture,
      onPanResponderTerminate: endGesture,
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
              <StickerContent sticker={s} />
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
