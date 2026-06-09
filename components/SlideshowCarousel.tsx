import React, { useEffect, useRef, useState } from 'react';
import {
  View, ScrollView, Image, TouchableOpacity, StyleSheet, Text,
  type NativeSyntheticEvent, type NativeScrollEvent,
} from 'react-native';
import { Video, ResizeMode } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';
import { RADIUS } from '../constants/theme';
import { useTabSwipeControl } from '../contexts/PagerContext';
import { type Slide } from '../lib/slideshow';

// Swipeable carousel for slideshow posts. A horizontal paging ScrollView (NOT a
// nested PagerView — those have a freeze history here). Page counter + dots.
//
// - The current video slide autoplays + loops while `active` (feed item visible /
//   full viewer focused); other slides show their poster.
// - Audio button (top-left) shows ONLY on video slides — it toggles that video's
//   OWN original audio. Image slides have no audio so they get no button. This
//   state is LOCAL to the carousel, separate from the feed's global mute buttons.
// - When a video's audio is turned on it reports up via onVideoAudioActiveChange
//   so the host can pause an attached song (and resume it when the video is muted
//   or you swipe to a non-video slide), so the two never overlap.
// - While you swipe between slides it disables the tab navigator's swipe so the
//   gesture doesn't change tabs (no-op outside the tabs).

type Props = {
  slides: Slide[];
  width: number;
  aspectRatio: number; // container width / height
  active?: boolean; // gate video autoplay (feed item visible / viewer focused)
  initialIndex?: number;
  onOpen?: (index: number) => void; // tap a slide → open the full viewer there (feed)
  // Reports whether the CURRENT slide is a video with its audio turned on, so the
  // host can pause/resume an attached song. Fires on slide change + toggle + unmount.
  onVideoAudioActiveChange?: (active: boolean) => void;
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
  slides, width, aspectRatio, active = true, initialIndex = 0, onOpen, onVideoAudioActiveChange,
}: Props) {
  const height = Math.round(width / (aspectRatio || 1));
  const [index, setIndex] = useState(initialIndex);
  const [videoAudioOn, setVideoAudioOn] = useState(false); // local: current video's own audio (default muted)
  const scrollRef = useRef<ScrollView>(null);
  const didInit = useRef(false);
  const setTabSwipe = useTabSwipeControl();
  const cbRef = useRef(onVideoAudioActiveChange);
  cbRef.current = onVideoAudioActiveChange;

  const current = Math.min(Math.max(index, 0), Math.max(0, slides.length - 1));
  const currentIsVideo = slides[current]?.type === 'video';
  const videoAudioActive = currentIsVideo && videoAudioOn;

  // Swiping to a non-video slide drops the unmute (so the song resumes there).
  useEffect(() => { if (!currentIsVideo && videoAudioOn) setVideoAudioOn(false); }, [currentIsVideo, videoAudioOn]);
  // Report (current video + its audio on) so the host can pause/resume the song.
  useEffect(() => { cbRef.current?.(videoAudioActive); }, [videoAudioActive]);
  useEffect(() => () => { cbRef.current?.(false); }, []);

  function onMomentumEnd(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const i = Math.round(e.nativeEvent.contentOffset.x / width);
    if (i !== index) setIndex(i);
    setTabSwipe(true);
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
        // Hold the tab swipe off while a slide swipe is in progress (re-enabled on end).
        onTouchStart={() => setTabSwipe(false)}
        onScrollBeginDrag={() => setTabSwipe(false)}
        onTouchEnd={() => setTabSwipe(true)}
        onTouchCancel={() => setTabSwipe(true)}
        onScrollEndDrag={() => setTabSwipe(true)}
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
          const body = (
            <View style={{ width, height, backgroundColor: '#000' }}>
              {isVideo ? (
                <SlideVideo
                  uri={s.url}
                  poster={s.thumbnail_url}
                  width={width}
                  height={height}
                  play={!!active && i === current}
                  muted={!videoAudioOn}
                />
              ) : (
                <Image source={{ uri: s.url }} style={{ width, height }} resizeMode="cover" />
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

      {/* Audio button — video slides only (image slides have no original audio). */}
      {currentIsVideo && (
        <TouchableOpacity
          style={styles.audioBtn}
          onPress={() => setVideoAudioOn((v) => !v)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name={videoAudioOn ? 'volume-high' : 'volume-mute'} size={16} color="#fff" />
        </TouchableOpacity>
      )}

      {slides.length > 1 && (
        <>
          <View style={styles.counter} pointerEvents="none">
            <Text style={styles.counterText}>{current + 1}/{slides.length}</Text>
          </View>
          <View style={styles.dots} pointerEvents="none">
            {slides.map((_, i) => (
              <View key={i} style={[styles.dot, i === current && styles.dotActive]} />
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
  audioBtn: {
    position: 'absolute', top: 8, left: 8,
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center',
  },
  dots: {
    position: 'absolute', bottom: 8, left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 5,
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.45)' },
  dotActive: { backgroundColor: '#fff', width: 7, height: 7, borderRadius: 3.5 },
});
