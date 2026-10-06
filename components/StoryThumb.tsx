import { View, StyleSheet, Dimensions } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { StickerContent } from './StickerLayer';
import type { Story } from '../lib/stories';

const SCREEN_W = Dimensions.get('window').width;
const SCREEN_H = Dimensions.get('window').height;

// A non-interactive mini preview of a story at `width` px, shown as a 9:16 card
// with the story's text stickers placed exactly where the author put them.
//
// The technique is the story insights card's (app/story/[userId]): render the
// FULL screen-sized frame — media (cover) + the text stickers at their normalized
// positions — and uniformly scale that whole frame down to the card width,
// letting the card's overflow:hidden clip the extra height. Scaling the frame
// (rather than passing a tiny frame size) keeps the font sizes and placements in
// proportion, so the text lands where the author put it instead of being squashed
// into a square or dropped entirely (the 1:1 / no-text problem this replaces).
export default function StoryThumb({ story, width, radius = 0 }: { story: Story; width: number; radius?: number }) {
  const height = Math.round((width * 16) / 9);
  // The poster: an image story's own media, else a video story's thumbnail.
  const prev = story.media_type === 'image' ? story.media_url : story.thumbnail_url;
  const stickers = (story.stickers ?? []).filter((st: any) => (!st.kind || st.kind === 'text') && st.text);
  return (
    <View style={[styles.card, { width, height, borderRadius: radius }]}>
      {!prev && (
        <View style={[StyleSheet.absoluteFill, styles.fallback]}>
          <Ionicons name="play" size={22} color="rgba(255,255,255,0.7)" />
        </View>
      )}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          width: SCREEN_W, height: SCREEN_H,
          left: (width - SCREEN_W) / 2,
          top: (height - SCREEN_H) / 2,
          transform: [{ scale: width / SCREEN_W }],
        }}
      >
        {!!prev && (
          <ExpoImage source={{ uri: prev }} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory-disk" />
        )}
        {stickers.map((st: any, k: number) => (
          <View key={k} style={[StyleSheet.absoluteFill, styles.center]}>
            <View
              style={{
                transform: [
                  { translateX: (st.x - 0.5) * SCREEN_W },
                  { translateY: (st.y - 0.5) * SCREEN_H },
                  { scale: st.scale ?? 1 },
                  { rotate: `${st.rotation ?? 0}deg` },
                ],
              }}
            >
              <StickerContent sticker={st} />
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { overflow: 'hidden', backgroundColor: '#000' },
  fallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#111' },
  center: { alignItems: 'center', justifyContent: 'center' },
});
