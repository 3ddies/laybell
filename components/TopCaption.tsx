import { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';

// The TikTok-style TOP CAPTION for horizontal videos: bold centered text where
// EVERY LINE gets its own rounded bubble, stacked and slightly fused — placed
// in the black letterbox band above a landscape clip watched upright.
//
// This file owns the three things that must agree everywhere:
//   * TopCaptionData — the jsonb shape stored on posts.top_caption
//   * topCaptionZone — the band geometry (identical in editor and viewer, so
//     what the creator places is exactly what viewers see, and the caption can
//     never collide with the RotateHint pill parked at band - 52)
//   * <TopCaptionBubble> — the render (editor preview, live viewer)

export type TopCaptionData = {
  text: string;
  bg: string;      // bubble color
  color: string;   // text color
  y: number;       // 0..1 — position within the safe zone (0 top, 1 just above the rotate hint)
  scale: number;   // pinch size multiplier
};

export const TOP_CAPTION_SCALE_MIN = 0.5;
export const TOP_CAPTION_SCALE_MAX = 2.5;

/** Bubble/text color pairs the creator can pick from (bg, text). */
export const TOP_CAPTION_COLORS: Array<{ bg: string; color: string }> = [
  { bg: '#FFFFFF', color: '#111111' },
  { bg: '#111111', color: '#FFFFFF' },
  { bg: '#F26522', color: '#FFFFFF' },
  { bg: '#FAB525', color: '#111111' },
  { bg: '#F43F5E', color: '#FFFFFF' },
  { bg: '#0EA5E9', color: '#FFFFFF' },
  { bg: '#22C55E', color: '#FFFFFF' },
  { bg: '#A855F7', color: '#FFFFFF' },
];

/** Loose runtime guard for the jsonb read back off a post row. */
export function asTopCaption(v: unknown): TopCaptionData | null {
  const d = v as TopCaptionData | null;
  if (!d || typeof d !== 'object' || typeof d.text !== 'string' || !d.text.trim()) return null;
  return {
    text: d.text,
    bg: typeof d.bg === 'string' ? d.bg : '#FFFFFF',
    color: typeof d.color === 'string' ? d.color : '#111111',
    y: typeof d.y === 'number' ? Math.min(1, Math.max(0, d.y)) : 0.35,
    scale: typeof d.scale === 'number'
      ? Math.min(TOP_CAPTION_SCALE_MAX, Math.max(TOP_CAPTION_SCALE_MIN, d.scale))
      : 1,
  };
}

export type CaptionZoneKind = 'top' | 'bottom' | 'screen';

/**
 * Where a caption may live, per zone kind:
 *  - 'top':    (landscape clips) the top letterbox band — below the back
 *    button, ABOVE the RotateHint (parked at band - 52).
 *  - 'bottom': (landscape clips) the bottom band — just under the video,
 *    ABOVE the reel's bottom UI: the meta block (username + caption + song
 *    card, metaBottom insets+24, ~170 tall) and the scrub bar own the last
 *    ~240px of the screen.
 *  - 'screen': (VERTICAL clips, which fill the screen edge-to-edge) anywhere
 *    over the video between those same two protected strips.
 */
export function captionZone(kind: CaptionZoneKind, ratio: number, screenW: number, screenH: number) {
  const videoH = screenW / ratio;
  const band = Math.max(0, (screenH - videoH) / 2);
  if (kind === 'top') {
    const top = 74;               // clear of the status bar + floating back button
    const bottom = band - 52 - 10; // the RotateHint pill sits at band - 52
    return { band, videoH, top, bottom, usable: Math.max(0, bottom - top) };
  }
  if (kind === 'screen') {
    const top = 74;
    const bottom = screenH - 240;
    return { band, videoH, top, bottom, usable: Math.max(0, bottom - top) };
  }
  const top = band + videoH + 8;
  const bottom = screenH - 240;
  return { band, videoH, top, bottom, usable: Math.max(0, bottom - top) };
}

/**
 * Bubble width cap per zone. Everywhere the caption can share the screen with
 * the action rail hugging the right edge ('bottom' bands and full-'screen'
 * placement), it stays narrower — centered at 66% it can never reach the
 * rail's column no matter its vertical position. Only the top band (which the
 * rail never reaches) gets the wide cap.
 */
export function captionMaxWidth(kind: CaptionZoneKind, screenW: number): number {
  return screenW * (kind === 'top' ? 0.86 : 0.66);
}

/** Back-compat alias for the original top-zone call sites. */
export function topCaptionZone(ratio: number, screenW: number, screenH: number) {
  return captionZone('top', ratio, screenW, screenH);
}

/** Per-line pill bubble. Sized by `scale`; every metric scales together so the
    pinch feels like scaling one object. */
export function TopCaptionBubble({ data, maxWidth }: { data: TopCaptionData; maxWidth: number }) {
  const fontSize = Math.round(17 * data.scale);
  const pad = Math.round(11 * data.scale);
  const radius = Math.round(11 * data.scale);
  const lines = data.text.split('\n').map((l) => l.trim()).filter(Boolean);
  return (
    <View style={[styles.stack, { maxWidth }]}>
      {lines.map((line, i) => (
        <View
          key={i}
          style={{
            backgroundColor: data.bg,
            borderRadius: radius,
            paddingHorizontal: pad,
            paddingVertical: Math.round(4 * data.scale),
            // Fuse adjacent pills a touch, like the reference style.
            marginTop: i === 0 ? 0 : Math.round(-2 * data.scale),
          }}
        >
          <Text
            style={{
              color: data.color,
              fontSize,
              lineHeight: Math.round(fontSize * 1.3),
              fontWeight: '800',
              textAlign: 'center',
            }}
          >
            {line}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * Viewer-side placement: absolutely positioned in the top letterbox band at the
 * stored y (0 = zone top, 1 = resting just above the rotate hint). The bubble's
 * height is only known after layout, so it mounts invisible for one frame,
 * measures, then appears at the exact spot — no jump.
 */
export function PositionedTopCaption({ data, ratio, screenW, screenH, zone: zoneKind = 'top' }: {
  data: TopCaptionData;
  ratio: number;
  screenW: number;
  screenH: number;
  zone?: CaptionZoneKind;
}) {
  const [h, setH] = useState(0);
  const zone = captionZone(zoneKind, ratio, screenW, screenH);
  // Too little black to work with (short bands can't clear the rotate hint).
  if (zone.usable < 34) return null;
  const travel = Math.max(0, zone.usable - h);
  const top = zone.top + data.y * travel;
  return (
    <View
      pointerEvents="none"
      style={[styles.positioned, { top, opacity: h > 0 ? 1 : 0 }]}
      onLayout={(e) => setH(e.nativeEvent.layout.height)}
    >
      <TopCaptionBubble data={data} maxWidth={captionMaxWidth(zoneKind, screenW)} />
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { alignItems: 'center' },
  positioned: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
});
