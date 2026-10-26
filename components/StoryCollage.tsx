import { View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { getCollageLayout } from '../lib/storyLayouts';

// Static collage renderer — draws the grid of slot images for a given layout, used by the
// story editor (as the background you add stickers over), the viewer and the thumbnail.
// Slots are cover-fit into their normalized rects, with a thin dark gap between them.
export default function StoryCollage({
  layout, slots, frameW, frameH, gap = 2, radius = 0,
}: {
  layout: string;
  slots: (string | null | undefined)[];
  frameW: number;
  frameH: number;
  gap?: number;
  radius?: number;
}) {
  const def = getCollageLayout(layout);
  if (!def) return null;
  return (
    <View style={{ width: frameW, height: frameH, backgroundColor: '#000' }}>
      {def.slots.map((r, i) => {
        const uri = slots[i];
        return (
          <View
            key={i}
            style={{
              position: 'absolute',
              left: r.x * frameW + gap / 2,
              top: r.y * frameH + gap / 2,
              width: r.w * frameW - gap,
              height: r.h * frameH - gap,
              borderRadius: radius,
              overflow: 'hidden',
              backgroundColor: '#141416',
            }}
          >
            {uri ? <ExpoImage source={{ uri }} style={{ width: '100%', height: '100%' }} contentFit="cover" cachePolicy="memory-disk" /> : null}
          </View>
        );
      })}
    </View>
  );
}
