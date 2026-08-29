import React, { useEffect, useRef, useState } from 'react';
import {
  View, TouchableOpacity, StyleSheet, Text,
  type NativeSyntheticEvent, type NativeScrollEvent,
} from 'react-native';
// Gesture-handler's ScrollView, NOT React Native's. Identical props and methods
// (it is RN's, native-wrapped), but its forwarded ref carries a handlerTag, so
// the pinch below can name it as a simultaneous handler. With RN's plain
// ScrollView the scroll claiming the touch CANCELS the pinch, and a cancelled
// pinch springs straight back — the zoom starts and is yanked away a beat later.
import { ScrollView } from 'react-native-gesture-handler';
import { Image as ExpoImage } from 'expo-image';
import AppVideo from './AppVideo';
import { Ionicons } from '@expo/vector-icons';
import ZoomableView from './ZoomableView';
import { RADIUS } from '../constants/theme';
import { useTabSwipeControl } from '../contexts/PagerContext';
import { trackVideoProgress } from '../lib/viewTracker';
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
  // When set, watch time on video slides counts toward this post's views
  // (kept INTERNAL for slideshows — never displayed — but it feeds relevance
  // scoring and the owner's analytics).
  postId?: string;
  onOpen?: (index: number) => void; // tap a slide → open the full viewer there (feed)
  // Reports whether the CURRENT slide is a video with its audio turned on, so the
  // host can pause/resume an attached song. Fires on slide change + toggle + unmount.
  onVideoAudioActiveChange?: (active: boolean) => void;
  // Raised while a slide is being pinch-zoomed, so the host can stop ITS scroll
  // too (the feed's vertical list) and lift the card over its neighbours.
  onZoomChange?: (zooming: boolean) => void;
};

function SlideVideo({
  uri, poster, width, height, play, muted, onProgress,
}: {
  uri: string; poster?: string | null; width: number; height: number;
  play: boolean; muted: boolean; onProgress?: (currentTimeMs: number, durationMs: number) => void;
}) {
  return (
    <AppVideo
      source={{ uri }}
      style={{ width, height }}
      contentFit="contain"
      active={play}
      showStallIndicator
      loop
      muted={muted}
      poster={poster}
      posterContentFit="contain"
      onProgress={onProgress}
    />
  );
}

export default function SlideshowCarousel({
  slides, width, aspectRatio, active = true, initialIndex = 0, postId, onOpen, onVideoAudioActiveChange, onZoomChange,
}: Props) {
  const height = Math.round(width / (aspectRatio || 1));
  const [index, setIndex] = useState(initialIndex);
  // ── Pinch-to-zoom on a slide ────────────────────────────────────────────────
  // The hard part here is not the zoom, it is that this carousel scrolls
  // HORIZONTALLY. A pinch spreads two fingers apart sideways, which moves the
  // touch centroid sideways, which is precisely what a horizontal paging
  // ScrollView claims — so the slide paged instead of the photo zooming. The
  // reel viewer never hit this because its list scrolls vertically.
  //
  // Two things had to be true, and the first attempt only did one of them.
  //
  // 1. The scroll must not CANCEL the pinch. That is what simultaneousHandlers
  //    is for, and it only works because the zoom now wraps the scroll view
  //    rather than each slide — see the note at the wrapper below.
  // 2. The scroll must not PAGE. multiTouch keys off the second finger touching
  //    DOWN, before anything has moved: waiting for the zoom to start is too
  //    late, because by then the scroll already owns the gesture.
  const [multiTouch, setMultiTouch] = useState(false);
  const [zooming, setZooming] = useState(false);
  const gestureSincePress = useRef(false);
  const zoomCbRef = useRef(onZoomChange);
  zoomCbRef.current = onZoomChange;
  const [videoAudioOn, setVideoAudioOn] = useState(false); // local: current video's own audio (default muted)
  const scrollRef = useRef<ScrollView>(null);
  const didInit = useRef(false);
  const setTabSwipe = useTabSwipeControl();
  const cbRef = useRef(onVideoAudioActiveChange);
  cbRef.current = onVideoAudioActiveChange;

  const current = Math.min(Math.max(index, 0), Math.max(0, slides.length - 1));
  const currentIsVideo = slides[current]?.type === 'video';
  // Video players mount only after the carousel FIRST becomes active (feed:
  // this card is the visible video at scroll rest; full viewer: focused).
  // Cards entering the feed's render window mid-scroll would otherwise CREATE
  // AVPlayers during the scroll — a main-thread freeze (lib/feedVideoPool
  // header rule #1). Once engaged the players stay mounted (paused) so
  // scrolling away doesn't pay a disposal either; they release on unmount,
  // which the key={item.id} recycle remount already handles.
  const [engaged, setEngaged] = useState(!!active);
  if (active && !engaged) setEngaged(true);
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
    <View
      style={{ width, height }}
      // Multi-touch is detected on THIS wrapper, not the ScrollView, and before
      // any movement — the scroll has to be off before the fingers travel, not
      // after the zoom starts.
      onTouchStart={(e) => { if (e.nativeEvent.touches.length > 1) setMultiTouch(true); }}
      onTouchEnd={(e) => { if (e.nativeEvent.touches.length < 2) setMultiTouch(false); }}
      onTouchCancel={() => setMultiTouch(false)}
    >
      {/* The zoom wraps the SCROLL VIEW, not each slide, and that placement is
          the fix rather than a tidy-up.

          Per-slide, each pinch handler was a CHILD of the scroll view, and React
          commits children before parents — so every pinch registered its
          simultaneousHandlers while the scroll view's ref was still null, the
          relation was never made, and the scroll cancelled the pinch on contact
          (the zoom visibly started and was yanked back). As an ancestor the ref
          is already populated when the pinch mounts, so the two are genuinely
          declared simultaneous.

          Scaling the viewport looks identical to scaling the slide — the scroll
          view clips its content to its own frame first, so what grows is exactly
          the visible slide — and it costs ONE zoom per carousel instead of one
          per slide. */}
      <ZoomableView
        width={width}
        height={height}
        style={{ width, height }}
        resetOnRelease
        simultaneousHandlers={scrollRef}
        onGesture={() => { gestureSincePress.current = true; }}
        onZoomChange={(z) => { setZooming(z); zoomCbRef.current?.(z); }}
      >
        <ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={onMomentumEnd}
          contentOffset={{ x: initialIndex * width, y: 0 }}
          // Paging is off from the moment a second finger lands until every finger
          // is up — see the note by multiTouch above.
          scrollEnabled={!multiTouch && !zooming}
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
                  engaged && Math.abs(i - current) <= 1 ? (
                    <SlideVideo
                      uri={s.url}
                      poster={s.thumbnail_url}
                      width={width}
                      height={height}
                      play={!!active && i === current}
                      muted={!videoAudioOn}
                      // Watch time on video slides counts toward the post's
                      // (internal-only) view tally — same tracker + server caps
                      // as regular videos. Paused slides report no forward
                      // progress, so only the playing slide accrues.
                      onProgress={postId ? (pos, dur) => trackVideoProgress(postId, pos, dur) : undefined}
                    />
                  ) : (
                    // FAR video slides hold their poster instead of a live native
                    // player — a paging swipe only ever moves one slide, so the
                    // incoming slide's player (current ± 1) is always already
                    // mounted; nothing visibly changes, but a multi-video
                    // slideshow no longer allocates every AVPlayer at mount.
                    s.thumbnail_url
                      ? <ExpoImage source={{ uri: s.thumbnail_url }} style={{ width, height }} contentFit="contain" cachePolicy="memory-disk" />
                      : <View style={{ width, height }} />
                  )
                ) : (
                  <ExpoImage source={{ uri: s.url }} style={{ width, height }} contentFit="cover" cachePolicy="memory-disk" />
                )}
              </View>
            );
            return onOpen ? (
              <TouchableOpacity
                key={i}
                activeOpacity={0.95}
                onPressIn={() => { gestureSincePress.current = false; }}
                // A pinch marks itself, so the tap that ends it doesn't also open
                // the full viewer.
                onPress={() => { if (!gestureSincePress.current) onOpen(i); }}
              >
                {body}
              </TouchableOpacity>
            ) : (
              <View key={i}>{body}</View>
            );
          })}
        </ScrollView>
      </ZoomableView>

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
