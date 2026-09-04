import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
import { View, Animated, PanResponder, StyleSheet } from 'react-native';
import AppVideo from './AppVideo';
import { type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';

export type CropRect = { originX: number; originY: number; width: number; height: number };
export type MediaCropperHandle = { getCrop: () => CropRect | null };

type Props = {
  uri: string;
  mediaWidth: number;
  mediaHeight: number;
  frameW: number;
  frameH: number;
  type: 'image' | 'video';
  maxScale?: number;
  // Seed the pan/zoom so the cropper opens showing this exact crop (the inverse
  // of getCrop). Used when re-opening a resumed draft's image so its saved crop
  // is shown — and re-committed unchanged — instead of snapping back to center.
  initialCrop?: CropRect | null;
  /** false = render the crop but attach no gestures (a preview page). */
  interactive?: boolean;
  /**
   * Dim everything outside a circle inscribed in the frame. PURELY A GUIDE —
   * the crop this returns is still the square frame, because that is what an
   * avatar is: a square image every surface then displays in a circle. The mask
   * exists so the person can see which part survives that circle instead of
   * guessing from a square and being surprised by the corners.
   *
   * Expects a square frame; with a non-square one the circle inscribes the
   * shorter side and the guide stops matching what is saved.
   */
  circularMask?: boolean;
};

// Instagram-style cropper: the media is shown to COVER the frame and the user
// pans (1 finger) / pinches (2 fingers) to reposition & zoom. getCrop() converts
// the on-screen transform into a source-pixel crop rect for expo-image-manipulator.
const MediaCropper = forwardRef<MediaCropperHandle, Props>(function MediaCropper(
  { uri, mediaWidth, mediaHeight, frameW, frameH, type, maxScale = 6, initialCrop = null, interactive = true, circularMask = false }, ref,
) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const safeW = mediaWidth || frameW;
  const safeH = mediaHeight || frameH;
  const baseScale = Math.max(frameW / safeW, frameH / safeH); // cover
  const baseW = safeW * baseScale;
  const baseH = safeH * baseScale;

  // Initial transform — centered cover by default (scale 1, no offset), or the
  // inverse of `initialCrop` so a saved crop reopens exactly. Clamped the same
  // way apply() clamps. Computed once at mount (the cropper is keyed on uri, so
  // it remounts — and recomputes — when the media changes).
  const seed = useMemo(() => {
    if (type !== 'image' || !initialCrop || !(initialCrop.width > 1)) return { s: 1, tx: 0, ty: 0 };
    const s = Math.min(Math.max(frameW / (baseScale * initialCrop.width), 1), maxScale);
    const f = baseScale * s;
    const maxTx = Math.max(0, (baseW * s - frameW) / 2);
    const maxTy = Math.max(0, (baseH * s - frameH) / 2);
    const txv = Math.min(Math.max(baseW * s / 2 - frameW / 2 - initialCrop.originX * f, -maxTx), maxTx);
    const tyv = Math.min(Math.max(baseH * s / 2 - frameH / 2 - initialCrop.originY * f, -maxTy), maxTy);
    return { s, tx: txv, ty: tyv };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live numeric transform (read by getCrop) + animated mirrors (drive rendering
  // without re-rendering on every gesture frame).
  const scale = useRef(seed.s);
  const tx = useRef(seed.tx);
  const ty = useRef(seed.ty);
  const aScale = useRef(new Animated.Value(seed.s)).current;
  const aTx = useRef(new Animated.Value(seed.tx)).current;
  const aTy = useRef(new Animated.Value(seed.ty)).current;

  // ONE gesture baseline, re-seeded whenever the finger COUNT changes.
  //
  // This used to be two independent `active` flags, one for pan and one for
  // pinch, each cleared only in onPanResponderRelease/Terminate. When those did
  // not fire — a terminated responder, or a second pinch starting while the flag
  // was still set — the next pinch took the "already active" branch and scaled
  // against the PREVIOUS gesture's startDist and startScale. That is why zoom
  // worked once and then jumped: the baseline was stale, not the maths.
  //
  // Keying off the touch count removes the failure mode instead of patching it.
  // Every 1↔2 finger transition re-baselines from the CURRENT transform, so
  // adding or lifting a finger can never jump and can never leave a stale
  // baseline behind — including the very common case of one finger leaving a
  // pinch fractionally before the other.
  const gesture = useRef({ count: 0, dist: 1, scale: 1, cx: 0, cy: 0, tx: 0, ty: 0 });

  const apply = (nextScale: number, nextTx: number, nextTy: number) => {
    const s = Math.min(Math.max(nextScale, 1), maxScale);
    const maxTx = Math.max(0, (baseW * s - frameW) / 2);
    const maxTy = Math.max(0, (baseH * s - frameH) / 2);
    const cx = Math.min(Math.max(nextTx, -maxTx), maxTx);
    const cy = Math.min(Math.max(nextTy, -maxTy), maxTy);
    scale.current = s; tx.current = cx; ty.current = cy;
    aScale.setValue(s); aTx.setValue(cx); aTy.setValue(cy);
  };

  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    // Never hand the gesture away mid-pinch. A stolen responder skips
    // onPanResponderRelease, which is precisely how the old baseline went stale.
    onPanResponderTerminationRequest: () => false,
    // count 0 forces the next move to seed, so a new touch can never inherit
    // anything from the last one.
    onPanResponderGrant: () => { gesture.current.count = 0; },
    onPanResponderMove: (evt) => {
      const touches = evt.nativeEvent.touches;
      const n = touches.length;
      if (n === 0) return;

      // Two fingers track their midpoint and separation; one finger tracks
      // itself and holds the scale. Using the centroid for both means the pan
      // maths is identical either way, so a finger arriving or leaving changes
      // the baseline and nothing else.
      const two = n >= 2;
      const cx = two ? (touches[0].pageX + touches[1].pageX) / 2 : touches[0].pageX;
      const cy = two ? (touches[0].pageY + touches[1].pageY) / 2 : touches[0].pageY;
      const dist = two
        ? (Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY) || 1)
        : 1;

      if (n !== gesture.current.count) {
        gesture.current = { count: n, dist, scale: scale.current, cx, cy, tx: tx.current, ty: ty.current };
        return;
      }

      const g = gesture.current;
      apply(
        two ? g.scale * (dist / g.dist) : scale.current,
        g.tx + (cx - g.cx),
        g.ty + (cy - g.cy),
      );
    },
    onPanResponderRelease: () => { gesture.current.count = 0; },
    onPanResponderTerminate: () => { gesture.current.count = 0; },
  }), [baseW, baseH, frameW, frameH, maxScale]);

  useImperativeHandle(ref, () => ({
    getCrop: () => {
      if (type !== 'image') return null;
      const s = scale.current;
      const f = baseScale * s; // displayed px per source px
      const cropW = frameW / f;
      const cropH = frameH / f;
      const originX = (baseW * s / 2 - frameW / 2 - tx.current) / f;
      const originY = (baseH * s / 2 - frameH / 2 - ty.current) / f;
      const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), Math.max(0, max));
      return {
        originX: Math.round(clamp(originX, safeW - cropW)),
        originY: Math.round(clamp(originY, safeH - cropH)),
        width: Math.round(Math.min(cropW, safeW)),
        height: Math.round(Math.min(cropH, safeH)),
      };
    },
  }), [type, baseScale, baseW, baseH, frameW, frameH, safeW, safeH]);

  return (
    <View
      style={[styles.frame, { width: frameW, height: frameH }]}
      // Non-interactive instances still SEED from initialCrop, so they render the
      // saved crop faithfully — they just attach no gestures. That is what lets a
      // pager show each slide exactly as it will publish without its pages
      // fighting the swipe for the same one-finger drag.
      {...(interactive && type === 'image' ? responder.panHandlers : {})}
    >
      {type === 'video' ? (
        <AppVideo
          source={{ uri }}
          style={{ width: frameW, height: frameH }}
          contentFit="cover"
          loop
          active
          muted
        />
      ) : (
        <Animated.Image
          source={{ uri }}
          resizeMode="cover"
          style={{
            position: 'absolute',
            width: baseW,
            height: baseH,
            left: (frameW - baseW) / 2,
            top: (frameH - baseH) / 2,
            transform: [{ translateX: aTx }, { translateY: aTy }, { scale: aScale }],
          }}
        />
      )}

      {/* Circular guide. React Native has no mask, so this is the donut trick: a
          view three frames wide with a border one frame thick leaves a
          transparent hole of exactly one frame across (3F − 2F = F), rounded
          into a circle and centred on the frame. The parent clips the overflow.
          Cheaper and sharper than pulling in SVG for one shape, and it costs
          nothing when circularMask is off. */}
      {circularMask && (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <View
            style={[
              styles.mask,
              {
                left: -frameW,
                top: (frameH - frameW) / 2 - frameW,
                width: frameW * 3,
                height: frameW * 3,
                borderRadius: (frameW * 3) / 2,
                borderWidth: frameW,
              },
            ]}
          />
        </View>
      )}
    </View>
  );
});

export default MediaCropper;

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  frame: { overflow: 'hidden', backgroundColor: colors.background, alignSelf: 'center' },
  // Dim, not black: the corners still need to be readable enough to judge what
  // is being cut, and a hard blackout makes the crop feel like a decision
  // already made rather than one being taken.
  mask: { position: 'absolute', borderColor: 'rgba(0,0,0,0.55)' },
});
