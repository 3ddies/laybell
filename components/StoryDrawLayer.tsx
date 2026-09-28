import { useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, TouchableOpacity, View, type GestureResponderEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { STICKER_COLORS } from './StickerLayer';
import { SPACING } from '../constants/theme';
import { useTranslation } from '../contexts/LanguageContext';

// A pure-JS drawing layer for stories — no native drawing library, so it ships
// without a rebuild. Each stroke is a list of points NORMALISED to the frame
// (0..1), drawn as rounded view "segments" between consecutive points with a dot
// at each vertex to smooth the joints. Stored in the stories.stickers jsonb as one
// { kind:'draw', strokes } layer (no schema change); the same renderer draws it in
// the editor and the viewer, so a doodle looks identical where it's drawn and where
// it's watched.
//
// A View-per-segment path is heavier than a real GPU/SVG canvas, so points are
// decimated as they're captured (a minimum spacing) and capped per stroke — plenty
// smooth for story doodles, and a Skia upgrade can drop in later behind this API.

export type DrawStroke = { c: string; w: number; p: [number, number][] };

const WIDTHS = [5, 10, 18];
const MIN_DIST = 6;      // px between captured points (decimation)
const MAX_POINTS = 200;  // per stroke, a hard cap on the view count

// One stroke rendered as rounded bars + vertex dots. Points are in PIXELS.
function StrokePath({ pts, color, width }: { pts: [number, number][]; color: string; width: number }) {
  if (pts.length === 0) return null;
  const nodes: React.ReactNode[] = [];
  // Dot at every vertex (rounds the joints and covers a single-tap dot).
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pts[i];
    nodes.push(
      <View
        key={`d${i}`}
        style={{ position: 'absolute', left: x - width / 2, top: y - width / 2, width, height: width, borderRadius: width / 2, backgroundColor: color }}
      />,
    );
  }
  // Bar between consecutive vertices.
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) continue;
    const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    nodes.push(
      <View
        key={`s${i}`}
        style={{
          position: 'absolute', left: mx - len / 2, top: my - width / 2,
          width: len, height: width, borderRadius: width / 2, backgroundColor: color,
          transform: [{ rotate: `${ang}deg` }],
        }}
      />,
    );
  }
  return <>{nodes}</>;
}

// Non-interactive render of committed strokes over a frame. Used by the editor
// (under the post + text) and the story viewer.
export function StoryDrawRenderer({ strokes, frameW, frameH }: { strokes?: DrawStroke[] | null; frameW: number; frameH: number }) {
  if (!strokes?.length) return null;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {strokes.map((s, i) => (
        <StrokePath key={i} color={s.c} width={s.w} pts={s.p.map(([x, y]) => [x * frameW, y * frameH] as [number, number])} />
      ))}
    </View>
  );
}

// The full-screen draw-mode overlay: drag to draw, pick colour + width, undo, done.
// `strokes` is owned by the host (so it survives leaving/re-entering draw mode); the
// canvas commits each finished stroke through onChange.
export function StoryDrawCanvas({ strokes, onChange, onClose, frameW, frameH, insetsTop, insetsBottom }: {
  strokes: DrawStroke[];
  onChange: (next: DrawStroke[]) => void;
  onClose: () => void;
  frameW: number;
  frameH: number;
  insetsTop: number;
  insetsBottom: number;
}) {
  const { t } = useTranslation();
  const [color, setColor] = useState(STICKER_COLORS[2] ?? '#F26522');
  const [width, setWidth] = useState(WIDTHS[1]);
  const [active, setActive] = useState<[number, number][]>([]); // in-progress stroke, PIXELS
  // Refs mirror state for the PanResponder (created once).
  const colorRef = useRef(color); colorRef.current = color;
  const widthRef = useRef(width); widthRef.current = width;
  const strokesRef = useRef(strokes); strokesRef.current = strokes;
  const ptsRef = useRef<[number, number][]>([]);

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e: GestureResponderEvent) => {
        const { pageX, pageY } = e.nativeEvent;
        ptsRef.current = [[pageX, pageY]];
        setActive([[pageX, pageY]]);
      },
      onPanResponderMove: (e: GestureResponderEvent) => {
        const { pageX, pageY } = e.nativeEvent;
        const pts = ptsRef.current;
        const last = pts[pts.length - 1];
        if (last && Math.hypot(pageX - last[0], pageY - last[1]) < MIN_DIST) return;
        if (pts.length >= MAX_POINTS) return;
        pts.push([pageX, pageY]);
        setActive([...pts]);
      },
      onPanResponderRelease: () => {
        const pts = ptsRef.current;
        if (pts.length) {
          const stroke: DrawStroke = {
            c: colorRef.current,
            w: widthRef.current,
            p: pts.map(([x, y]) => [x / frameW, y / frameH] as [number, number]),
          };
          onChange([...strokesRef.current, stroke]);
        }
        ptsRef.current = [];
        setActive([]);
      },
      onPanResponderTerminate: () => { ptsRef.current = []; setActive([]); },
    }),
  ).current;

  return (
    <View style={StyleSheet.absoluteFill}>
      {/* Draw surface (captures the pen). */}
      <View style={StyleSheet.absoluteFill} {...pan.panHandlers}>
        <StoryDrawRenderer strokes={strokes} frameW={frameW} frameH={frameH} />
        {active.length > 0 && <StrokePath pts={active} color={color} width={width} />}
      </View>

      {/* Top bar — Undo + Done (on top of the draw surface). */}
      <View style={[styles.topBar, { top: insetsTop + 8 }]} pointerEvents="box-none">
        <TouchableOpacity
          style={styles.pillBtn}
          onPress={() => onChange(strokes.slice(0, -1))}
          disabled={strokes.length === 0}
          hitSlop={8}
        >
          <Ionicons name="arrow-undo" size={18} color={strokes.length ? '#fff' : 'rgba(255,255,255,0.4)'} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.doneBtn} onPress={onClose} hitSlop={8}>
          <Text style={styles.doneText}>{t('storyCamera.done')}</Text>
        </TouchableOpacity>
      </View>

      {/* Bottom bar — widths + colour swatches. */}
      <View style={[styles.bottomBar, { bottom: insetsBottom + 12 }]} pointerEvents="box-none">
        <View style={styles.widthRow} pointerEvents="box-none">
          {WIDTHS.map((w) => (
            <TouchableOpacity key={w} style={[styles.widthDot, width === w && styles.widthDotActive]} onPress={() => setWidth(w)}>
              <View style={{ width: w + 2, height: w + 2, borderRadius: (w + 2) / 2, backgroundColor: '#fff' }} />
            </TouchableOpacity>
          ))}
        </View>
        <View style={styles.swatchRow} pointerEvents="box-none">
          {STICKER_COLORS.map((c) => (
            <TouchableOpacity key={c} style={[styles.swatch, { backgroundColor: c }, color === c && styles.swatchActive]} onPress={() => setColor(c)} />
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: { position: 'absolute', left: SPACING.md, right: SPACING.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pillBtn: {
    width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.2)',
  },
  doneBtn: { backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 999, paddingHorizontal: SPACING.md, paddingVertical: 7 },
  doneText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  bottomBar: { position: 'absolute', left: 0, right: 0, gap: SPACING.sm },
  widthRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: SPACING.md },
  widthDot: {
    width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)', borderWidth: 1.5, borderColor: 'transparent',
  },
  widthDotActive: { borderColor: '#fff', backgroundColor: 'rgba(0,0,0,0.5)' },
  swatchRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: SPACING.sm, paddingHorizontal: SPACING.md },
  swatch: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: 'rgba(255,255,255,0.35)' },
  swatchActive: { borderColor: '#fff', transform: [{ scale: 1.18 }] },
});
