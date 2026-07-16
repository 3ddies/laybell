import { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { VideoView, type VideoPlayer } from 'expo-video';
import { reelPool } from '../lib/feedVideoPool';

// Pooled video surface for reel pages (see lib/feedVideoPool). No player is
// ever CREATED at swipe time — the pool assigns sources via replaceAsync
// (async, off the UI thread), which is what lets the NEXT reel pre-buffer
// while the current one plays: releasing your finger lands on an
// already-loaded player that simply plays (the Instagram feel).
//
// The page's poster renders UNDERNEATH (ReelPage); this surface stays
// opacity-0 until readyToPlay so the still becomes motion with no flash.
type ContentFit = 'cover' | 'contain';

export type ReelVideoHandle = { seek: (sec: number) => void };

type Props = {
  id: string;      // post id (pool ownership key)
  uri: string;
  play: boolean;
  muted: boolean;
  loop: boolean;
  contentFit: ContentFit;
  trimStartSec?: number | null;
  trimEndSec?: number | null;
  onProgress?: (currentTimeMs: number, durationMs: number) => void;
};

const ReelVideo = memo(forwardRef<ReelVideoHandle, Props>(function ReelVideo(
  { id, uri, play, muted, loop, contentFit, trimStartSec, trimEndSec, onProgress }: Props,
  ref,
) {
  const [player, setPlayer] = useState<VideoPlayer | null>(null);
  const [ready, setReady] = useState(false);
  const playerRef = useRef<VideoPlayer | null>(null);
  playerRef.current = player;
  const playRef = useRef(play);
  playRef.current = play;
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const trimStartRef = useRef(trimStartSec ?? null);
  trimStartRef.current = trimStartSec ?? null;
  const trimEndRef = useRef(trimEndSec ?? null);
  trimEndRef.current = trimEndSec ?? null;
  // Trim loop-back fires once per cycle (a seek storm is itself a stutter).
  const trimSeekingRef = useRef(false);
  const seededRef = useRef(false);

  useImperativeHandle(ref, () => ({
    seek: (sec: number) => { try { if (playerRef.current) playerRef.current.currentTime = Math.max(0, sec); } catch {} },
  }), []);

  useEffect(() => {
    setReady(false);
    seededRef.current = false;
    trimSeekingRef.current = false;
    const subs: { remove: () => void }[] = [];
    const acq = reelPool.acquire(
      id,
      uri,
      { loop, muted: mutedRef.current, timeUpdateSec: 0.25 },
      // Stolen: fully detach, listeners included — a leftover timeUpdate
      // listener would run trim loop-back seeks against the THIEF's video.
      () => {
        subs.forEach((s) => s.remove());
        subs.length = 0;
        setPlayer(null);
        setReady(false);
      },
    );
    if (!acq) { setPlayer(null); return; } // nothing stealable — poster stays
    setPlayer(acq.player);
    if (acq.alreadyLoaded) {
      // The loaded source is already positioned (this reel played before) —
      // mark it seeded so a transient status flap can't snap the playhead
      // back to trimStart mid-watch.
      seededRef.current = true;
      setReady(true);
    }
    const statusSub = acq.player.addListener('statusChange', ({ status }: any) => {
      if (status === 'readyToPlay') {
        // Seed BEFORE revealing — revealing first flashed frame 0 for a beat
        // on trimmed clips before the jump to trimStart.
        if (!seededRef.current) {
          seededRef.current = true;
          const ts = trimStartRef.current;
          if (ts != null && ts > 0) { try { acq.player.currentTime = ts; } catch {} }
        }
        setReady(true);
        if (playRef.current) { try { acq.player.play(); } catch {} }
      }
    });
    const timeSub = acq.player.addListener('timeUpdate', ({ currentTime }: any) => {
      const dur = acq.player.duration || 0;
      onProgressRef.current?.(currentTime * 1000, dur * 1000);
      const te = trimEndRef.current;
      if (te != null) {
        if (currentTime >= te && !trimSeekingRef.current) {
          trimSeekingRef.current = true;
          try { acq.player.currentTime = trimStartRef.current ?? 0; } catch {}
        } else if (trimSeekingRef.current && currentTime < te - 0.3) {
          trimSeekingRef.current = false;
        }
      }
    });
    subs.push(statusSub, timeSub);
    return () => {
      subs.forEach((s) => s.remove());
      subs.length = 0;
      reelPool.release(id, acq.player);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, uri]);

  useEffect(() => {
    if (!player) return;
    try { player.muted = muted; } catch {}
  }, [muted, player]);

  useEffect(() => {
    if (!player) return;
    if (play) { try { player.play(); } catch {} }
    else { try { player.pause(); } catch {} }
  }, [play, player]);

  if (!player) return null;
  return (
    <VideoView
      style={[StyleSheet.absoluteFill, !ready && styles.hidden]}
      player={player}
      contentFit={contentFit}
      nativeControls={false}
      allowsVideoFrameAnalysis={false}
    />
  );
}));

const styles = StyleSheet.create({ hidden: { opacity: 0 } });

export default ReelVideo;
