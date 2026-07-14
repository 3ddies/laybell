import { memo, useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { VideoView, type VideoPlayer } from 'expo-video';
import { acquireFeedPlayer, releaseFeedPlayer } from '../lib/feedVideoPool';
import { useMediaSuspend } from '../contexts/MediaSuspendContext';

// Pooled video surface for Home-feed post cards (see lib/feedVideoPool — no
// player is ever CREATED here, so mounting this mid-scroll is cheap and safe).
//
// Anti-black-flash: the card's own thumbnail stays rendered UNDERNEATH this
// surface, and the VideoView is opacity-0 until the player reports
// readyToPlay for THIS card's source — the still simply becomes motion, with
// no black surface flash in between.
type Props = {
  id: string;      // post id (pool ownership key)
  uri: string;
  play: boolean;   // actually play (vs assigned/paused)
  muted: boolean;
  onProgress?: (currentTimeMs: number, durationMs: number) => void;
};

const FeedVideo = memo(function FeedVideo({ id, uri, play, muted, onProgress }: Props) {
  const [player, setPlayer] = useState<VideoPlayer | null>(null);
  const [ready, setReady] = useState(false);
  // A full-screen takeover (e.g. the GIF maker) globally pauses feed media.
  const { suspended } = useMediaSuspend();
  const shouldPlay = play && !suspended;
  const shouldPlayRef = useRef(shouldPlay);
  shouldPlayRef.current = shouldPlay;
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  useEffect(() => {
    setReady(false);
    const acq = acquireFeedPlayer(
      id,
      uri,
      { loop: true, muted: mutedRef.current, timeUpdateSec: 0.25 },
      // Stolen by another card (pool exhausted): detach so this card falls
      // back to its thumbnail instead of showing the thief's video.
      () => { setPlayer(null); setReady(false); },
    );
    setPlayer(acq.player);
    if (acq.alreadyLoaded) setReady(true);
    const statusSub = acq.player.addListener('statusChange', ({ status }: any) => {
      if (status === 'readyToPlay') {
        setReady(true);
        // A load that finished after the play flag flipped needs the kick.
        if (shouldPlayRef.current) { try { acq.player.play(); } catch {} }
      }
    });
    const timeSub = acq.player.addListener('timeUpdate', ({ currentTime }: any) => {
      const dur = acq.player.duration || 0;
      onProgressRef.current?.(currentTime * 1000, dur * 1000);
    });
    return () => {
      statusSub.remove();
      timeSub.remove();
      releaseFeedPlayer(id, acq.player);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, uri]);

  useEffect(() => {
    if (!player) return;
    try { player.muted = muted; } catch {}
  }, [muted, player]);

  useEffect(() => {
    if (!player) return;
    if (shouldPlay) { try { player.play(); } catch {} }
    else { try { player.pause(); } catch {} }
  }, [shouldPlay, player]);

  if (!player) return null;
  return (
    <VideoView
      style={[StyleSheet.absoluteFill, !ready && styles.hidden]}
      player={player}
      contentFit="cover"
      nativeControls={false}
      // iOS 16+ floats a "Live Text" button over detected text — keep tiles clean.
      allowsVideoFrameAnalysis={false}
    />
  );
});

const styles = StyleSheet.create({ hidden: { opacity: 0 } });

export default FeedVideo;
