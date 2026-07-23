import { memo, useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { VideoView, type VideoPlayer } from 'expo-video';
import { acquireFeedPlayer, releaseFeedPlayer } from '../lib/feedVideoPool';
import { useFeedFocused, useFeedAppActive } from '../lib/feedVideo';
import { useMediaSuspend } from '../contexts/MediaSuspendContext';

// Pooled video surface for Home-feed post cards (see lib/feedVideoPool — no
// player is ever CREATED here, so mounting mid-scroll is cheap and safe).
//
// Anti-flash / anti-freeze (the card's thumbnail stays rendered UNDERNEATH):
//   1. The VideoView doesn't MOUNT until THIS post's source has finished
//      loading into the pooled player — so a reused player can never paint the
//      frame it still held from its previous post (the cross-post flash).
//   2. Once mounted it stays opacity-0 until onFirstFrameRender — an actual
//      painted frame — so we never reveal an unpainted (frozen/black) surface.
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
  // sourceReady: THIS post's source has finished loading into the pooled player,
  // so the VideoView can safely mount — it will paint THIS post's frame, never
  // the frame the reused player was still holding from its previous post (the
  // cross-post flash). ready: the surface has actually painted (poster hide).
  const [sourceReady, setSourceReady] = useState(false);
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
  // Reveal-safety timer (see the acquire effect): onFirstFrameRender is the
  // primary poster-hide signal; this only fires if that paint never arrives.
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearRevealTimer = () => { if (revealTimerRef.current) { clearTimeout(revealTimerRef.current); revealTimerRef.current = null; } };

  // Recycling reset (FlashList reuses this instance across items): the id can
  // change WITHOUT a remount — drop to the thumbnail until re-acquired.
  const [lastId, setLastId] = useState(id);
  if (lastId !== id) {
    setLastId(id);
    setPlayer(null);
    setSourceReady(false);
    setReady(false);
  }

  useEffect(() => {
    if (!focused) { setPlayer(null); setSourceReady(false); setReady(false); clearRevealTimer(); return; }
    setSourceReady(false);
    setReady(false);
    let cancelled = false;
    let acquired: VideoPlayer | null = null;
    const subs: { remove: () => void }[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let healTimer: ReturnType<typeof setTimeout> | null = null;
    const clearHeal = () => { if (healTimer) { clearTimeout(healTimer); healTimer = null; } };
    // Self-heal: an external AVAudioSession interruption — most commonly the
    // ambient SONG player starting up over this (muted) video — can PAUSE this
    // AVPlayer with no change to OUR intent, and expo-video does NOT auto-resume,
    // so the video sits frozen mid-scroll. Whenever the player stops while it
    // SHOULD be playing, drive it straight back. The bounded retries ride out a
    // session that's still settling; it stops fighting the moment the video is
    // legitimately meant to be paused (not centered / suspended / feed blurred).
    const healPlayback = (p: VideoPlayer, tries = 0) => {
      clearHeal();
      if (cancelled || !shouldPlayRef.current) return; // intentional pause → leave it
      if (p.playing) return;                           // already recovered
      try { p.play(); } catch {}
      if (tries < 4) healTimer = setTimeout(() => healPlayback(p, tries + 1), 150);
    };

    // THIS post's source is loaded → let the VideoView mount, and arm the reveal
    // safety net. onFirstFrameRender is the real poster-hide signal; if that
    // paint never arrives we nudge the surface once (seekBy(0) forces a reused
    // player's layer to re-present a live frame — the frozen-frame fix) and then
    // reveal as a last resort so a card is never stranded on its thumbnail.
    const onSourceReady = (p: VideoPlayer) => {
      if (cancelled || acquired !== p) return;
      setSourceReady(true);
      clearRevealTimer();
      revealTimerRef.current = setTimeout(() => {
        try { p.seekBy(0); } catch {}
        revealTimerRef.current = setTimeout(() => {
          revealTimerRef.current = null;
          if (!cancelled && p.status === 'readyToPlay') setReady(true);
        }, 600);
      }, 700);
    };

    const doAcquire = () => {
      if (cancelled || acquired) return;
      const acq = acquireFeedPlayer(
        id,
        uri,
        { loop: true, muted: mutedRef.current, timeUpdateSec: 0.25 },
        // Stolen (pool exhausted): fully detach — listeners INCLUDED, or this
        // card's watch-time tracking and play() kicks would keep firing on the
        // player now loading the THIEF's video — and clear `acquired` so a
        // later shouldPlay promotion can re-acquire instead of being blocked.
        () => {
          subs.forEach((s) => s.remove());
          subs.length = 0;
          acquired = null;
          setPlayer(null);
          setSourceReady(false);
          setReady(false);
          clearRevealTimer();
          clearHeal();
        },
      );
      if (!acq) return; // nothing stealable right now — stay on the thumbnail
      acquired = acq.player;
      setPlayer(acq.player);
      subs.push(acq.player.addListener('statusChange', ({ status }: any) => {
        // Data ready → start playback if this is the centered card. The POSTER
        // is NOT hidden here: reveal is driven by onFirstFrameRender (an actual
        // paint) below, and the VideoView only mounts once sourceReady.
        if (status === 'readyToPlay' && shouldPlayRef.current) { try { acq.player.play(); } catch {} }
      }));
      subs.push(acq.player.addListener('timeUpdate', ({ currentTime }: any) => {
        const dur = acq.player.duration || 0;
        onProgressRef.current?.(currentTime * 1000, dur * 1000);
      }));
      // Keep the video playing through external interruptions (an attached song
      // starting, the ambient player swapping sources): if it stops while it
      // should be playing, resume it — the fix for "videos freeze when music
      // gets involved". Intentional pauses (shouldPlay false) are left alone.
      subs.push(acq.player.addListener('playingChange', ({ isPlaying }: any) => {
        if (!isPlaying && shouldPlayRef.current && !cancelled) healPlayback(acq.player);
      }));
      // Gate the VideoView mount on THIS source being loaded, so its first paint
      // is never the frame left over from the pooled player's previous post.
      if (acq.alreadyLoaded) onSourceReady(acq.player);
      else if (acq.loadPromise) acq.loadPromise.then(() => onSourceReady(acq.player));
      // No handle for an in-flight same-uri load (rare) — fall back to the
      // player's own readiness signal.
      else subs.push(acq.player.addListener('statusChange', ({ status }: any) => {
        if (status === 'readyToPlay') onSourceReady(acq.player);
      }));
    };
    acquireNowRef.current = () => { if (timer) { clearTimeout(timer); timer = null; } doAcquire(); };

    if (shouldPlayRef.current) doAcquire();
    else timer = setTimeout(doAcquire, NEIGHBOR_LOAD_DELAY_MS);

    return () => {
      cancelled = true;
      acquireNowRef.current = null;
      if (timer) clearTimeout(timer);
      clearRevealTimer();
      clearHeal();
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

  // Returned to the foreground on a video that should be playing: iOS suspends
  // the AVPlayer while the app is backgrounded, and it can come back paused OR
  // resumed on a stale frame. On the background→foreground edge, resume it and
  // nudge the surface (seekBy 0) so it repaints — the fix for "the video freezes
  // when I come back to the same post". Only fires on the transition, so it never
  // nudges during normal scrolling.
  const appActive = useFeedAppActive();
  const wasAppActive = useRef(appActive);
  useEffect(() => {
    const was = wasAppActive.current;
    wasAppActive.current = appActive;
    if (!appActive || was || !player) return; // only the background→foreground edge
    let tries = 0;
    let t: ReturnType<typeof setTimeout> | null = null;
    const kick = (first: boolean) => {
      if (!shouldPlayRef.current || player.playing) return; // paused on purpose, or already going
      try { player.play(); } catch {}
      if (first) { try { player.seekBy(0); } catch {} } // repaint once so we don't resume on a stale frame
      if (tries++ < 3) t = setTimeout(() => kick(false), 150);
    };
    kick(true);
    return () => { if (t) clearTimeout(t); };
  }, [appActive, player]);

  // Don't mount the surface until THIS post's source is loaded — otherwise the
  // fresh view would paint the frame the pooled player still held from its
  // previous post (the cross-post flash). The thumbnail underneath covers the
  // gap. Once mounted, opacity stays 0 until onFirstFrameRender (no frozen view).
  if (!player || !sourceReady) return null;
  return (
    <VideoView
      // Keyed by post id so a scroll-back / recycle always attaches this player
      // to a FRESH native view — a clean layer, never a stale one holding the
      // previous frame.
      key={id}
      style={[StyleSheet.absoluteFill, !ready && styles.hidden]}
      player={player}
      contentFit="cover"
      nativeControls={false}
      // iOS 16+ floats a "Live Text" button over detected text — keep tiles clean.
      allowsVideoFrameAnalysis={false}
      // Hide the poster ONLY once the surface has actually painted a frame from
      // this player — not merely when data is ready. This is the fix for "audio
      // plays but the video is a frozen frame" when a pooled player is reused on
      // scroll-back: we never reveal an unpainted (frozen/black) surface.
      onFirstFrameRender={() => { clearRevealTimer(); setReady(true); }}
    />
  );
});

const styles = StyleSheet.create({ hidden: { opacity: 0 } });

export default FeedVideo;
