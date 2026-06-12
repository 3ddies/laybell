import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
import { View, Animated, PanResponder, StyleSheet } from 'react-native';
import { Video, ResizeMode } from 'expo-av';
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
};

// Instagram-style cropper: the media is shown to COVER the frame and the user
// pans (1 finger) / pinches (2 fingers) to reposition & zoom. getCrop() converts
// the on-screen transform into a source-pixel crop rect for expo-image-manipulator.
const MediaCropper = forwardRef<MediaCropperHandle, Props>(function MediaCropper(
  { uri, mediaWidth, mediaHeight, frameW, frameH, type, maxScale = 6 }, ref,
) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const safeW = mediaWidth || frameW;
  const safeH = mediaHeight || frameH;
  const baseScale = Math.max(frameW / safeW, frameH / safeH); // cover
  const baseW = safeW * baseScale;
  const baseH = safeH * baseScale;

  // Live numeric transform (read by getCrop) + animated mirrors (drive rendering
  // without re-rendering on every gesture frame).
  const scale = useRef(1);
  const tx = useRef(0);
  const ty = useRef(0);
  const aScale = useRef(new Animated.Value(1)).current;
  const aTx = useRef(new Animated.Value(0)).current;
  const aTy = useRef(new Animated.Value(0)).current;

  const pan = useRef({ active: false, startX: 0, startY: 0, startTx: 0, startTy: 0 });
  const pinch = useRef({ active: false, startDist: 1, startScale: 1, startCx: 0, startCy: 0, startTx: 0, startTy: 0 });

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
    onPanResponderMove: (evt) => {
      const touches = evt.nativeEvent.touches;
      if (touches.length >= 2) {
        const [a, b] = touches;
        const dist = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) || 1;
        const cx = (a.pageX + b.pageX) / 2;
        const cy = (a.pageY + b.pageY) / 2;
        if (!pinch.current.active) {
          pinch.current = { active: true, startDist: dist, startScale: scale.current, startCx: cx, startCy: cy, startTx: tx.current, startTy: ty.current };
          pan.current.active = false;
        } else {
          apply(
            pinch.current.startScale * (dist / pinch.current.startDist),
            pinch.current.startTx + (cx - pinch.current.startCx),
            pinch.current.startTy + (cy - pinch.current.startCy),
          );
        }
      } else if (touches.length === 1) {
        const t = touches[0];
        if (!pan.current.active) {
          pan.current = { active: true, startX: t.pageX, startY: t.pageY, startTx: tx.current, startTy: ty.current };
          pinch.current.active = false;
        } else {
          apply(scale.current, pan.current.startTx + (t.pageX - pan.current.startX), pan.current.startTy + (t.pageY - pan.current.startY));
        }
      }
    },
    onPanResponderRelease: () => { pan.current.active = false; pinch.current.active = false; },
    onPanResponderTerminate: () => { pan.current.active = false; pinch.current.active = false; },
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
      {...(type === 'image' ? responder.panHandlers : {})}
    >
      {type === 'video' ? (
        <Video
          source={{ uri }}
          style={{ width: frameW, height: frameH }}
          resizeMode={ResizeMode.COVER}
          isLooping
          shouldPlay
          isMuted
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
    </View>
  );
});

export default MediaCropper;

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  frame: { overflow: 'hidden', backgroundColor: '#000', alignSelf: 'center' },
});
