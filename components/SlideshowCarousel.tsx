import React, { useRef, useState } from 'react';
import {
  View, ScrollView, Image, TouchableOpacity, StyleSheet, Text,
  type NativeSyntheticEvent, type NativeScrollEvent,
} from 'react-native';
import { Video, ResizeMode } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, RADIUS } from '../constants/theme';
import { slideCover, type Slide } from '../lib/slideshow';

// Swipeable carousel for slideshow posts. A horizontal paging ScrollView (NOT a
// nested PagerView — those have a freeze history here). Page counter + dots.
//   variant 'feed' — image slides inline; video slides show a poster + play badge.
//                    Any tap calls onOpen(index) to open the full-screen viewer.
//   variant 'full' — images shown; the currently-visible video slide autoplays
//                    (gated by `active` so it only plays on the focused screen).

type Props = {
  slides: Slide[];
  width: number;
  aspectRatio: number; // container width / height
  variant: 'feed' | 'full';
  active?: boolean; // full: gate video autoplay to the focused screen
  muted?: boolean;
  initialIndex?: number;
  onOpen?: (index: number) => void; // feed: tap a slide → open the full viewer there
};

function SlideVideo({
  uri, poster, width, height, play, muted,
}: { uri: string; poster?: string | null; width: number; height: number; play: boolean; muted: boolean }) {
  return (
    <Video
      source={{ uri }}
      style={{ width, height }}
      resizeMode={ResizeMode.CONTAIN}
      shouldPlay={play}
      isLooping
      isMuted={muted}
      usePoster
      posterSource={poster ? { uri: poster } : undefined}
    />
  );
}

export default function SlideshowCarousel({
  slides, width, aspectRatio, variant, active = true, muted = false, initialIndex = 0, onOpen,
}: Props) {
  const height = Math.round(width / (aspectRatio || 1));
  const [index, setIndex] = useState(initialIndex);
  const scrollRef = useRef<ScrollView>(null);
  const didInit = useRef(false);

  function onMomentumEnd(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const i = Math.round(e.nativeEvent.contentOffset.x / width);
    if (i !== index) setIndex(i);
  }

  return (
    <View style={{ width, height }}>
      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onMomentumEnd}
        contentOffset={{ x: initialIndex * width, y: 0 }}
        // Android ignores contentOffset before layout — jump once we have a frame.
        onLayout={() => {
          if (!didInit.current && initialIndex > 0) {
            didInit.current = true;
            scrollRef.current?.scrollTo({ x: initialIndex * width, animated: false });
          }
        }}
      >
        {slides.map((s, i) => {
          const isVideo = s.type === 'video';

          if (variant === 'full' && isVideo) {
            return (
              <View key={i} style={{ width, height, backgroundColor: '#000' }}>
                <SlideVideo
                  uri={s.url}
                  poster={s.thumbnail_url}
                  width={width}
                  height={height}
                  play={active && i === index}
                  muted={muted}
                />
              </View>
            );
          }

          const body = (
            <View style={{ width, height, backgroundColor: '#000' }}>
              <Image
                source={{ uri: isVideo ? slideCover(s) : s.url }}
                style={{ width, height }}
                resizeMode={isVideo ? 'contain' : 'cover'}
              />
              {isVideo && (
                <View style={styles.playBadge} pointerEvents="none">
                  <View style={styles.playCircle}>
                    <Ionicons name="play" size={22} color="#fff" />
                  </View>
                </View>
              )}
            </View>
          );

          return onOpen ? (
            <TouchableOpacity key={i} activeOpacity={0.95} onPress={() => onOpen(i)}>
              {body}
            </TouchableOpacity>
          ) : (
            <View key={i}>{body}</View>
          );
        })}
      </ScrollView>

      {slides.length > 1 && (
        <>
          <View style={styles.counter} pointerEvents="none">
            <Text style={styles.counterText}>{Math.min(index, slides.length - 1) + 1}/{slides.length}</Text>
          </View>
          <View style={styles.dots} pointerEvents="none">
            {slides.map((_, i) => (
              <View key={i} style={[styles.dot, i === index && styles.dotActive]} />
            ))}
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  counter: {
    position: 'absolute', top: 10, right: 10,
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: RADIUS.full,
    paddingHorizontal: 9, paddingVertical: 3,
  },
  counterText: { color: '#fff', fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
  playBadge: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  playCircle: {
    width: 54, height: 54, borderRadius: 27,
    backgroundColor: 'rgba(0,0,0,0.45)', borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.8)',
    alignItems: 'center', justifyContent: 'center', paddingLeft: 3,
  },
  dots: {
    position: 'absolute', bottom: 8, left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 5,
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.45)' },
  dotActive: { backgroundColor: '#fff', width: 7, height: 7, borderRadius: 3.5 },
});
