import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, PanResponder, Animated } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import MediaCropper, { type MediaCropperHandle, type CropRect } from './MediaCropper';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
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
// How long a press has to be held before it becomes a drag. Below this it is a
// tap that selects the slide.
const HOLD_MS = 220;
// Movement that cancels the pending hold. A finger that travels before the timer
// fires was never trying to pick the tile up.
const HOLD_SLOP = 10;

const SlideArranger = forwardRef<SlideArrangerHandle, {
  slides: ArrangerSlide[];
  frameW: number;
  frameH: number;
  onChange: (next: ArrangerSlide[]) => void;
}>(function SlideArranger({ slides, frameW, frameH, onChange }, ref) {
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
  const dragX = useRef(new Animated.Value(0)).current;
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startIdx = useRef(0);
  const startX = useRef(0);
  // Total distance the dragged tile's SLOT has travelled from live reordering.
  const rebase = useRef(0);
  const moved = useRef(false);

  const clearHold = () => { if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; } };
  const endDrag = () => {
    clearHold();
    dragIndexRef.current = null;
    setDragIndex(null);
    rebase.current = 0;
    dragX.setValue(0);
  };

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => dragIndexRef.current == null,
    onPanResponderGrant: (e) => {
      // locationX is measured from the strip's own left edge, padding included,
      // so the padding has to come off before it means anything in tile terms.
      const x = e.nativeEvent.locationX - STRIP_PAD;
      startX.current = x;
      rebase.current = 0;
      moved.current = false;
      startIdx.current = Math.max(0, Math.min(slidesRef.current.length - 1, Math.floor(x / pitchRef.current)));
      clearHold();
      holdTimer.current = setTimeout(() => {
        dragIndexRef.current = startIdx.current;
        setDragIndex(startIdx.current);
        dragX.setValue(0);
        // Picking a tile up also selects it — you are about to move the thing
        // you are looking at, which is what makes the reorder legible.
        if (startIdx.current !== indexRef.current) { commitRef.current(); setIndex(startIdx.current); }
      }, HOLD_MS);
    },
    onPanResponderMove: (_e, g) => {
      if (Math.abs(g.dx) > HOLD_SLOP || Math.abs(g.dy) > HOLD_SLOP) moved.current = true;
      const di = dragIndexRef.current;
      if (di == null) { if (moved.current) clearHold(); return; }

      // The tile follows the finger MINUS however far its own slot has already
      // slid out from under it. Every live reorder moves the slot by a whole
      // tile, so without subtracting that the tile would jump a tile-width on
      // each swap — it would track the finger only until the first one.
      dragX.setValue(g.dx - rebase.current);

      // Reorder as the finger crosses into another slot.
      const fingerX = startX.current + g.dx;
      const target = Math.max(0, Math.min(slidesRef.current.length - 1,
        Math.floor(fingerX / pitchRef.current)));
      if (target !== di) {
        const list = slidesRef.current.slice();
        const [item] = list.splice(di, 1);
        list.splice(target, 0, item);
        onChangeRef.current(list);
        rebase.current += (target - di) * pitchRef.current;
        dragIndexRef.current = target;
        setDragIndex(target);
        setIndex(target);
        dragX.setValue(g.dx - rebase.current);
      }
    },
    onPanResponderRelease: (e) => {
      if (dragIndexRef.current == null) {
        clearHold();
        // A short press with no travel is a tap: select that tile.
        if (!moved.current) {
          const i = Math.max(0, Math.min(slidesRef.current.length - 1,
            Math.floor((e.nativeEvent.locationX - STRIP_PAD) / pitchRef.current)));
          if (i !== indexRef.current) { commitRef.current(); setIndex(i); }
        }
        return;
      }
      endDrag();
    },
    onPanResponderTerminate: () => { endDrag(); },
  })).current;

  useEffect(() => () => clearHold(), []);

  const cur = slides[Math.min(index, slides.length - 1)];

  return (
    <View style={styles.root}>
      {/* The slide itself. Images get the same cropper the single-photo flow
          uses, keyed on uri so switching slides remounts it with that slide's
          own saved crop rather than carrying the last one over. */}
      <View style={[styles.stage, { width: frameW, height: frameH }]}>
        {cur && (cur.type === 'image' ? (
          <MediaCropper
            key={cur.uri}
            ref={cropperRef}
            uri={cur.uri}
            mediaWidth={cur.width}
            mediaHeight={cur.height}
            frameW={frameW}
            frameH={frameH}
            type="image"
            initialCrop={cur.crop ?? null}
          />
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

      <Text style={styles.hint}>
        {cur?.type === 'image' ? t('post.slideCropHint') : t('post.slideOrderHint')}
      </Text>

      {/* Filmstrip. Tap selects, press-and-hold picks up and drags. */}
      <View
        style={[styles.strip, { height: STRIP_H }]}
        onLayout={(e) => setStripW(e.nativeEvent.layout.width)}
        {...pan.panHandlers}
      >
        {slides.map((s, i) => {
          const dragging = dragIndex === i;
          return (
            <Animated.View
              key={`${s.uri}-${i}`}
              style={[
                styles.tile,
                {
                  width: tile, height: tile,
                  marginRight: i === slides.length - 1 ? 0 : TILE_GAP,
                  borderColor: i === index ? colors.text : 'transparent',
                },
                dragging && {
                  transform: [{ translateX: dragX }, { scale: 1.12 }],
                  zIndex: 5, elevation: 5,
                },
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
