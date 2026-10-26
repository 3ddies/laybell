import { useRef, useState } from 'react';
import { Alert, PanResponder, StyleSheet, Text, TouchableOpacity, View, type GestureResponderEvent } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { STICKER_COLORS } from './StickerLayer';
import { StoryBackgroundPicker, DEFAULT_BG, type StoryBg } from './StoryBackgroundLayer';
import { SPACING } from '../constants/theme';
import { selection } from '../lib/haptics';
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

const SIZE_MIN = 3;      // continuous pen/eraser size range (was 3 fixed widths)
const SIZE_MAX = 34;
const MIN_DIST = 6;      // px between captured points (decimation)
const MAX_POINTS = 160;  // per stroke, a hard cap on the raw point (view) count

// Chaikin corner-cutting: replace each inner corner with points at 1/4 and 3/4 of its
// segments, rounding the blocky decimated polyline into a flowing curve. Endpoints are
// preserved; a couple of passes is plenty for a doodle.
function smooth(pts: [number, number][], iterations: number): [number, number][] {
  let out = pts;
  for (let it = 0; it < iterations && out.length >= 3; it++) {
    const next: [number, number][] = [out[0]];
    for (let i = 0; i < out.length - 1; i++) {
      const [ax, ay] = out[i];
      const [bx, by] = out[i + 1];
      next.push([ax + (bx - ax) * 0.25, ay + (by - ay) * 0.25]);
      next.push([ax + (bx - ax) * 0.75, ay + (by - ay) * 0.75]);
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

// One stroke rendered as overlapping rounded bars along a SMOOTHED curve (points in
// PIXELS). Each bar is lengthened by `width` so its rounded ends overlap the neighbours
// — the joints fill in, so it reads as one continuous stroke with no per-vertex dots.
function StrokePath({ pts, color, width }: { pts: [number, number][]; color: string; width: number }) {
  if (pts.length === 0) return null;
  // A single tap is just a dot.
  if (pts.length === 1) {
    const [x, y] = pts[0];
    return <View style={{ position: 'absolute', left: x - width / 2, top: y - width / 2, width, height: width, borderRadius: width / 2, backgroundColor: color }} />;
  }
  const sm = smooth(pts, 2);
  const nodes: React.ReactNode[] = [];
  for (let i = 1; i < sm.length; i++) {
    const [ax, ay] = sm[i - 1];
    const [bx, by] = sm[i];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) continue;
    const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    const barLen = len + width;
    nodes.push(
      <View
        key={`s${i}`}
        style={{
          position: 'absolute', left: mx - barLen / 2, top: my - width / 2,
          width: barLen, height: width, borderRadius: width / 2, backgroundColor: color,
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

// The full-screen draw-mode overlay. Two tabs — Draw (pen) and Background (the
// bg picker, shown only when the story can take one, i.e. an adjustable photo).
// `strokes` and `bg` are owned by the host so they survive leaving/re-entering.
//
// Shortcut: a double-tap whose SECOND tap is HELD paints the background the current
// pen colour — a fast way to recolour the backdrop without leaving the Draw tab.
export function StoryDrawCanvas({
  strokes, onChange, onClose, frameW, frameH, insetsTop, insetsBottom,
  bg, onChangeBg, backdropUri, canBg,
}: {
  strokes: DrawStroke[];
  onChange: (next: DrawStroke[]) => void;
  onClose: () => void;
  frameW: number;
  frameH: number;
  insetsTop: number;
  insetsBottom: number;
  bg?: StoryBg;
  onChangeBg?: (b: StoryBg) => void;
  backdropUri?: string | null;
  canBg?: boolean; // show the Background tab (+ enable the double-tap-hold shortcut)
}) {
  const { t } = useTranslation();
  const [color, setColor] = useState(STICKER_COLORS[0] ?? '#FFFFFF');
  const [width, setWidth] = useState(12);                        // continuous pen/eraser size
  const [mode, setMode] = useState<'draw' | 'erase'>('draw');    // the active tool
  const [colorsOpen, setColorsOpen] = useState(false);           // the collapsed colour reel is expanded
  const [active, setActive] = useState<[number, number][]>([]); // in-progress stroke, PIXELS
  const [tab, setTab] = useState<'draw' | 'bg'>('draw');
  // Side size slider — same tapered look as the text-size slider (top = biggest).
  const SLIDER_H = Math.round(Math.min(176, frameH * 0.21));
  const sizeFromTrackY = (y: number) => Math.round(SIZE_MAX - (Math.max(0, Math.min(SLIDER_H, y)) / SLIDER_H) * (SIZE_MAX - SIZE_MIN));
  // Refs mirror state for the once-created PanResponder.
  const colorRef = useRef(color); colorRef.current = color;
  const widthRef = useRef(width); widthRef.current = width;
  const strokesRef = useRef(strokes); strokesRef.current = strokes;
  const tabRef = useRef(tab); tabRef.current = tab;
  const modeRef = useRef(mode); modeRef.current = mode;
  const onChangeBgRef = useRef(onChangeBg); onChangeBgRef.current = onChangeBg;
  const canBgRef = useRef(canBg); canBgRef.current = canBg;
  // Eraser = remove any stroke the finger passes over (hit radius scales with size).
  // Kept in a ref so the once-created PanResponder always calls the latest closure.
  const eraseAtRef = useRef<(px: number, py: number) => void>(() => {});
  eraseAtRef.current = (px, py) => {
    const r = width / 2 + 10;
    const next = strokes.filter((st) => !st.p.some(([nx, ny]) => Math.hypot(nx * frameW - px, ny * frameH - py) <= r + st.w / 2));
    if (next.length !== strokes.length) onChange(next);
  };
  const ptsRef = useRef<[number, number][]>([]);
  // Double-tap-and-hold tracking.
  const lastTap = useRef({ t: 0, x: 0, y: 0, dot: false });
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSecond = useRef(false); // this touch is the 2nd tap of a possible hold
  const moved = useRef(false);
  const consumed = useRef(false); // the hold fired → don't draw / commit this touch

  const DTAP_MS = 320, HOLD_MS = 340, NEAR = 44;
  const clearHold = () => { if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; } };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => tabRef.current === 'draw',
      onMoveShouldSetPanResponder: () => tabRef.current === 'draw',
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e: GestureResponderEvent) => {
        const { pageX, pageY } = e.nativeEvent;
        if (modeRef.current === 'erase') { eraseAtRef.current(pageX, pageY); return; }
        const now = Date.now();
        moved.current = false; consumed.current = false; clearHold();
        const lt = lastTap.current;
        // The double-tap-hold shortcut only applies where a background can be set.
        const canHold = !!onChangeBgRef.current && !!canBgRef.current;
        isSecond.current = canHold && now - lt.t < DTAP_MS && Math.hypot(pageX - lt.x, pageY - lt.y) < NEAR;
        ptsRef.current = [[pageX, pageY]];
        if (isSecond.current) {
          // Wait to see if it's a HOLD (→ paint the bg) or a drag (→ draw). No dot yet.
          holdTimer.current = setTimeout(() => {
            if (moved.current) return;
            consumed.current = true;
            ptsRef.current = [];
            setActive([]);
            // The first tap's dot is the pen colour — invisible on the new bg; drop it.
            if (lastTap.current.dot) onChange(strokesRef.current.slice(0, -1));
            onChangeBgRef.current?.({ type: 'color', color: colorRef.current });
            lastTap.current = { t: 0, x: 0, y: 0, dot: false };
            selection();
          }, HOLD_MS);
        } else {
          setActive([[pageX, pageY]]);
        }
      },
      onPanResponderMove: (e: GestureResponderEvent) => {
        const { pageX, pageY } = e.nativeEvent;
        if (modeRef.current === 'erase') { eraseAtRef.current(pageX, pageY); return; }
        if (consumed.current) return;
        const pts = ptsRef.current;
        const first = pts[0];
        if (first && !moved.current && Math.hypot(pageX - first[0], pageY - first[1]) > MIN_DIST) {
          moved.current = true;
          clearHold();
          if (isSecond.current) setActive([...pts]); // the 2nd tap became a stroke
        }
        if (isSecond.current && !moved.current) return; // still deciding hold vs draw
        const last = pts[pts.length - 1];
        if (last && Math.hypot(pageX - last[0], pageY - last[1]) < MIN_DIST) return;
        if (pts.length >= MAX_POINTS) return;
        pts.push([pageX, pageY]);
        setActive([...pts]);
      },
      onPanResponderRelease: () => {
        clearHold();
        if (modeRef.current === 'erase') { ptsRef.current = []; return; }
        const pts = ptsRef.current;
        if (!consumed.current && pts.length) {
          const stroke: DrawStroke = {
            c: colorRef.current,
            w: widthRef.current,
            p: pts.map(([x, y]) => [x / frameW, y / frameH] as [number, number]),
          };
          onChange([...strokesRef.current, stroke]);
          // A quick single-point tap is a "dot" — remember it so a following
          // tap-hold can pair with it (and drop it when the bg gets painted).
          lastTap.current = (!moved.current && pts.length === 1)
            ? { t: Date.now(), x: pts[0][0], y: pts[0][1], dot: true }
            : { t: 0, x: 0, y: 0, dot: false };
        } else if (!consumed.current) {
          lastTap.current = { t: 0, x: 0, y: 0, dot: false };
        }
        ptsRef.current = []; setActive([]); isSecond.current = false; consumed.current = false;
      },
      onPanResponderTerminate: () => {
        clearHold();
        ptsRef.current = []; setActive([]); isSecond.current = false; consumed.current = false;
      },
    }),
  ).current;

  // Vertical size slider on the screen edge (pure JS, no dep): drag position → size.
  const sizeSliderPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => setWidth(sizeFromTrackY(e.nativeEvent.locationY)),
      onPanResponderMove: (e) => setWidth(sizeFromTrackY(e.nativeEvent.locationY)),
    }),
  ).current;
  const confirmClear = () => {
    if (strokesRef.current.length === 0) return;
    Alert.alert(t('storyCamera.clearDrawing'), t('storyCamera.clearDrawingBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('storyCamera.clearConfirm'), style: 'destructive', onPress: () => onChange([]) },
    ]);
  };
  // Knob rides the tapered track: top = biggest size.
  const knobTop = Math.max(0, Math.min(SLIDER_H - 26, ((SIZE_MAX - width) / (SIZE_MAX - SIZE_MIN)) * SLIDER_H - 13));

  return (
    <View style={StyleSheet.absoluteFill}>
      {/* Draw surface (captures the pen on the Draw tab only). */}
      <View style={StyleSheet.absoluteFill} {...pan.panHandlers}>
        <StoryDrawRenderer strokes={strokes} frameW={frameW} frameH={frameH} />
        {active.length > 0 && <StrokePath pts={active} color={color} width={width} />}
      </View>

      {/* Size slider on the left edge — same tapered wedge as the text-size slider. */}
      {tab === 'draw' && (
        <View style={[styles.sizeSlider, { height: SLIDER_H, top: Math.max(insetsTop + 56, (frameH - SLIDER_H) / 2) }]} {...sizeSliderPan.panHandlers}>
          <View style={styles.sizeTrackWrap} pointerEvents="none">
            <View style={[styles.sizeWedge, { borderTopWidth: SLIDER_H + 90 }]} />
          </View>
          <View style={[styles.sizeKnob, { top: knobTop }]} pointerEvents="none" />
          <View style={[styles.sizeValue, { top: knobTop }]} pointerEvents="none">
            <Text style={styles.sizeValueText}>{Math.round(width)}</Text>
          </View>
        </View>
      )}

      {/* Top bar — undo (Draw only), the Draw/Background tabs, Done. */}
      <View style={[styles.topBar, { top: insetsTop + 8 }]} pointerEvents="box-none">
        <View style={styles.topSide}>
          <TouchableOpacity style={styles.pillBtn} onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('a11y.back')}>
            <Ionicons name="arrow-back" size={18} color="#fff" />
          </TouchableOpacity>
          {tab === 'draw' && (
            <TouchableOpacity
              style={styles.pillBtn}
              onPress={() => onChange(strokes.slice(0, -1))}
              disabled={strokes.length === 0}
              hitSlop={8}
              accessibilityRole="button"
            >
              <Ionicons name="arrow-undo" size={18} color={strokes.length ? '#fff' : 'rgba(255,255,255,0.4)'} />
            </TouchableOpacity>
          )}
        </View>
        {canBg && onChangeBg ? (
          <View style={styles.tabs}>
            <TouchableOpacity style={[styles.tab, tab === 'draw' && styles.tabActive]} onPress={() => setTab('draw')}>
              <Text style={[styles.tabText, tab === 'draw' && styles.tabTextActive]}>{t('storyCamera.draw')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.tab, tab === 'bg' && styles.tabActive]} onPress={() => setTab('bg')}>
              <Text style={[styles.tabText, tab === 'bg' && styles.tabTextActive]}>{t('storyCamera.background')}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.topSide} />
        )}
        <View style={[styles.topSide, styles.topSideEnd]}>
          <TouchableOpacity style={styles.doneBtn} onPress={onClose} hitSlop={8}>
            <Text style={styles.doneText}>{t('storyCamera.done')}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Bottom bar — pen controls on Draw, the background picker on Background. */}
      <View style={[styles.bottomBar, { bottom: insetsBottom + 12 }]} pointerEvents="box-none">
        {tab === 'draw' ? (
          <>
            {colorsOpen && (
              <View style={styles.swatchRow} pointerEvents="box-none">
                {STICKER_COLORS.map((c) => (
                  <TouchableOpacity
                    key={c}
                    style={[styles.swatch, { backgroundColor: c }, mode === 'draw' && color === c && styles.swatchActive]}
                    onPress={() => { setColor(c); setMode('draw'); setColorsOpen(false); }}
                  />
                ))}
              </View>
            )}
            <View style={styles.cluster} pointerEvents="box-none">
              <TouchableOpacity
                style={[styles.colorBtn, mode === 'draw' && styles.colorBtnActive]}
                onPress={() => { setColorsOpen((o) => !o); setMode('draw'); }}
                accessibilityRole="button"
                accessibilityLabel={t('storyCamera.color')}
                accessibilityState={{ expanded: colorsOpen }}
              >
                <View style={[styles.colorBtnFill, { backgroundColor: color }]} />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.toolBtn, mode === 'erase' && styles.toolBtnActive]}
                onPress={() => { setMode((m) => (m === 'erase' ? 'draw' : 'erase')); setColorsOpen(false); }}
                accessibilityRole="button"
                accessibilityLabel={t('storyCamera.eraser')}
                accessibilityState={{ selected: mode === 'erase' }}
              >
                <MaterialCommunityIcons name="eraser" size={20} color={mode === 'erase' ? '#0A0A0A' : '#fff'} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.toolBtn} onPress={confirmClear} accessibilityRole="button" accessibilityLabel={t('storyCamera.clearConfirm')}>
                <Ionicons name="trash-outline" size={19} color="#fff" />
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <StoryBackgroundPicker value={bg ?? DEFAULT_BG} onChange={onChangeBg ?? (() => {})} backdropUri={backdropUri} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: { position: 'absolute', left: SPACING.md, right: SPACING.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  topSide: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  topSideEnd: { justifyContent: 'flex-end' },
  tabs: {
    flexDirection: 'row', backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: 999, padding: 3,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.2)',
  },
  tab: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999 },
  tabActive: { backgroundColor: 'rgba(255,255,255,0.92)' },
  tabText: { color: 'rgba(255,255,255,0.8)', fontWeight: '700', fontSize: 13 },
  tabTextActive: { color: '#0A0A0A', fontWeight: '800' },
  pillBtn: {
    width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.2)',
  },
  doneBtn: { backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 999, paddingHorizontal: SPACING.md, paddingVertical: 7 },
  doneText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  bottomBar: { position: 'absolute', left: 0, right: 0, gap: SPACING.md },
  cluster: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.md },
  colorBtn: {
    width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.3)', backgroundColor: 'rgba(0,0,0,0.3)',
  },
  colorBtnActive: { borderColor: '#fff' }, // bright ring only when the pen is the active tool
  colorBtnFill: { width: 24, height: 24, borderRadius: 12 },
  toolBtn: {
    width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.2)',
  },
  toolBtnActive: { backgroundColor: 'rgba(255,255,255,0.92)', borderColor: '#fff' },
  swatchRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: SPACING.sm, paddingHorizontal: SPACING.md },
  swatch: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: 'rgba(255,255,255,0.35)' },
  swatchActive: { borderColor: '#fff', transform: [{ scale: 1.18 }] },
  // Side size slider — mirrors the text-size slider: a tapered wedge (wide top → narrow
  // bottom), a round knob, and a live value bubble. Height/borderTopWidth set inline.
  sizeSlider: { position: 'absolute', left: 4, width: 44, alignItems: 'center', zIndex: 3 },
  sizeTrackWrap: { width: 18, height: '100%', overflow: 'hidden', alignItems: 'center' },
  sizeWedge: {
    width: 0, height: 0, borderLeftWidth: 9, borderRightWidth: 9,
    borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: 'rgba(255,255,255,0.32)',
  },
  sizeKnob: {
    position: 'absolute', width: 26, height: 26, borderRadius: 13,
    backgroundColor: '#fff', borderWidth: 1, borderColor: 'rgba(0,0,0,0.06)',
    shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 5,
  },
  sizeValue: {
    position: 'absolute', left: 38, minWidth: 34, height: 26, borderRadius: 13,
    paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.22)',
  },
  sizeValueText: { color: '#fff', fontSize: 13, fontWeight: '800' },
});
