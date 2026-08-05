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

  // The banner's GridVideo keeps its instance when the banner POST changes
  // (refresh brings a new top pick): drop straight to the new thumbnail —
  // one render with the old post's player under the new overlays is a flash.
  const [lastId, setLastId] = useState(id);
  if (lastId !== id) {
    setLastId(id);
    setPlayer(null);
    setReady(false);
  }

  useEffect(() => {
    if (!play) return;
    setReady(false);
    const subs: { remove: () => void }[] = [];
    let cancelled = false;
    let healTimer: ReturnType<typeof setTimeout> | null = null;
    const clearHeal = () => { if (healTimer) { clearTimeout(healTimer); healTimer = null; } };
    // Self-heal: tearing down the ambient SONG's AVAudioSession interrupts these
    // (muted) previews too, and expo-video does NOT auto-resume — the tile just
    // sits frozen on a still frame. Whenever the player stops while it SHOULD be
    // playing, drive it straight back. Same bounds as the Home feed's FeedVideo.
    // The timer is cleared on BOTH exits below: the pool hands this very player
    // to the next owner on a steal, so a live heal would drive the thief's video.
    const healPlayback = (p: VideoPlayer, tries = 0) => {
      clearHeal();
      if (cancelled || !playRef.current) return; // intentional pause → leave it
      if (p.playing) return;                     // already recovered
      try { p.play(); } catch {}
      if (tries < 4) healTimer = setTimeout(() => healPlayback(p, tries + 1), 150);
    };
    const acq = explorePool.acquire(
      id,
      uri,
      { loop: true, muted: true, timeUpdateSec: 0.5 },
      // Stolen (pool exhausted) — fully detach (listeners included, so this
      // tile's view tracking can't fire on the thief's video) and fall back
      // to the thumbnail underneath.
      () => {
        clearHeal();
        cancelled = true;
        subs.forEach((s) => s.remove());
        subs.length = 0;
        setPlayer(null);
        setReady(false);
      },
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
    const playingSub = acq.player.addListener('playingChange', ({ isPlaying }: any) => {
      if (!isPlaying && playRef.current && !cancelled) healPlayback(acq.player);
    });
    subs.push(statusSub, timeSub, playingSub);
    return () => {
      // Order matters: drop the listeners BEFORE release() pauses the player,
      // so an intentional scroll-away can't be mistaken for an interruption.
      clearHeal();
      cancelled = true;
      subs.forEach((s) => s.remove());
      subs.length = 0;
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
