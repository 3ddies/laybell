import { memo, useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { VideoView, type VideoPlayer } from 'expo-video';
import { acquireFeedPlayer, releaseFeedPlayer } from '../lib/feedVideoPool';
import { useFeedFocused } from '../lib/feedVideo';
import { useMediaSuspend } from '../contexts/MediaSuspendContext';

// Pooled video surface for Home-feed post cards (see lib/feedVideoPool — no
// player is ever CREATED here, so mounting mid-scroll is cheap and safe).
//
// Anti-black-flash: the card's thumbnail stays rendered UNDERNEATH; the
// VideoView is opacity-0 until readyToPlay for THIS card's source.
//
// Bandwidth discipline (the "plays ~1s then freezes" fix): the PLAYING card's
// stream loads immediately; on-screen neighbor cards wait 500ms before
// loading so they never compete with the playing video's first seconds. And
// when the feed blurs (reels modal, pushed screens), players fully detach +
// unload — paused-but-loaded players kept buffering under the modal.
type Props = {
  id: string;      // post id (pool ownership key)
  uri: string;
  play: boolean;   // actually play (vs assigned/paused)
  muted: boolean;
  onProgress?: (currentTimeMs: number, durationMs: number) => void;
};

// 1100ms (was 500): the playing video's first seconds are its most fragile —
// the owner's screen recording showed neighbor pre-loads starving them into a
// multi-second rebuffer on fat raw-MP4 posts. With the pool's buffer caps
// bounding every download, a longer head start costs nothing visible
// (neighbors sit behind their thumbnails) and protects the watched stream.
const NEIGHBOR_LOAD_DELAY_MS = 1100;

const FeedVideo = memo(function FeedVideo({ id, uri, play, muted, onProgress }: Props) {
  const [player, setPlayer] = useState<VideoPlayer | null>(null);
  const [ready, setReady] = useState(false);
  const focused = useFeedFocused();
  // A full-screen takeover (e.g. the GIF maker) globally pauses feed media.
  const { suspended } = useMediaSuspend();
  const shouldPlay = play && !suspended;
  const shouldPlayRef = useRef(shouldPlay);
  shouldPlayRef.current = shouldPlay;
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  // Set inside the acquire effect; lets the play effect force an immediate
  // acquire when this card becomes the playing one before its neighbor-delay
  // timer has fired.
  const acquireNowRef = useRef<(() => void) | null>(null);

  // Recycling reset (FlashList reuses this instance across items): the id can
  // change WITHOUT a remount — drop to the thumbnail until re-acquired.
  const [lastId, setLastId] = useState(id);
  if (lastId !== id) {
    setLastId(id);
    setPlayer(null);
    setReady(false);
  }

  useEffect(() => {
    if (!focused) { setPlayer(null); setReady(false); return; }
    setReady(false);
    let cancelled = false;
    let acquired: VideoPlayer | null = null;
    const subs: { remove: () => void }[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;

    const doAcquire = () => {
      if (cancelled || acquired) return;
      const acq = acquireFeedPlayer(
        id,
        uri,
        { loop: true, muted: mutedRef.current, timeUpdateSec: 0.25 },
        // Stolen (pool exhausted): detach so this card falls back to its thumbnail.
        () => { setPlayer(null); setReady(false); },
      );
      if (!acq) return; // nothing stealable right now — stay on the thumbnail
      acquired = acq.player;
      setPlayer(acq.player);
      if (acq.alreadyLoaded) setReady(true);
      subs.push(acq.player.addListener('statusChange', ({ status }: any) => {
        if (status === 'readyToPlay') {
          setReady(true);
          if (shouldPlayRef.current) { try { acq.player.play(); } catch {} }
        }
      }));
      subs.push(acq.player.addListener('timeUpdate', ({ currentTime }: any) => {
        const dur = acq.player.duration || 0;
        onProgressRef.current?.(currentTime * 1000, dur * 1000);
      }));
    };
    acquireNowRef.current = () => { if (timer) { clearTimeout(timer); timer = null; } doAcquire(); };

    if (shouldPlayRef.current) doAcquire();
    else timer = setTimeout(doAcquire, NEIGHBOR_LOAD_DELAY_MS);

    return () => {
      cancelled = true;
      acquireNowRef.current = null;
      if (timer) clearTimeout(timer);
      subs.forEach((s) => s.remove());
      if (acquired) releaseFeedPlayer(id, acquired);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, uri, focused]);

  useEffect(() => {
    if (!player) return;
    try { player.muted = muted; } catch {}
  }, [muted, player]);

  useEffect(() => {
    if (shouldPlay && !player) { acquireNowRef.current?.(); return; }
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
