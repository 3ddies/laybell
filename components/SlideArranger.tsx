import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, PanResponder, Animated, ScrollView,
  type NativeSyntheticEvent, type NativeScrollEvent,
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
// ── Why browsing and cropping are separate ──────────────────────────────────
// Both want the same one-finger drag, so they cannot share a surface. The pager
// wins the stage (swiping between photos is what you do most), and repositioning
// moves behind Adjust, which opens the cropper over the top with paging gone.
// The pager's pages are NON-INTERACTIVE croppers, so each one still shows its
// real saved crop without competing for the swipe.
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
  const pagerRef = useRef<ScrollView>(null);

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
    pagerRef.current?.scrollTo({ x: clamped * frameW, animated: true });
  };

  const removeAt = (i: number) => {
    const list = slidesRef.current;
    if (list.length <= 1) return;
    const next = list.slice(); next.splice(i, 1);
    onChangeRef.current(next);
    const to = Math.max(0, Math.min(next.length - 1, i > next.length - 1 ? next.length - 1 : i));
    setIndex(to);
    // Without this the pager keeps its old offset and lands on the wrong photo.
    requestAnimationFrame(() => pagerRef.current?.scrollTo({ x: to * frameW, animated: false }));
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

  // ── Press-and-hold to reorder ───────────────────────────────────────────────
  // ⚠️ THE TILES NEVER REORDER MID-DRAG. The rendered order is frozen for the
  // length of the gesture: the dragged tile is pure finger delta with nothing to
  // correct, and the others spring aside around it. Reordering live meant the
  // dragged tile's own slot kept moving underneath it, and the correction landed
  // a render later than the finger — that lag WAS the unresponsiveness.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  const targetRef = useRef<number | null>(null);
  const dragX = useRef(new Animated.Value(0)).current;

  // ⚠️ Displacement values are keyed by the slide's URI — by IDENTITY, never by
  // position. Held per-slot, a tile that moved in one drag came back holding a
  // DIFFERENT Animated.Value on the next render, so the springs ended up driving
  // views they no longer belonged to. That is why the first drag was always
  // clean and every one after it was not.
  const offsetMap = useRef(new Map<string, Animated.Value>()).current;
  const offsetFor = (uri: string) => {
    let v = offsetMap.get(uri);
    if (!v) { v = new Animated.Value(0); offsetMap.set(uri, v); }
    return v;
  };
  const offsetForRef = useRef(offsetFor); offsetForRef.current = offsetFor;
  // Belt and braces: outside a drag, no tile may hold a displacement. Guarantees
  // a stuck offset can never survive into the next gesture.
  useEffect(() => {
    if (dragIndexRef.current == null) offsetMap.forEach((o) => { o.stopAnimation(); o.setValue(0); });
  }, [slides, offsetMap]);

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

  const displace = (from: number, to: number) => {
    const list = slidesRef.current;
    const p = pitchRef.current;
    for (let i = 0; i < list.length; i++) {
      if (i === from) continue;
      const shift = to > from ? (i > from && i <= to ? -p : 0)
        : to < from ? (i >= to && i < from ? p : 0)
          : 0;
      Animated.spring(offsetForRef.current(list[i].uri), {
        toValue: shift, useNativeDriver: true, friction: 14, tension: 220,
      }).start();
    }
  };

  const endDrag = () => {
    clearHold();
    const from = dragIndexRef.current;
    const to = targetRef.current;
    dragIndexRef.current = null;
    targetRef.current = null;
    setDragIndex(null);
    // Zero everything BEFORE publishing — the tiles are about to re-render in
    // their new order, and a leftover offset shows as a one-frame jump.
    dragX.setValue(0);
    offsetMap.forEach((o) => { o.stopAnimation(); o.setValue(0); });
    if (from != null && to != null && to !== from) {
      const list = slidesRef.current.slice();
      const [item] = list.splice(from, 1);
      list.splice(to, 0, item);
      onChangeRef.current(list);
      setIndex(to);
      requestAnimationFrame(() => pagerRef.current?.scrollTo({ x: to * frameW, animated: false }));
    }
  };

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => dragIndexRef.current == null,
    onPanResponderGrant: (e) => {
      startX.current = e.nativeEvent.pageX - stripX.current + scrollX.current - STRIP_PAD;
      moved.current = false;
      startIdx.current = idxAtRef.current(e.nativeEvent.pageX);
      clearHold();
      holdTimer.current = setTimeout(() => {
        dragIndexRef.current = startIdx.current;
        targetRef.current = startIdx.current;
        setDragIndex(startIdx.current);
        dragX.setValue(0);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      }, HOLD_MS);
    },
    onPanResponderMove: (_e, g) => {
      if (Math.abs(g.dx) > HOLD_SLOP || Math.abs(g.dy) > HOLD_SLOP) moved.current = true;
      const from = dragIndexRef.current;
      if (from == null) { if (moved.current) clearHold(); return; }
      dragX.setValue(g.dx);
      const target = Math.max(0, Math.min(slidesRef.current.length - 1,
        Math.round((startX.current + g.dx - pitchRef.current / 2) / pitchRef.current)));
      if (target !== targetRef.current) {
        displace(from, target);
        targetRef.current = target;
        Haptics.selectionAsync().catch(() => {});
      }
    },
    onPanResponderRelease: (e) => {
      if (dragIndexRef.current == null) {
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

  const onPagerEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.round(e.nativeEvent.contentOffset.x / Math.max(1, frameW));
    if (i !== indexRef.current) setIndex(Math.max(0, Math.min(slides.length - 1, i)));
  };

  return (
    <View style={styles.root}>
      {/* ── Stage: swipe between photos ─────────────────────────────────────── */}
      <View style={{ width: frameW, height: frameH }}>
        <ScrollView
          ref={pagerRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={onPagerEnd}
          scrollEventThrottle={16}
        >
          {slides.map((s) => (
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
                // A cropper with its gestures off: shows the real saved crop and
                // leaves the swipe alone.
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
        </ScrollView>

        {/* Delete the photo you are looking at. */}
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
        scrollEnabled={dragIndex == null}
        onScroll={(e) => { scrollX.current = e.nativeEvent.contentOffset.x; }}
        scrollEventThrottle={16}
        contentContainerStyle={styles.stripContent}
      >
        <View
          style={styles.strip}
          {...pan.panHandlers}
        >
          {slides.map((s, i) => {
            const dragging = dragIndex === i;
            return (
              <Animated.View
                // Keyed on URI alone. With the index in the key, every reorder
                // rebuilt the tiles after the moved one and the thumbnails
                // visibly reloaded mid-drag.
                key={s.uri}
                style={[
                  styles.tile,
                  { marginRight: i === slides.length - 1 ? 0 : TILE_GAP, borderColor: i === index ? colors.text : 'transparent' },
                  dragging ? {
                    transform: [{ translateX: dragX }, { scale: 1.16 }],
                    zIndex: 5, elevation: 8,
                    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 9, shadowOffset: { width: 0, height: 5 },
                    borderColor: colors.text,
                  } : { transform: [{ translateX: offsetFor(s.uri) }] },
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
