import { StyleSheet } from 'react-native';
import { Canvas, Group, Image, ColorMatrix, Fill, useVideo } from '@shopify/react-native-skia';
import { skiaColorMatrix, type FilterKey } from '../lib/filters';

// A captured VIDEO shown with a colour filter applied LIVE in the editor: expo-video can't
// recolour a playing clip, but Skia can decode the FILE and draw each frame through the
// filter's colour matrix — the same matrix the photo filters and the native video export use,
// so the preview matches the shared result. Only mounted while a non-'original' filter is
// selected; 'original' keeps the normal <AppVideo>.
export default function FilteredVideoPreview({
  uri, filterKey, width, height,
}: {
  uri: string;
  filterKey: FilterKey;
  width: number;
  height: number;
}) {
  // volume 1 so the clip's own sound plays, like the normal player. Skia hands back RAW frames
  // plus the clip's `rotation` metadata — it does NOT pre-rotate — so a portrait clip (stored
  // landscape + rotation 90) arrives sideways unless we rotate it ourselves.
  const { currentFrame, rotation, size } = useVideo(uri, { looping: true, volume: 1 });
  const matrix = skiaColorMatrix(filterKey);

  const rw = size.width || width;
  const rh = size.height || height;
  const sideways = rotation === 90 || rotation === 270;
  // The clip's upright bounding box (dimensions swap for a quarter turn) → cover-fit scale.
  const boxW = sideways ? rh : rw;
  const boxH = sideways ? rw : rh;
  const scale = Math.max(width / boxW, height / boxH);
  const rad = (rotation * Math.PI) / 180;

  return (
    <Canvas style={StyleSheet.absoluteFill}>
      {/* Black underneath so the first-frame decode gap reads as a video, not a flash. */}
      <Fill color="black" />
      {/* Centre on the canvas, rotate the clip upright, cover-fit scale, then offset so the
          raw frame (drawn at its own size) sits centred. */}
      <Group
        transform={[
          { translateX: width / 2 }, { translateY: height / 2 },
          { rotate: rad },
          { scale },
          { translateX: -rw / 2 }, { translateY: -rh / 2 },
        ]}
      >
        <Image image={currentFrame} x={0} y={0} width={rw} height={rh} fit="fill">
          {matrix ? <ColorMatrix matrix={matrix} /> : null}
        </Image>
      </Group>
    </Canvas>
  );
}
