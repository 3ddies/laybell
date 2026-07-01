import { View, Animated, StyleSheet } from 'react-native';

// A rounded-rectangle progress ring that traces the border PERFECTLY (rounded
// corners included) without SVG: four straight edge segments grow via native
// scale, and four rounded corner arcs fade in as the fill reaches them. Colours
// step orange→yellow around the ring so it reads as a gradient as it fills. All
// animation is native-driver, so it stays smooth even while the JS thread encodes.
function lerp(t: number): string {
  const a = [242, 101, 34], b = [255, 214, 71]; // #F26522 → #FFD647
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

export default function GifProgressRing({
  progress, size, radius = 18, thickness = 4,
}: {
  progress: Animated.Value;
  size: number;
  radius?: number;
  thickness?: number;
}) {
  const R = Math.min(radius, size / 2);
  const BW = thickness;
  const straight = size - 2 * R;
  const cornerLen = (Math.PI * R) / 2;
  const P = 4 * straight + 4 * cornerLen;
  const s = straight / P;   // fraction per straight side
  const c = cornerLen / P;  // fraction per corner

  // Breakpoints clockwise, starting at the top-left corner.
  const p1 = c, p2 = p1 + s, p3 = p2 + c, p4 = p3 + s, p5 = p4 + c, p6 = p5 + s, p7 = p6 + c;
  const col = (i: number) => lerp(i / 7);

  const scale = (a: number, b: number) => progress.interpolate({ inputRange: [a, b], outputRange: [0.0001, 1], extrapolate: 'clamp' });
  const trans = (a: number, b: number, from: number) => progress.interpolate({ inputRange: [a, b], outputRange: [from, 0], extrapolate: 'clamp' });
  const fade = (a: number, b: number) => progress.interpolate({ inputRange: [a, b], outputRange: [0, 1], extrapolate: 'clamp' });

  const cornerBase = { position: 'absolute' as const, width: R, height: R };

  return (
    <>
      {/* Dim track (full rounded border) */}
      <View style={[StyleSheet.absoluteFill, { borderWidth: BW, borderRadius: R, borderColor: 'rgba(255,255,255,0.12)' }]} />

      {/* Top-left corner */}
      <Animated.View style={[cornerBase, { top: 0, left: 0, borderTopWidth: BW, borderLeftWidth: BW, borderTopLeftRadius: R, borderColor: col(0), opacity: fade(0, p1) }]} />
      {/* Top edge (grows left→right) */}
      <Animated.View style={{ position: 'absolute', top: 0, left: R, width: straight, height: BW, backgroundColor: col(1), transform: [{ translateX: trans(p1, p2, -straight / 2) }, { scaleX: scale(p1, p2) }] }} />
      {/* Top-right corner */}
      <Animated.View style={[cornerBase, { top: 0, right: 0, borderTopWidth: BW, borderRightWidth: BW, borderTopRightRadius: R, borderColor: col(2), opacity: fade(p2, p3) }]} />
      {/* Right edge (top→bottom) */}
      <Animated.View style={{ position: 'absolute', top: R, right: 0, width: BW, height: straight, backgroundColor: col(3), transform: [{ translateY: trans(p3, p4, -straight / 2) }, { scaleY: scale(p3, p4) }] }} />
      {/* Bottom-right corner */}
      <Animated.View style={[cornerBase, { bottom: 0, right: 0, borderBottomWidth: BW, borderRightWidth: BW, borderBottomRightRadius: R, borderColor: col(4), opacity: fade(p4, p5) }]} />
      {/* Bottom edge (right→left) */}
      <Animated.View style={{ position: 'absolute', bottom: 0, left: R, width: straight, height: BW, backgroundColor: col(5), transform: [{ translateX: trans(p5, p6, straight / 2) }, { scaleX: scale(p5, p6) }] }} />
      {/* Bottom-left corner */}
      <Animated.View style={[cornerBase, { bottom: 0, left: 0, borderBottomWidth: BW, borderLeftWidth: BW, borderBottomLeftRadius: R, borderColor: col(6), opacity: fade(p6, p7) }]} />
      {/* Left edge (bottom→top) */}
      <Animated.View style={{ position: 'absolute', top: R, left: 0, width: BW, height: straight, backgroundColor: col(7), transform: [{ translateY: trans(p7, 1, straight / 2) }, { scaleY: scale(p7, 1) }] }} />
    </>
  );
}
