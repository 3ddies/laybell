import { View, StyleSheet, Dimensions } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { StickerContent } from './StickerLayer';
import { StoryBackground, type StoryBg } from './StoryBackgroundLayer';
import { StoryDrawRenderer, type DrawStroke } from './StoryDrawLayer';
import type { Story } from '../lib/stories';

const SCREEN_W = Dimensions.get('window').width;
const SCREEN_H = Dimensions.get('window').height;

// A non-interactive mini preview of a story at `width` px, shown as a 9:16 card
// with everything the author placed — the media (or a repositioned/zoomed photo
// over its backdrop), text stickers, and pen drawing — exactly where they put it.
//
// The technique is the story insights card's (app/story/[userId]): render the
// FULL screen-sized frame and uniformly scale that whole frame down to the card
// width, letting the card's overflow:hidden clip the extra height. Scaling the
// frame (rather than passing a tiny frame size) keeps font sizes, photo framing and
// stroke widths in proportion, so each layer lands where the author put it. All the
// composition below mirrors the viewer's plain-story path so the thumb matches it.
export default function StoryThumb({ story, width, radius = 0 }: { story: Story; width: number; radius?: number }) {
  const height = Math.round((width * 16) / 9);
  // The poster: an image story's own media, else a video story's thumbnail.
  const prev = story.media_type === 'image' ? story.media_url : story.thumbnail_url;
  const layers = (story.stickers ?? []) as any[];
  const stickers = layers.filter((st) => (!st.kind || st.kind === 'text') && st.text);
  const bg = (layers.find((l) => l?.kind === 'bg')?.background ?? null) as StoryBg | null;
  const strokes = (layers.find((l) => l?.kind === 'draw')?.strokes ?? null) as DrawStroke[] | null;
  // A 'frame' layer means the author repositioned/zoomed the PHOTO: redraw it with
  // that transform over a backdrop, so a zoomed-OUT photo shows the backdrop around
  // it. x/y are fractions of the frame; scale is relative to a cover fit; w/h are
  // source px — cover is recomputed for THIS screen, so framing is portable.
  const fr = layers.find((l) => l?.kind === 'frame') as any;
  const framed = story.media_type === 'image' && !!prev && fr && fr.w > 0 && fr.h > 0;
  const cs = framed ? Math.max(SCREEN_W / fr.w, SCREEN_H / fr.h) : 1;
  const bw = fr ? fr.w * cs : 0;
  const bh = fr ? fr.h * cs : 0;

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
        {framed ? (
          <>
            {bg && bg.type !== 'blur' ? (
              <StoryBackground bg={bg} />
            ) : (
              <ExpoImage source={{ uri: prev! }} style={StyleSheet.absoluteFill} contentFit="cover" blurRadius={30} cachePolicy="memory-disk" />
            )}
            <ExpoImage
              source={{ uri: prev! }}
              contentFit="cover"
              cachePolicy="memory-disk"
              style={{
                position: 'absolute', width: bw, height: bh,
                left: (SCREEN_W - bw) / 2, top: (SCREEN_H - bh) / 2,
                transform: [
                  { translateX: (fr.x ?? 0) * SCREEN_W },
                  { translateY: (fr.y ?? 0) * SCREEN_H },
                  { scale: fr.scale ?? 1 },
                  { rotate: `${fr.rotation ?? 0}deg` },
                ],
              }}
            />
          </>
        ) : (
          !!prev && (
            <ExpoImage source={{ uri: prev }} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory-disk" />
          )
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
        {/* Pen drawing — on top of media + text, matching the viewer's order. */}
        {strokes && strokes.length > 0 && (
          <View style={StyleSheet.absoluteFill}>
            <StoryDrawRenderer strokes={strokes} frameW={SCREEN_W} frameH={SCREEN_H} />
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { overflow: 'hidden', backgroundColor: '#000' },
  fallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#111' },
  center: { alignItems: 'center', justifyContent: 'center' },
});
