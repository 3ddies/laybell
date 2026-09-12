import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { StickerContent, type Sticker } from './StickerLayer';
import { captionZone, fitInZone, MIN_ZONE, type Band, type CaptionZone } from '../lib/bandCaptions';

// A horizontal video's captions in its letterbox bands (lib/bandCaptions): the
// upright reel's bands by default, or a saved video's upright frame
// (components/CaptionCaptureHost). Each one is measured before it shows, then kept
// whole inside its band — moved in from the edges, shrunk if it doesn't fit — by the
// same rule the studio placed it with. So it lands where it was put, and never on
// the picture, whatever the phone.

export default function PlacedBandStickers({ stickers, ratio, screenW, screenH, zoneOf, onLaidOut }: {
  stickers: Sticker[];
  /** The clip's width over height (above 1). */
  ratio: number;
  screenW: number;
  screenH: number;
  /** The zone a band's captions fit into — the upright reel's unless given. */
  zoneOf?: (band: Band) => CaptionZone;
  /** Every caption shown has been measured and placed: a saved video's image is drawn then. */
  onLaidOut?: () => void;
}) {
  const zone = (band: Band) => (zoneOf ? zoneOf(band) : captionZone(band, ratio, screenW, screenH));
  // A band with too little black on this screen shows none of its captions.
  const shown = stickers.filter((s): s is Sticker & { band: Band } => !!s.text && !!s.band && zone(s.band).usable >= MIN_ZONE);
  const keys = shown.map((s, i) => s.id ?? `band-${i}`);

  const measured = useRef(new Set<string>());
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const onLaidOutRef = useRef(onLaidOut);
  onLaidOutRef.current = onLaidOut;
  const report = useCallback((key: string) => {
    measured.current.add(key);
    if (keysRef.current.every((k) => measured.current.has(k))) onLaidOutRef.current?.();
  }, []);
  // Nothing to place is laid out already.
  useEffect(() => {
    if (!keys.length) onLaidOutRef.current?.();
  }, [keys.length]);

  if (!shown.length) return null;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {shown.map((s, i) => (
        <BandSticker
          key={keys[i]}
          sticker={s}
          zone={zone(s.band)}
          screenW={screenW}
          screenH={screenH}
          onMeasured={() => report(keys[i])}
        />
      ))}
    </View>
  );
}

function BandSticker({ sticker, zone, screenW, screenH, onMeasured }: {
  sticker: Sticker;
  zone: CaptionZone;
  screenW: number;
  screenH: number;
  onMeasured: () => void;
}) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const onMeasuredRef = useRef(onMeasured);
  onMeasuredRef.current = onMeasured;
  // Reported after the render that places it has committed, so an image drawn
  // next shows it in place.
  useEffect(() => {
    if (size) onMeasuredRef.current();
  }, [size]);

  const y = Number.isFinite(sticker.y) ? Math.min(1, Math.max(0, sticker.y)) : 0.5;
  const placed = fitInZone(
    {
      cx: (Number.isFinite(sticker.x) ? sticker.x : 0.5) * screenW,
      cy: zone.top + y * zone.usable,
      w: size?.w ?? 0,
      h: size?.h ?? 0,
      scale: sticker.scale ?? 1,
      rotation: sticker.rotation ?? 0,
    },
    zone,
    screenW,
  );
  return (
    <View style={[StyleSheet.absoluteFill, styles.center]}>
      <View
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          setSize((cur) => (cur && Math.abs(cur.w - width) < 0.5 && Math.abs(cur.h - height) < 0.5 ? cur : { w: width, h: height }));
        }}
        style={{
          // Hidden for the one frame before it's measured, so it never jumps.
          opacity: size ? 1 : 0,
          transform: [
            { translateX: placed.cx - screenW / 2 },
            { translateY: placed.cy - screenH / 2 },
            { scale: placed.scale },
            { rotate: `${sticker.rotation ?? 0}deg` },
          ],
        }}
      >
        <StickerContent sticker={sticker} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
});
