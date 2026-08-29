import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, PanResponder, Animated, ScrollView,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import MediaCropper, { type MediaCropperHandle, type CropRect } from './MediaCropper';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { SLIDESHOW_FORMATS, defaultFitFor, isAutoFormat, type SlideFit } from '../lib/aspectRatio';
import { useThemedStyles, useTheme } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

// The step between picking a slideshow's media and writing the post.
//
// Before this existed you could only crop the LAST slide you added — the pick
// screen mounts one cropper, on the newest item, so everything picked before it
// published at whatever centred cover crop it happened to land on.
//
// ── Why nothing here is a ScrollView ────────────────────────────────────────
// Browsing, reordering and cropping all want the same one-finger drag. A native
// pager OWNS the touch it receives, so a long press inside one can never take
// the gesture back — every attempt to arbitrate between them on this screen has
// failed. So the stage is driven by ONE responder that decides for itself: move
// first and it pages, hold first and it reorders. Cropping stays out of the
// contest entirely, behind Adjust, which opens over the top with paging gone.
// The stage pages are NON-INTERACTIVE croppers, so each still shows its real
// saved crop without competing for anything.
//
// ⚠️ NO COLOUR FILTERS, and that is a platform limit rather than a decision.
// The only image processing this project has is expo-image-manipulator, which
// does geometry — crop, rotate, flip — and nothing tonal. Real filters need a
// GPU path (Skia or GL), which means a native module and a rebuild.

export type ArrangerSlide = {
  uri: string;
  type: 'image' | 'video';
  width: number;
  height: number;
  posterUri?: string | null;
  thumbnailUri?: string | null;
  crop?: CropRect | null;
  fit?: SlideFit | null;
};

export type SlideArrangerHandle = {
  /** Flush the crop the open Adjust sheet is holding, if any. */
  commit: () => void;
};

const STRIP_H = 76;
const STRIP_PAD = SPACING.md;
const TILE_GAP = 8;
const TILE = 58;
// Bigger targets than the old 40pt tiles. Reordering by feel needs something you
// can actually land a thumb on.
const HOLD_MS = 140;
const HOLD_SLOP = 12;
// How far the finger travels on the STAGE to move a slide one position. A full
// frame width per step would mean dragging a whole screen to move one place.
const STAGE_STEP = 76;

const SlideArranger = forwardRef<SlideArrangerHandle, {
  slides: ArrangerSlide[];
  frameW: number;
  frameH: number;
  format: string;
  onFormatChange: (next: string) => void;
  onChange: (next: ArrangerSlide[]) => void;
}>(function SlideArranger({ slides, frameW, frameH, format, onFormatChange, onChange }, ref) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();

  const [index, setIndex] = useState(0);
  const [adjusting, setAdjusting] = useState(false);
  const cropperRef = useRef<MediaCropperHandle>(null);
  // The stage's own transform. pageX is the strip offset (-index * frameW);
  // stageScale dips while a slide is held, so picking one up has a moment.
  const pageX = useRef(new Animated.Value(0)).current;
  const stageScale = useRef(new Animated.Value(1)).current;

  // Anything the gesture handlers read lives behind a ref: PanResponder.create
  // runs ONCE and closes over its first render forever.
  const slidesRef = useRef(slides); slidesRef.current = slides;
  const indexRef = useRef(index); indexRef.current = index;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;

  const pitch = TILE + TILE_GAP;
  const pitchRef = useRef(pitch); pitchRef.current = pitch;

  const fitOf = (s?: ArrangerSlide | null): SlideFit => s?.fit ?? defaultFitFor(format);
  const cur = slides[Math.min(index, Math.max(0, slides.length - 1))];
  const curFit = fitOf(cur);

  // ── Crop, read out of the Adjust sheet ──────────────────────────────────────
  const commit = () => {
    const i = indexRef.current;
    const list = slidesRef.current;
    const s = list[i];
    if (!s || s.type !== 'image') return;
    const c = cropperRef.current?.getCrop();
    if (!c) return;
    if (s.crop && s.crop.originX === c.originX && s.crop.originY === c.originY
      && s.crop.width === c.width && s.crop.height === c.height) return;
    const next = list.slice();
    next[i] = { ...next[i], crop: c };
    onChangeRef.current(next);
  };
  const commitRef = useRef(commit); commitRef.current = commit;
  useImperativeHandle(ref, () => ({ commit: () => commitRef.current() }), []);
  useEffect(() => () => { commitRef.current(); }, []);

  const goTo = (i: number) => {
    const clamped = Math.max(0, Math.min(slidesRef.current.length - 1, i));
    setIndex(clamped);
    Animated.spring(pageX, { toValue: -clamped * frameW, useNativeDriver: true, friction: 12, tension: 140 }).start();
  };

  const removeAt = (i: number) => {
    const list = slidesRef.current;
    if (list.length <= 1) return;
    const next = list.slice(); next.splice(i, 1);
    onChangeRef.current(next);
    const to = Math.max(0, Math.min(next.length - 1, i > next.length - 1 ? next.length - 1 : i));
    setIndex(to);
    // Without this the stage keeps its old offset and lands on the wrong photo.
    pageX.setValue(-to * frameW);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  };

  const setFit = (next: SlideFit) => {
    const i = indexRef.current;
    const list = slidesRef.current;
    if (!list[i] || list[i].type !== 'image') return;
    const after = list.slice();
    after[i] = { ...after[i], fit: next };
    onChangeRef.current(after);
  };

  // ── Press-and-hold to reorder: SWAP, never insert ───────────────────────────
  //
  // The tiles TRADE PLACES. Dragging one over another swaps the pair, so every
  // slot holds exactly one tile at every moment and a gap is not a state this
  // row can be in. The previous version slid its neighbours aside to open a
  // landing space instead, and any glitch in those displacement springs left a
  // hole with nothing in it — which is exactly what kept showing up.
  //
  // That also deletes the machinery the holes came from. There are no per-tile
  // offset values and no springs to strand: the array itself reorders, so the
  // untouched tiles are simply laid out by flexbox, where they cannot be wrong.
  //
  // The dragged tile's position is recomputed from ABSOLUTE numbers every move —
  // finger position minus the centre of the slot it currently occupies. Nothing
  // accumulates, so a swap needs no correction and cannot drift or lag behind
  // the finger. That was the flaw in the very first version: it tracked deltas
  // and had to keep subtracting how far its own slot had moved, a render late.
  const [order, setOrder] = useState<ArrangerSlide[] | null>(null);
  const orderRef = useRef<ArrangerSlide[] | null>(null);
  const [dragUri, setDragUri] = useState<string | null>(null);
  const dragUriRef = useRef<string | null>(null);
  const dragX = useRef(new Animated.Value(0)).current;
  // What both the stage and the strip render: the live drag order while a slide
  // is held, the committed array otherwise.
  const view = order ?? slides;

  const stripRef = useRef<View>(null);
  const stripX = useRef(0);
  const scrollX = useRef(0);
  const measureStrip = () => stripRef.current?.measureInWindow((x) => { stripX.current = x; });
  // Absolute pageX, never locationX — locationX is relative to the TILE that was
  // touched, not the strip, so it divided back to the wrong index every time.
  const idxAt = (pageX: number) => Math.max(0, Math.min(slidesRef.current.length - 1,
    Math.floor((pageX - stripX.current + scrollX.current - STRIP_PAD) / pitchRef.current)));
  const idxAtRef = useRef(idxAt); idxAtRef.current = idxAt;

  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startIdx = useRef(0);
  const startX = useRef(0);
  const moved = useRef(false);
  const clearHold = () => { if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; } };

  /** Where the dragged tile must sit so its centre is under the finger. */
  const trackFinger = (fingerX: number, slot: number) => {
    dragX.setValue(fingerX - (slot * pitchRef.current + TILE / 2));
  };

  // ── Shared by both surfaces ─────────────────────────────────────────────────
  /** Take hold of a slide. Also MOVES THE SELECTION to it, so the row never
   *  shows two highlights — the one you are holding is the one you are on. */
  const beginDrag = (slot: number, snapStage: boolean) => {
    const list = slidesRef.current.slice();
    const i = Math.max(0, Math.min(list.length - 1, slot));
    orderRef.current = list;
    setOrder(list);
    dragUriRef.current = list[i].uri;
    setDragUri(list[i].uri);
    setIndex(i);
    if (snapStage) Animated.spring(pageX, { toValue: -i * frameW, useNativeDriver: true, friction: 12, tension: 140 }).start();
    Animated.spring(stageScale, { toValue: 0.94, useNativeDriver: true, friction: 9, tension: 160 }).start();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    return i;
  };

  /** Trade the held slide into `slot`, if it isn't already there. */
  const swapTo = (slot: number): number => {
    const uri = dragUriRef.current;
    const list = orderRef.current;
    if (!uri || !list) return -1;
    const held = list.findIndex((s) => s.uri === uri);
    const to = Math.max(0, Math.min(list.length - 1, slot));
    if (held < 0 || to === held) return held;
    const next = list.slice();
    const tmp = next[held]; next[held] = next[to]; next[to] = tmp;
    orderRef.current = next;
    setOrder(next);
    setIndex(to);
    // The stage keeps showing the slide you are holding, which has just moved to
    // a different page. Jumping without animation means it does not appear to
    // move at all — only the row beneath it changes.
    pageX.setValue(-to * frameW);
    Haptics.selectionAsync().catch(() => {});
    return to;
  };

  const endDrag = () => {
    clearHold();
    const final = orderRef.current;
    const uri = dragUriRef.current;
    orderRef.current = null;
    dragUriRef.current = null;
    setDragUri(null);
    dragX.setValue(0);
    setOrder(null);
    Animated.spring(stageScale, { toValue: 1, useNativeDriver: true, friction: 9, tension: 160 }).start();
    if (final && uri) {
      onChangeRef.current(final);
      const landed = final.findIndex((s) => s.uri === uri);
      if (landed >= 0) { setIndex(landed); pageX.setValue(-landed * frameW); }
    }
  };

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => dragUriRef.current == null,
    onPanResponderGrant: (e) => {
      startX.current = e.nativeEvent.pageX - stripX.current + scrollX.current - STRIP_PAD;
      moved.current = false;
      startIdx.current = idxAtRef.current(e.nativeEvent.pageX);
      clearHold();
      holdTimer.current = setTimeout(() => {
        // Selecting the held tile is what keeps a single highlight on screen —
        // and it brings the stage to the photo you are about to move.
        const i = beginDrag(startIdx.current, true);
        trackFinger(startX.current, i);
      }, HOLD_MS);
    },
    onPanResponderMove: (_e, g) => {
      if (Math.abs(g.dx) > HOLD_SLOP || Math.abs(g.dy) > HOLD_SLOP) moved.current = true;
      const uri = dragUriRef.current;
      const list = orderRef.current;
      if (!uri || !list) { if (moved.current) clearHold(); return; }

      const fingerX = startX.current + g.dx;
      const held = list.findIndex((s) => s.uri === uri);
      const slot = Math.max(0, Math.min(list.length - 1, Math.floor(fingerX / pitchRef.current)));
      // TRADE PLACES. Both tiles keep a slot, so the row is never short one.
      const landed = slot !== held ? swapTo(slot) : held;
      trackFinger(fingerX, landed >= 0 ? landed : slot);
    },
    onPanResponderRelease: (e) => {
      if (dragUriRef.current == null) {
        clearHold();
        if (!moved.current) goToRef.current(idxAtRef.current(e.nativeEvent.pageX));
        return;
      }
      endDrag();
    },
    onPanResponderTerminate: () => { endDrag(); },
  })).current;
  const goToRef = useRef(goTo); goToRef.current = goTo;
  useEffect(() => () => clearHold(), []);

  // ── The stage's own responder ───────────────────────────────────────────────
  // Move first and it pages; hold first and it reorders. One piece of code
  // decides which, so there is nothing to arbitrate.
  //
  // Reordering from here steps by STAGE_STEP rather than a full frame width:
  // dragging a whole screen per position would be unusable, and the strip below
  // is where the result is legible anyway.
  const stageStart = useRef(0);
  const stageOffset = useRef(0);
  const stageIdx = useRef(0);
  const stagePan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => dragUriRef.current == null,
    onPanResponderGrant: (e) => {
      stageStart.current = e.nativeEvent.pageX;
      stageOffset.current = -indexRef.current * frameW;
      stageIdx.current = indexRef.current;
      moved.current = false;
      clearHold();
      holdTimer.current = setTimeout(() => {
        stageIdx.current = beginDrag(indexRef.current, false);
      }, HOLD_MS);
    },
    onPanResponderMove: (_e, g) => {
      if (Math.abs(g.dx) > HOLD_SLOP || Math.abs(g.dy) > HOLD_SLOP) moved.current = true;
      if (dragUriRef.current) {
        const to = swapTo(stageIdx.current + Math.round(g.dx / STAGE_STEP));
        if (to >= 0 && to !== stageIdx.current) {
          // Rebase so the next step is measured from where it landed, not from
          // where the finger began.
          stageStart.current += (to - stageIdx.current) * STAGE_STEP;
          stageIdx.current = to;
        }
        return;
      }
      if (moved.current) clearHold();
      pageX.setValue(stageOffset.current + g.dx);
    },
    onPanResponderRelease: (_e, g) => {
      clearHold();
      if (dragUriRef.current) { endDrag(); return; }
      // Snap. Velocity counts so a flick pages without having to travel half a
      // screen first.
      const n = slidesRef.current.length;
      const raw = -(stageOffset.current + g.dx) / Math.max(1, frameW);
      const bias = Math.abs(g.vx) > 0.35 ? (g.vx < 0 ? 0.35 : -0.35) : 0;
      goToRef.current(Math.max(0, Math.min(n - 1, Math.round(raw + bias))));
    },
    onPanResponderTerminate: () => { clearHold(); if (dragUriRef.current) endDrag(); },
  })).current;

  // Keep the stage on the selected slide when something else moves it (a
  // thumbnail tap, a deletion) and after the first layout.
  useEffect(() => {
    if (dragUriRef.current) return;
    pageX.setValue(-Math.min(index, Math.max(0, slides.length - 1)) * frameW);
  }, [index, frameW, slides.length, pageX]);

  return (
    <View style={styles.root}>
      {/* ── Stage: swipe to browse, hold to reorder ──────────────────────────
          Hand-driven rather than a paging ScrollView, and that is the enabling
          change rather than a preference. A native pager OWNS the touch, so a
          long press inside it can never take the gesture back — the drag would
          have to wrestle the scroll for it, which is the arbitration that has
          failed on this screen every time it has been tried. One responder that
          decides for itself can do both: move first and it pages, hold first and
          it reorders. Nothing has to be negotiated. */}
      <View style={{ width: frameW, height: frameH }}>
      <Animated.View
        style={[StyleSheet.absoluteFill, { overflow: 'hidden' }, { transform: [{ scale: stageScale }] }]}
        {...stagePan.panHandlers}
      >
        <Animated.View style={{ flexDirection: 'row', width: frameW * Math.max(1, view.length), height: frameH, transform: [{ translateX: pageX }] }}>
          {view.map((s) => (
            <View key={s.uri} style={{ width: frameW, height: frameH, backgroundColor: '#000' }}>
              {s.type === 'video' ? (
                <ExpoImage
                  source={{ uri: s.posterUri || s.thumbnailUri || s.uri }}
                  style={StyleSheet.absoluteFill}
                  contentFit="contain"
                  cachePolicy="memory-disk"
                />
              ) : fitOf(s) === 'contain' ? (
                <ExpoImage
                  source={{ uri: s.uri }}
                  style={StyleSheet.absoluteFill}
                  contentFit="contain"
                  cachePolicy="memory-disk"
                />
              ) : (
                // A cropper with its gestures off: shows the real saved crop
                // without competing for the drag.
                <MediaCropper
                  key={`${s.uri}-page`}
                  uri={s.uri}
                  mediaWidth={s.width}
                  mediaHeight={s.height}
                  frameW={frameW}
                  frameH={frameH}
                  type="image"
                  initialCrop={s.crop ?? null}
                  interactive={false}
                />
              )}
            </View>
          ))}
        </Animated.View>
      </Animated.View>

        {/* Delete the photo you are looking at. Deliberately a SIBLING of the
            pan surface, not a child: that responder claims every touch inside
            itself, so a button in there could never fire. */}
        {slides.length > 1 && (
          <TouchableOpacity
            style={styles.stageClose}
            onPress={() => removeAt(indexRef.current)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel={t('post.slideRemove')}
          >
            <Ionicons name="close" size={17} color="#fff" />
          </TouchableOpacity>
        )}

        {slides.length > 1 && (
          <View style={styles.dots} pointerEvents="none">
            {slides.map((s, i) => (
              <View key={s.uri} style={[styles.dot, i === index && styles.dotOn]} />
            ))}
          </View>
        )}
      </View>

      {/* ── Frame, for the whole set ─────────────────────────────────────────── */}
      <View style={styles.fmtRow}>
        {SLIDESHOW_FORMATS.map((f) => (
          <TouchableOpacity
            key={f}
            style={[styles.fmtBtn, format === f && styles.fmtBtnOn]}
            onPress={() => onFormatChange(f)}
            activeOpacity={0.85}
          >
            <Text style={[styles.fmtText, format === f && styles.fmtTextOn]} numberOfLines={1}>
              {isAutoFormat(f) ? t(`post.format.${f}`) : f}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* ── Per-photo: fill or fit, and reposition ───────────────────────────── */}
      {cur?.type === 'image' && (
        <View style={styles.toolRow}>
          {(['cover', 'contain'] as const).map((f) => (
            <TouchableOpacity
              key={f}
              style={[styles.tool, curFit === f && styles.toolOn]}
              onPress={() => setFit(f)}
              activeOpacity={0.85}
            >
              <Ionicons
                name={f === 'cover' ? 'crop' : 'scan-outline'}
                size={14}
                color={curFit === f ? colors.background : colors.textSecondary}
              />
              <Text style={[styles.toolText, curFit === f && styles.toolTextOn]}>
                {t(f === 'cover' ? 'post.slideFill' : 'post.slideFit')}
              </Text>
            </TouchableOpacity>
          ))}
          {/* Only Fill has anything to reposition — a fitted photo is all there. */}
          {curFit === 'cover' && (
            <TouchableOpacity style={styles.tool} onPress={() => setAdjusting(true)} activeOpacity={0.85}>
              <Ionicons name="move-outline" size={14} color={colors.textSecondary} />
              <Text style={styles.toolText}>{t('post.slideAdjust')}</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      <Text style={styles.hint}>{t('post.slideOrderHint')}</Text>

      {/* ── Filmstrip: tap to jump, hold to drag ─────────────────────────────── */}
      {/* The ref is on the VIEWPORT, not the scrolling content. The content's
          own window position already moves with the scroll, so measuring it
          would double-count the offset the hit test adds back. */}
      <View ref={stripRef} onLayout={measureStrip} style={styles.stripViewport}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        // Frozen while a tile is held, so the strip cannot scroll out from under
        // the drag.
        scrollEnabled={dragUri == null}
        onScroll={(e) => { scrollX.current = e.nativeEvent.contentOffset.x; }}
        scrollEventThrottle={16}
        contentContainerStyle={styles.stripContent}
      >
        <View
          style={styles.strip}
          {...pan.panHandlers}
        >
          {(order ?? slides).map((s, i) => {
            const dragging = dragUri === s.uri;
            return (
              <Animated.View
                // Keyed on URI alone. With the index in the key, every reorder
                // rebuilt the tiles after the moved one and the thumbnails
                // visibly reloaded mid-drag.
                key={s.uri}
                style={[
                  styles.tile,
                  { marginRight: i === (order ?? slides).length - 1 ? 0 : TILE_GAP, borderColor: i === index ? colors.text : 'transparent' },
                  // ONLY the dragged tile is ever transformed. Every other tile
                  // sits where flexbox puts it, because the array itself has
                  // already swapped — so there is no per-tile animated value that
                  // could be left stranded, and no slot that can end up empty.
                  dragging ? {
                    transform: [{ translateX: dragX }, { scale: 1.16 }],
                    zIndex: 5, elevation: 8,
                    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 9, shadowOffset: { width: 0, height: 5 },
                    borderColor: colors.text,
                  } : null,
                ]}
              >
                <ExpoImage
                  source={{ uri: s.type === 'video' ? (s.posterUri || s.thumbnailUri || s.uri) : s.uri }}
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                />
                {s.type === 'video' && (
                  <View style={styles.tileVideo}><Ionicons name="videocam" size={11} color="#fff" /></View>
                )}
                {/* Always shown, and always correct: the order really does
                    change as you swap, so these numbers are live rather than a
                    stale record of where each tile started. */}
                <View style={styles.tileNum}><Text style={styles.tileNumText}>{i + 1}</Text></View>
              </Animated.View>
            );
          })}
        </View>
      </ScrollView>
      </View>

      {/* ── Adjust sheet: the ONLY place the cropper takes gestures ──────────── */}
      {adjusting && cur?.type === 'image' && (
        <View style={styles.sheet}>
          <MediaCropper
            key={`${cur.uri}-adjust`}
            ref={cropperRef}
            uri={cur.uri}
            mediaWidth={cur.width}
            mediaHeight={cur.height}
            frameW={frameW}
            frameH={frameH}
            type="image"
            initialCrop={cur.crop ?? null}
          />
          <Text style={styles.sheetHint}>{t('post.slideCropHint')}</Text>
          <TouchableOpacity
            style={styles.sheetDone}
            onPress={() => { commitRef.current(); setAdjusting(false); }}
            activeOpacity={0.85}
          >
            <Text style={styles.sheetDoneText}>{t('post.slideDone')}</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
});

export default SlideArranger;

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  root: { alignItems: 'center' },
  stageClose: {
    position: 'absolute', top: SPACING.sm, right: SPACING.sm,
    width: 30, height: 30, borderRadius: 15,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.55)',
  },
  dots: {
    position: 'absolute', left: 0, right: 0, bottom: SPACING.sm,
    flexDirection: 'row', justifyContent: 'center', gap: 5,
  },
  dot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: 'rgba(255,255,255,0.4)' },
  dotOn: { backgroundColor: '#fff' },

  fmtRow: { flexDirection: 'row', gap: 6, marginTop: SPACING.sm, paddingHorizontal: SPACING.md },
  fmtBtn: {
    paddingVertical: 6, paddingHorizontal: SPACING.sm + 2,
    borderRadius: RADIUS.full, backgroundColor: c.surfaceLight,
    borderWidth: 1, borderColor: c.border,
  },
  fmtBtnOn: { backgroundColor: c.text, borderColor: c.text },
  fmtText: { color: c.textSecondary, fontSize: 12.5, fontWeight: '700' },
  fmtTextOn: { color: c.background, fontWeight: '800' },

  toolRow: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.sm },
  tool: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingVertical: 7, paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.full, backgroundColor: c.surfaceLight,
    borderWidth: 1, borderColor: c.border,
  },
  // Selected inverts rather than taking the accent — brand is for terminal
  // actions, and these are mode switches.
  toolOn: { backgroundColor: c.text, borderColor: c.text },
  toolText: { color: c.textSecondary, fontSize: 13, fontWeight: '700' },
  toolTextOn: { color: c.background, fontWeight: '800' },

  hint: {
    color: c.textTertiary, fontSize: 12, fontWeight: '600',
    marginTop: SPACING.sm, marginBottom: SPACING.xs, paddingHorizontal: SPACING.md, textAlign: 'center',
  },
  stripViewport: { alignSelf: 'stretch', height: STRIP_H },
  stripContent: { alignItems: 'center' },
  strip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: STRIP_PAD, height: STRIP_H },
  tile: {
    width: TILE, height: TILE,
    borderRadius: RADIUS.sm, overflow: 'hidden', backgroundColor: c.surfaceLight,
    borderWidth: 2,
  },
  tileVideo: { position: 'absolute', top: 2, left: 2 },
  tileNum: {
    position: 'absolute', right: 2, bottom: 2,
    minWidth: 15, height: 15, borderRadius: 7.5, paddingHorizontal: 3,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.65)',
  },
  tileNumText: { color: '#fff', fontSize: 9.5, fontWeight: '800' },

  sheet: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: c.background, alignItems: 'center', justifyContent: 'center', zIndex: 20,
  },
  sheetHint: {
    color: c.textTertiary, fontSize: 12, fontWeight: '600',
    marginTop: SPACING.md, paddingHorizontal: SPACING.lg, textAlign: 'center',
  },
  sheetDone: {
    marginTop: SPACING.md, paddingVertical: 10, paddingHorizontal: SPACING.xl,
    borderRadius: RADIUS.full, backgroundColor: c.text,
  },
  sheetDoneText: { color: c.background, fontSize: 15, fontWeight: '800' },
});
