import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, PanResponder, Animated } from 'react-native';
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
// was published at whatever centred cover crop it happened to land on. This
// screen gives every slide the same treatment, and gives the set an order.
//
// ⚠️ NO COLOUR FILTERS, and that is a platform limit rather than a decision.
// The only image processing this project has is expo-image-manipulator, which
// does geometry — crop, rotate, flip — and nothing tonal. Real filters need a
// GPU path (Skia or GL), which means a native module, which means a rebuild and
// a conversation. Everything here is geometry for that reason.

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
  /** Flush the crop the visible cropper is holding. The parent MUST call this
   *  before leaving, or the last slide the user touched publishes uncropped —
   *  the crop only exists inside the cropper until something asks for it. */
  commit: () => void;
};

const STRIP_H = 62;
// The strip's own horizontal padding. Touches arrive as locationX from the
// strip's left EDGE, so this has to come off before the number means a tile.
const STRIP_PAD = SPACING.md;
const TILE_GAP = 6;
const TILE_MAX = 56;
const TILE_MIN = 34;
// How long a press has to be held before it becomes a drag. 220ms read as a
// lag between pressing and anything happening; 150 still leaves a clean tap.
const HOLD_MS = 150;
// Movement that cancels the pending hold. A finger that travels before the timer
// fires was never trying to pick the tile up.
const HOLD_SLOP = 10;

const SlideArranger = forwardRef<SlideArrangerHandle, {
  slides: ArrangerSlide[];
  frameW: number;
  frameH: number;
  /** The composer's chosen format, which decides each slide's DEFAULT fit. */
  format: string;
  onFormatChange: (next: string) => void;
  onChange: (next: ArrangerSlide[]) => void;
}>(function SlideArranger({ slides, frameW, frameH, format, onFormatChange, onChange }, ref) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();

  const [index, setIndex] = useState(0);
  const cropperRef = useRef<MediaCropperHandle>(null);

  // Everything the gesture handlers read. PanResponder.create runs ONCE and
  // closes over its first render forever, so anything that changes has to be
  // behind a ref — this file's version of a lesson the scrubber and the
  // immersive player both taught the hard way.
  const slidesRef = useRef(slides); slidesRef.current = slides;
  const indexRef = useRef(index); indexRef.current = index;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;

  const count = Math.max(1, slides.length);
  // Sized to FIT rather than scroll. A slideshow caps at 8 slides, so the whole
  // strip fits across a phone — and a strip that doesn't scroll has no scroll
  // gesture to fight the drag for, which is most of what makes reordering
  // inside a list fiddly.
  const [stripW, setStripW] = useState(0);
  // ⚠️ The strip's absolute x, measured — NOT locationX.
  //
  // locationX is relative to the view that was actually TOUCHED, which is a tile,
  // not the strip the responder sits on. So pressing the sixth tile reported a
  // coordinate a few points from that tile's own left edge, which divided back
  // to tile 0 or 1: every press selected the wrong photo. Absolute pageX minus
  // the strip's measured origin is the same fix Scrubber uses, for the same
  // reason.
  const stripRef = useRef<View>(null);
  const stripX = useRef(0);
  const measureStrip = () => stripRef.current?.measureInWindow((x) => { stripX.current = x; });
  /** Tile index under an absolute touch x. */
  const idxAt = (pageX: number) => Math.max(0, Math.min(slidesRef.current.length - 1,
    Math.floor((pageX - stripX.current - STRIP_PAD) / pitchRef.current)));
  const idxAtRef = useRef(idxAt); idxAtRef.current = idxAt;
  // onLayout reports the strip's full width, padding included, so the padding
  // comes off before dividing — otherwise every tile is a couple of points too
  // wide and the last one runs off the end.
  const tile = stripW
    ? Math.max(TILE_MIN, Math.min(TILE_MAX, (stripW - STRIP_PAD * 2 - TILE_GAP * (count - 1)) / count))
    : TILE_MAX;
  const pitch = tile + TILE_GAP;
  const pitchRef = useRef(pitch); pitchRef.current = pitch;

  // Read the live crop out of the cropper and store it on the slide it belongs
  // to. Called before ANY change of which slide is on screen.
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
  // Leaving the screen entirely counts as leaving the slide.
  useEffect(() => () => { commitRef.current(); }, []);

  const removeAt = (i: number) => {
    const list = slidesRef.current;
    if (list.length <= 1) return;
    const next = list.slice(); next.splice(i, 1);
    onChangeRef.current(next);
    setIndex((cur) => Math.max(0, Math.min(next.length - 1, cur > i ? cur - 1 : cur)));
  };

  // ── Press-and-hold to reorder ───────────────────────────────────────────────
  // One responder for the whole strip rather than one per tile: the strip claims
  // the touch, starts a hold timer, and only becomes a drag once that timer
  // fires. A release before it fires is a tap, which selects.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  // Where the tile would land if the finger lifted now. Kept in a ref, not
  // state: nothing re-renders during a drag, which is the point.
  const targetRef = useRef<number | null>(null);
  const dragX = useRef(new Animated.Value(0)).current;
  // ⚠️ Displacement values are keyed by the slide's URI — by IDENTITY, never by
  // position. This is what makes the second drag work.
  //
  // Held in an array indexed by position, a tile that moved in the first drag
  // came back on the next render holding a DIFFERENT Animated.Value than it had
  // before, so every animated node had to be detached and re-bound across the
  // reorder. The first drag was always clean because nothing had moved yet;
  // every drag after it was animating values that no longer belonged to the
  // tiles they were attached to, which is why the wrong tiles slid.
  //
  // Keyed by URI, a tile keeps the same value for its whole life no matter where
  // it sits, and a reorder re-binds nothing at all.
  const offsetMap = useRef(new Map<string, Animated.Value>()).current;
  const offsetFor = (uri: string) => {
    let v = offsetMap.get(uri);
    if (!v) { v = new Animated.Value(0); offsetMap.set(uri, v); }
    return v;
  };
  const offsetForRef = useRef(offsetFor); offsetForRef.current = offsetFor;
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startIdx = useRef(0);
  const startX = useRef(0);
  const moved = useRef(false);

  const clearHold = () => { if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; } };

  // Push every tile out of the dragged tile's way, or back. Springs, on the
  // NATIVE driver — this is the part that makes the row feel alive instead of
  // snapping between arrangements.
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

    // Zero everything BEFORE publishing. The tiles are about to re-render in
    // their new order, and a leftover offset would show as a one-frame jump.
    dragX.setValue(0);
    offsetMap.forEach((o) => { o.stopAnimation(); o.setValue(0); });

    if (from != null && to != null && to !== from) {
      const list = slidesRef.current.slice();
      const [item] = list.splice(from, 1);
      list.splice(to, 0, item);
      onChangeRef.current(list);
      setIndex(to);
    }
  };

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => dragIndexRef.current == null,
    onPanResponderGrant: (e) => {
      startX.current = e.nativeEvent.pageX - stripX.current - STRIP_PAD;
      moved.current = false;
      startIdx.current = idxAtRef.current(e.nativeEvent.pageX);
      clearHold();
      holdTimer.current = setTimeout(() => {
        // Picking a tile up selects it too — you are about to move the thing you
        // are looking at. Commit first so the crop lands on the real array.
        if (startIdx.current !== indexRef.current) { commitRef.current(); setIndex(startIdx.current); }
        dragIndexRef.current = startIdx.current;
        targetRef.current = startIdx.current;
        setDragIndex(startIdx.current);
        dragX.setValue(0);
        // The tile is now yours. Without this the pickup has no moment.
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      }, HOLD_MS);
    },
    onPanResponderMove: (_e, g) => {
      if (Math.abs(g.dx) > HOLD_SLOP || Math.abs(g.dy) > HOLD_SLOP) moved.current = true;
      const from = dragIndexRef.current;
      if (from == null) { if (moved.current) clearHold(); return; }

      // ⚠️ THE TILES NEVER REORDER MID-DRAG, and that is the whole point.
      //
      // The old version spliced the array on every crossing and re-rendered, so
      // the dragged tile's own slot kept moving underneath it and had to be
      // compensated for — a correction applied a render later than the finger.
      // That lag IS the unresponsiveness. Now the rendered order is frozen for
      // the length of the gesture: the dragged tile is pure finger delta with
      // nothing to correct, and the others spring aside around it.
      dragX.setValue(g.dx);

      const target = Math.max(0, Math.min(slidesRef.current.length - 1,
        Math.round((startX.current + g.dx - pitchRef.current / 2) / pitchRef.current)));
      if (target !== targetRef.current) {
        displace(from, target);
        targetRef.current = target;
        // A tick per swap — the feedback that tells you it took, without having
        // to look away from your finger.
        Haptics.selectionAsync().catch(() => {});
      }
    },
    onPanResponderRelease: (e) => {
      if (dragIndexRef.current == null) {
        clearHold();
        // A short press with no travel is a tap: select that tile.
        if (!moved.current) {
          const i = idxAtRef.current(e.nativeEvent.pageX);
          if (i !== indexRef.current) { commitRef.current(); setIndex(i); }
        }
        return;
      }
      endDrag();
    },
    onPanResponderTerminate: () => { endDrag(); },
  })).current;

  useEffect(() => () => clearHold(), []);

  const view = slides;
  const cur = view[Math.min(index, view.length - 1)];
  const curFit: SlideFit = cur?.fit ?? defaultFitFor(format);

  const setFit = (next: SlideFit) => {
    const i = indexRef.current;
    const list = slidesRef.current;
    if (!list[i] || list[i].type !== 'image') return;
    // Take the crop with us on the way out of Fill — switching to Fit and back
    // should return you to the framing you had, not to a reset one.
    if (curFit === 'cover' && next === 'contain') commitRef.current();
    const after = slidesRef.current.slice();
    after[i] = { ...after[i], fit: next };
    onChangeRef.current(after);
  };

  return (
    <View style={styles.root}>
      {/* The slide itself. Images get the same cropper the single-photo flow
          uses, keyed on uri so switching slides remounts it with that slide's
          own saved crop rather than carrying the last one over. */}
      <View style={[styles.stage, { width: frameW, height: frameH }]}>
        {cur && (cur.type === 'image' ? (
          curFit === 'contain' ? (
            // FITTED: there is nothing to crop, so no cropper. The whole photo
            // is shown inside the frame exactly as it will publish, blank space
            // and all — the point of this mode is that you can see what you are
            // keeping rather than what you are cutting.
            <ExpoImage
              source={{ uri: cur.uri }}
              style={StyleSheet.absoluteFill}
              contentFit="contain"
              cachePolicy="memory-disk"
            />
          ) : (
            <MediaCropper
              // Keyed on fit as well as uri: coming back from Fit has to rebuild
              // the cropper, or it would remount holding the previous slide's
              // transform.
              key={`${cur.uri}-cover`}
              ref={cropperRef}
              uri={cur.uri}
              mediaWidth={cur.width}
              mediaHeight={cur.height}
              frameW={frameW}
              frameH={frameH}
              type="image"
              initialCrop={cur.crop ?? null}
            />
          )
        ) : (
          // Video slides show their poster and are NOT croppable — the crop is
          // baked into a still at upload, and there is no equivalent for a clip.
          <View style={styles.videoStage}>
            <ExpoImage
              source={{ uri: cur.posterUri || cur.thumbnailUri || cur.uri }}
              style={StyleSheet.absoluteFill}
              contentFit="contain"
              cachePolicy="memory-disk"
            />
            <View style={styles.videoBadge}>
              <Ionicons name="videocam" size={13} color="#fff" />
              <Text style={styles.videoBadgeText}>{t('post.slideVideoNoCrop')}</Text>
            </View>
          </View>
        ))}
      </View>

      {/* The frame, for the whole set. It lives HERE rather than on the picker
          because this is the only screen where you can see what a frame does to
          every slide, instead of to whichever thumbnail the picker happened to
          be showing. */}
      <View style={styles.fmtRow}>
        {SLIDESHOW_FORMATS.map((f) => (
          <TouchableOpacity
            key={f}
            style={[styles.fmtBtn, format === f && styles.fmtBtnOn]}
            onPress={() => { commitRef.current(); onFormatChange(f); }}
            activeOpacity={0.85}
          >
            <Text style={[styles.fmtText, format === f && styles.fmtTextOn]} numberOfLines={1}>
              {isAutoFormat(f) ? t(`post.format.${f}`) : f}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Fill / Fit, per slide. Images only — a clip has no crop to bake. */}
      {cur?.type === 'image' && (
        <View style={styles.fitRow}>
          {(['cover', 'contain'] as const).map((f) => (
            <TouchableOpacity
              key={f}
              style={[styles.fitBtn, curFit === f && styles.fitBtnOn]}
              onPress={() => setFit(f)}
              activeOpacity={0.85}
            >
              <Ionicons
                name={f === 'cover' ? 'crop' : 'scan-outline'}
                size={14}
                color={curFit === f ? colors.background : colors.textSecondary}
              />
              <Text style={[styles.fitBtnText, curFit === f && styles.fitBtnTextOn]}>
                {t(f === 'cover' ? 'post.slideFill' : 'post.slideFit')}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <Text style={styles.hint}>
        {cur?.type !== 'image' ? t('post.slideOrderHint')
          : curFit === 'contain' ? t('post.slideFitHint')
            : t('post.slideCropHint')}
      </Text>

      {/* Filmstrip. Tap selects, press-and-hold picks up and drags. */}
      <View
        ref={stripRef}
        style={[styles.strip, { height: STRIP_H }]}
        // Width for sizing, window origin for hit-testing — re-measured on every
        // layout so a rotation or a slide being removed can't leave it stale.
        onLayout={(e) => { setStripW(e.nativeEvent.layout.width); measureStrip(); }}
        {...pan.panHandlers}
      >
        {view.map((s, i) => {
          const dragging = dragIndex === i;
          return (
            <Animated.View
              // Keyed on the URI ALONE, never the index. With the index in the
              // key, every reorder changed every key after the moved tile, so
              // React tore those tiles down and rebuilt them — the thumbnails
              // visibly reloaded mid-drag, which is most of what made the strip
              // feel broken.
              key={s.uri}
              style={[
                styles.tile,
                {
                  width: tile, height: tile,
                  marginRight: i === view.length - 1 ? 0 : TILE_GAP,
                  borderColor: i === index ? colors.text : 'transparent',
                },
                // Every tile carries its displacement spring; the dragged one
                // swaps that for the raw finger delta and lifts. Bigger,
                // shadowed and drawn over its neighbours — without that the only
                // thing that changed was which slot it sat in, which is what
                // read as static.
                dragging ? {
                  transform: [{ translateX: dragX }, { scale: 1.22 }],
                  zIndex: 5, elevation: 8,
                  shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 8, shadowOffset: { width: 0, height: 4 },
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

      {slides.length > 1 && (
        <TouchableOpacity style={styles.removeBtn} onPress={() => removeAt(index)} activeOpacity={0.8}>
          <Ionicons name="trash-outline" size={15} color={colors.textSecondary} />
          <Text style={styles.removeText}>{t('post.slideRemove')}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
});

export default SlideArranger;

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  root: { alignItems: 'center' },
  stage: { backgroundColor: '#000', overflow: 'hidden' },
  videoStage: { flex: 1, backgroundColor: '#000' },
  videoBadge: {
    position: 'absolute', left: SPACING.sm, bottom: SPACING.sm,
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: RADIUS.full,
    paddingVertical: 4, paddingHorizontal: 9,
  },
  videoBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  fmtRow: { flexDirection: 'row', gap: 6, marginTop: SPACING.sm, paddingHorizontal: SPACING.md },
  fmtBtn: {
    paddingVertical: 6, paddingHorizontal: SPACING.sm + 2,
    borderRadius: RADIUS.full, backgroundColor: c.surfaceLight,
    borderWidth: 1, borderColor: c.border,
  },
  fmtBtnOn: { backgroundColor: c.text, borderColor: c.text },
  fmtText: { color: c.textSecondary, fontSize: 12.5, fontWeight: '700' },
  fmtTextOn: { color: c.background, fontWeight: '800' },
  fitRow: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.sm },
  fitBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingVertical: 7, paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.full, backgroundColor: c.surfaceLight,
    borderWidth: 1, borderColor: c.border,
  },
  // Selected inverts rather than taking the accent — same rule as the rest of
  // the sweep: brand is for terminal actions, and this is a mode switch.
  fitBtnOn: { backgroundColor: c.text, borderColor: c.text },
  fitBtnText: { color: c.textSecondary, fontSize: 13, fontWeight: '700' },
  fitBtnTextOn: { color: c.background, fontWeight: '800' },
  hint: {
    color: c.textTertiary, fontSize: 12, fontWeight: '600',
    marginTop: SPACING.sm, marginBottom: SPACING.xs, paddingHorizontal: SPACING.md, textAlign: 'center',
  },
  strip: {
    flexDirection: 'row', alignItems: 'center',
    alignSelf: 'stretch', paddingHorizontal: STRIP_PAD,
  },
  tile: {
    borderRadius: RADIUS.sm, overflow: 'hidden', backgroundColor: c.surfaceLight,
    borderWidth: 2,
  },
  tileVideo: { position: 'absolute', top: 2, left: 2 },
  tileNum: {
    position: 'absolute', right: 2, bottom: 2,
    minWidth: 14, height: 14, borderRadius: 7, paddingHorizontal: 3,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.65)',
  },
  tileNumText: { color: '#fff', fontSize: 9, fontWeight: '800' },
  removeBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    marginTop: SPACING.sm, paddingVertical: 6, paddingHorizontal: SPACING.md,
  },
  removeText: { color: c.textSecondary, fontSize: 13, fontWeight: '700' },
});
