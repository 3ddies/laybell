import { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import {
  asLegacyBandCaption, captionZone, MIN_ZONE,
  type CaptionZoneKind, type LegacyBandCaption,
} from '../lib/bandCaptions';

// The TikTok-style BAND BUBBLE: bold centred text where EVERY LINE gets its own
// rounded pill, stacked and slightly fused. It is how a horizontal video carried
// captions in its letterbox bands before 1.0.3 (posts.top_caption /
// bottom_caption), and a vertical clip's single screen caption before
// multi-captions.
//
// Since 1.0.3 the video studio places a horizontal video's captions like a vertical
// one's (lib/bandCaptions, components/BandStickers), and publishing still writes
// these bubbles for apps before it. This file draws them for posts that have
// nothing newer. The zone geometry lives in lib/bandCaptions, shared with both.

export type TopCaptionData = LegacyBandCaption;

/** Loose runtime guard for the jsonb read back off a post row. */
export const asTopCaption = asLegacyBandCaption;

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
 * Viewer-side placement: absolutely positioned in its zone at the stored y
 * (0 = zone top, 1 = resting at the zone's bottom). The bubble's height is only
 * known after layout, so it mounts invisible for one frame, measures, then
 * appears at the exact spot — no jump.
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
  if (zone.usable < MIN_ZONE) return null;
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
