import { memo, useEffect, useRef, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { VideoView, type VideoPlayer } from 'expo-video';
import { explorePool } from '../lib/feedVideoPool';
import VideoThumb from './VideoThumb';

// Pooled looping preview surface for grid tiles (Explore masonry + the
// Laybell-TV banner). Same discipline as the Home feed's FeedVideo:
// - no AVPlayer is ever CREATED here (pool assignment is an async source
//   swap), so tiles scrolling into view can't stall a frame;
// - the thumbnail renders UNDERNEATH and the video surface stays opacity-0
//   until readyToPlay — a still that becomes motion, never a black flash;
// - releasing (scrolling away) is pause-only; the pool reuses entries lazily.
type Props = {
  id: string;      // post id (pool ownership key)
  uri: string;
  thumbnailUrl?: string | null;
  play: boolean;
  style?: StyleProp<ViewStyle>;
  onProgress?: (currentTimeMs: number, durationMs: number) => void;
};

const GridVideo = memo(function GridVideo({ id, uri, thumbnailUrl, play, style, onProgress }: Props) {
  const [player, setPlayer] = useState<VideoPlayer | null>(null);
  const [ready, setReady] = useState(false);
  const playRef = useRef(play);
  playRef.current = play;
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;

  useEffect(() => {
    if (!play) return;
    setReady(false);
    const acq = explorePool.acquire(
      id,
      uri,
      { loop: true, muted: true, timeUpdateSec: 0.5 },
      // Stolen (pool exhausted) — fall back to the thumbnail underneath.
      () => { setPlayer(null); setReady(false); },
    );
    if (!acq) return; // nothing stealable right now — stay on the thumbnail
    setPlayer(acq.player);
    if (acq.alreadyLoaded) {
      setReady(true);
      try { acq.player.play(); } catch {}
    }
    const statusSub = acq.player.addListener('statusChange', ({ status }: any) => {
      if (status === 'readyToPlay') {
        setReady(true);
        if (playRef.current) { try { acq.player.play(); } catch {} }
      }
    });
    const timeSub = acq.player.addListener('timeUpdate', ({ currentTime }: any) => {
      const dur = acq.player.duration || 0;
      onProgressRef.current?.(currentTime * 1000, dur * 1000);
    });
    return () => {
      statusSub.remove();
      timeSub.remove();
      explorePool.release(id, acq.player);
      setPlayer(null);
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, uri, play]);

  return (
    <View style={style}>
      <VideoThumb thumbnailUrl={thumbnailUrl} mediaUrl={uri} style={StyleSheet.absoluteFill} />
      {play && player && (
        <VideoView
          style={[StyleSheet.absoluteFill, !ready && styles.hidden]}
          player={player}
          contentFit="cover"
          nativeControls={false}
          allowsVideoFrameAnalysis={false}
        />
      )}
    </View>
  );
});

const styles = StyleSheet.create({ hidden: { opacity: 0 } });

export default GridVideo;
