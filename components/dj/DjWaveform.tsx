import { memo, useMemo } from 'react';
import { Canvas, Path, Group, Rect, Skia, rect } from '@shopify/react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';

// Static peak bars drawn once; the playhead + played-region are driven by a
// Reanimated shared value, so the deck can scrub it at 60fps without re-rendering
// React. Peaks come from DjEngine's deck.peaks().
type Props = {
  peaks: Float32Array | null;
  progress: SharedValue<number>; // 0..1 playhead
  width: number;
  height: number;
  color?: string;    // played
  dimColor?: string; // not yet played
  loop?: { start: number; end: number } | null; // fractions 0..1
};

export default memo(function DjWaveform({
  peaks, progress, width, height, color = '#F26522', dimColor = '#3A3A41', loop,
}: Props) {
  const path = useMemo(() => {
    const p = Skia.Path.Make();
    if (!peaks || width <= 0 || peaks.length === 0) return p;
    const n = peaks.length;
    const barW = width / n;
    const mid = height / 2;
    for (let i = 0; i < n; i++) {
      const h = Math.max(1, peaks[i] * height);
      p.addRect(Skia.XYWHRect(i * barW, mid - h / 2, Math.max(0.5, barW - 0.5), h));
    }
    return p;
  }, [peaks, width, height]);

  const clip = useDerivedValue(() => rect(0, 0, progress.value * width, height));
  const headX = useDerivedValue(() => progress.value * width - 1);

  return (
    <Canvas style={{ width, height }}>
      <Path path={path} color={dimColor} />
      <Group clip={clip}>
        <Path path={path} color={color} />
      </Group>
      {!!loop && (
        <Rect
          x={loop.start * width}
          y={0}
          width={Math.max(2, (loop.end - loop.start) * width)}
          height={height}
          color={color}
          opacity={0.16}
        />
      )}
      <Rect x={headX} y={0} width={2} height={height} color="#FFFFFF" />
    </Canvas>
  );
});
