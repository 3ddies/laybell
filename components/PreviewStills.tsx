import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import VideoThumb from './VideoThumb';
import { cfStreamFrameUrl, cfStreamThumbnail } from '../lib/cast';
import { previewFrameTimes } from '../lib/previewFrames';
import { useLoopIdle } from '../lib/playbackPresence';

// Explore's moving previews, made from still frames instead of video.
//
// Cloudflare bills Stream by the minute of VIDEO delivered — preloading and
// buffering included, rounded up to 4-second segments — and previews nobody
// opened were a large share of it: up to three streaming at once for as long as
// someone browsed Explore. Thumbnail images are not on Cloudflare's billed list,
// and a frame at this size weighs 6–60 KB. So a preview is now a slow cross-fade
// through a few moments of the video under a gentle zoom: it reads as motion,
// costs nothing on the Cloudflare bill, and tapping still opens the real video.
// Owner decision, 2026-09-10.
//
// Why not Cloudflare's animated GIFs, which are also unbilled: on real Laybell
// posts a 3-second GIF weighed ~3 MB, a 4-second one 8–9 MB, and the first one
// took up to 9 seconds to generate. Far too heavy for anyone's data plan.
//
// No video plays, so previews no longer report watch time or count as views.

const FRAME_COUNT = 4;
const FRAME_MS = 1800;   // time each moment holds
const FADE_MS = 800;     // cross-dissolve into the next
const ZOOM = 1.07;       // the slow push-in and back that makes stills read as motion
// Cloudflare derives the width from the video's own shape; 640 stays sharp at a
// tile's size on a 3x screen and still comes in under ~60 KB.
const FRAME_HEIGHT = 640;

type Props = {
  /** The post's media_url — a Cloudflare Stream HLS manifest. Anything else shows its poster only. */
  uri: string;
  thumbnailUrl?: string | null;
  durationSec?: number | null;
  trimStartSec?: number | null;
  trimEndSec?: number | null;
  /** On screen, on top, and one of the few tiles chosen to move — the grid decides. */
  play: boolean;
  style?: StyleProp<ViewStyle>;
};

const PreviewStills = memo(function PreviewStills({
  uri, thumbnailUrl, durationSec, trimStartSec, trimEndSec, play, style,
}: Props) {
  const frames = useMemo(
    () => previewFrameTimes(durationSec, trimStartSec, trimEndSec, FRAME_COUNT)
      .map((t) => cfStreamFrameUrl(uri, t, FRAME_HEIGHT))
      .filter((u): u is string => !!u),
    [uri, durationSec, trimStartSec, trimEndSec],
  );
  // A Stream post with no stored thumbnail still gets a real poster: VideoThumb's
  // own fallback grabs a frame on-device, which cannot seek HLS.
  const poster = thumbnailUrl || cfStreamThumbnail(uri);

  // Nothing is fetched for a tile until it first comes up to play; after that the
  // frame layer stays, so a tile that stops moving holds its moment instead of
  // snapping back to the poster.
  const [engaged, setEngaged] = useState(play);
  if (play && !engaged) setEngaged(true);

  // Nobody touching the phone: hold still. Frames cost nothing on the bill, but a
  // phone lying on a table has no use for cross-fades.
  const idle = useLoopIdle();
  const moving = play && !idle && frames.length > 1;

  const [index, setIndex] = useState(0);

  // Warm every frame up front, so each cross-fade lands on a decoded image rather
  // than waiting on Cloudflare to generate it (first request ~1–2 s, cached after).
  useEffect(() => {
    if (!engaged || !frames.length) return;
    ExpoImage.prefetch(frames, 'memory-disk').catch(() => {});
  }, [engaged, frames]);

  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(() => setIndex((i) => (i + 1) % frames.length), FRAME_MS);
    return () => clearInterval(timer);
  }, [moving, frames.length]);

  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!moving) return;
    const leg = FRAME_MS * frames.length;
    const zoom = Animated.loop(Animated.sequence([
      Animated.timing(scale, { toValue: ZOOM, duration: leg, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(scale, { toValue: 1, duration: leg, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    zoom.start();
    return () => zoom.stop();
  }, [moving, frames.length, scale]);

  return (
    <View style={[style, styles.clip]}>
      <VideoThumb thumbnailUrl={poster} mediaUrl={uri} style={StyleSheet.absoluteFill} />
      {engaged && frames.length > 0 && (
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { transform: [{ scale }] }]}>
          <ExpoImage
            source={{ uri: frames[index % frames.length] }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={{ duration: FADE_MS, effect: 'cross-dissolve' }}
          />
        </Animated.View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({ clip: { overflow: 'hidden' } });

export default PreviewStills;
