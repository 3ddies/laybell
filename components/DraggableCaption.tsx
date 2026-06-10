import { useRef } from 'react';
import { Animated, PanResponder, StyleSheet, Text, View } from 'react-native';

// A draggable / pinch-resizable / rotatable text sticker for the story editor
// (TikTok / Instagram style). One finger drags; two fingers pinch-scale + rotate.
// Reports a NORMALIZED transform on release so the viewer can re-place it on any
// screen: { x, y } = the text CENTER as 0..1 of the frame, scale, rotation(deg).

export type CaptionStyle = { x: number; y: number; scale: number; rotation: number };

export const DEFAULT_CAPTION_STYLE: CaptionStyle = { x: 0.5, y: 0.5, scale: 1, rotation: 0 };

// Shared text styling so the editor sticker and the viewer render identically.
export const captionStickerTextStyle = {
  color: '#fff',
  fontSize: 26,
  fontWeight: '700' as const,
  textAlign: 'center' as const,
  maxWidth: 320,
  paddingHorizontal: 10,
  paddingVertical: 4,
  textShadowColor: 'rgba(0,0,0,0.6)',
  textShadowRadius: 6,
  textShadowOffset: { width: 0, height: 1 },
};

export default function DraggableCaption({
  text, frameW, frameH, initial, onChange,
}: {
  text: string;
  frameW: number;
  frameH: number;
  initial: CaptionStyle;
  onChange: (s: CaptionStyle) => void;
}) {
  // pan holds the pixel offset from the frame CENTER (the container centers us).
  const pan = useRef(new Animated.ValueXY({ x: (initial.x - 0.5) * frameW, y: (initial.y - 0.5) * frameH })).current;
  const scale = useRef(new Animated.Value(initial.scale)).current;
  const rot = useRef(new Animated.Value(initial.rotation)).current;
  const cur = useRef({ x: (initial.x - 0.5) * frameW, y: (initial.y - 0.5) * frameH, scale: initial.scale, rotation: initial.rotation });
  const g0 = useRef({ x: 0, y: 0, scale: 1, rotation: 0, dist: 0, angle: 0 });

  const responder = useRef(
    PanResponder.create({
      // A tap shouldn't grab the responder (lets the controls underneath work);
      // only an actual drag/pinch does.
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 3 || Math.abs(g.dy) > 3,
      onPanResponderGrant: () => {
        g0.current = { x: cur.current.x, y: cur.current.y, scale: cur.current.scale, rotation: cur.current.rotation, dist: 0, angle: 0 };
      },
      onPanResponderMove: (e, g) => {
        const t = e.nativeEvent.touches;
        if (t.length >= 2) {
          const dx = t[1].pageX - t[0].pageX;
          const dy = t[1].pageY - t[0].pageY;
          const dist = Math.hypot(dx, dy);
          const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
          if (g0.current.dist === 0) { g0.current.dist = dist; g0.current.angle = angle; }
          const s = Math.max(0.5, Math.min(4, g0.current.scale * (dist / (g0.current.dist || dist))));
          const r = g0.current.rotation + (angle - g0.current.angle);
          scale.setValue(s); rot.setValue(r);
          cur.current.scale = s; cur.current.rotation = r;
        } else {
          const nx = g0.current.x + g.dx;
          const ny = g0.current.y + g.dy;
          pan.setValue({ x: nx, y: ny });
          cur.current.x = nx; cur.current.y = ny;
        }
      },
      onPanResponderRelease: () => {
        onChange({
          x: cur.current.x / frameW + 0.5,
          y: cur.current.y / frameH + 0.5,
          scale: cur.current.scale,
          rotation: cur.current.rotation,
        });
      },
    }),
  ).current;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <View style={styles.center} pointerEvents="box-none">
        <Animated.View
          {...responder.panHandlers}
          style={{
            transform: [
              { translateX: pan.x },
              { translateY: pan.y },
              { scale },
              { rotate: rot.interpolate({ inputRange: [-360, 360], outputRange: ['-360deg', '360deg'] }) },
            ],
          }}
        >
          <Text style={captionStickerTextStyle}>{text}</Text>
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
