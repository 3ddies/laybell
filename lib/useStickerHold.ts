import { useCallback, useRef } from 'react';
import type { GestureResponderEvent, LayoutChangeEvent } from 'react-native';
import { useStickerCapture } from '../contexts/StickerCaptureContext';

// Press-and-hold an image → lift the subject UNDER the finger into a sticker
// (Threads-style). Spread the returned handlers onto the Touchable that wraps a
// single image; it tracks the touch point (normalized 0..1) via onLayout + onPressIn
// so different areas of the photo give different cutouts.
//
//   const hold = useStickerHold(coverUrl);
//   <TouchableOpacity onLayout={hold.onLayout} onPressIn={hold.onPressIn}
//     onLongPress={hold.onLongPress} delayLongPress={hold.delayLongPress}>…</TouchableOpacity>
//
// `enabled` is false when the build/device can't lift or there's no uri — gate the
// onLongPress on it so a plain tap still behaves normally where it isn't supported.
export function useStickerHold(uri: string | null | undefined) {
  const { capture, available } = useStickerCapture();
  const size = useRef({ w: 0, h: 0 });
  const pt = useRef({ x: 0.5, y: 0.5 });

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    size.current = { w: width, h: height };
  }, []);

  const onPressIn = useCallback((e: GestureResponderEvent) => {
    const { locationX, locationY } = e.nativeEvent;
    const { w, h } = size.current;
    pt.current = {
      x: w > 0 ? Math.min(1, Math.max(0, locationX / w)) : 0.5,
      y: h > 0 ? Math.min(1, Math.max(0, locationY / h)) : 0.5,
    };
  }, []);

  const onLongPress = useCallback(() => {
    if (uri) capture(uri, pt.current);
  }, [uri, capture]);

  return { enabled: available && !!uri, onLayout, onPressIn, onLongPress, delayLongPress: 350 as const };
}
