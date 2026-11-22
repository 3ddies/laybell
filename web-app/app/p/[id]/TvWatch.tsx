'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { streamIframeSrc } from '@/lib/format';
import { browserSb } from '@/lib/supabaseBrowser';
import { fetchTvPrerollAd, recordWebTvAdEvent, adSkipAfterMs, type WebTvAd } from '@/lib/ads';
import { loadStreamSdk } from '@/lib/streamSdk';

// Laybell TV "watch" player for videos that qualify for a pre-roll (landscape +
// over 2 min — the gate is decided server-side; this component is only mounted
// for those). It mirrors YouTube on the web: the video starts PAUSED behind a
// poster + play button so the first click is a real user gesture (autoplay-with-
// sound policy), and that click plays a pre-roll ad — if any eligible ad exists —
// before revealing the video. No inventory → clicking plays the video directly.
//
// State machine: 'idle' (poster + play) → 'ad' (sponsor plays) → 'video'. Skip
// timing, the +20% TV billing, and the record_ad_event path all match the app.

type Phase = 'idle' | 'ad' | 'video';

export default function TvWatch({
  src, thumb, initialAr, title,
}: {
  src: string; thumb?: string | null; initialAr: number; title?: string;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [ar, setAr] = useState(initialAr);
  const [ad, setAd] = useState<WebTvAd | null>(null);
  const [starting, setStarting] = useState(false); // play tapped, waiting on the ad prefetch

  // Ad playback UI state.
  const [adMuted, setAdMuted] = useState(false);
  const [skippable, setSkippable] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [durationSec, setDurationSec] = useState(0);

  // Prefetch bookkeeping: the ad query is kicked off on mount so it's usually
  // resolved by the time the viewer clicks play. `undefined` = still loading.
  const adPromiseRef = useRef<Promise<WebTvAd | null> | null>(null);
  const adResolvedRef = useRef<WebTvAd | null | undefined>(undefined);
  const viewerRef = useRef<string | null>(null);
  const adIframeRef = useRef<HTMLIFrameElement | null>(null);
  const playerRef = useRef<any>(null);

  // Correct the frame to the clip's TRUE aspect from the Stream thumbnail (same
  // trick as StreamPlayer) so there are never letterbox bars.
  useEffect(() => {
    if (!thumb) return;
    let alive = true;
    const img = new Image();
    img.onload = () => { if (alive && img.naturalWidth > 0 && img.naturalHeight > 0) setAr(img.naturalWidth / img.naturalHeight); };
    img.src = thumb;
    return () => { alive = false; };
  }, [thumb]);

  // On mount: resolve the viewer (for billing) and prefetch one eligible ad.
  useEffect(() => {
    const db = browserSb();
    db.auth.getSession().then(({ data }) => { viewerRef.current = data.session?.user?.id ?? null; }).catch(() => {});
    const p = fetchTvPrerollAd(db).then((a) => { adResolvedRef.current = a; return a; });
    adPromiseRef.current = p;
  }, []);

  // Play tapped on the idle poster. We now have a user gesture. Use the prefetched
  // ad if ready, else wait briefly for it, then branch to 'ad' or 'video'.
  const onPlay = useCallback(async () => {
    if (phase !== 'idle' || starting) return;
    setStarting(true);
    let a = adResolvedRef.current;
    if (a === undefined) {
      a = await Promise.race([
        adPromiseRef.current ?? Promise.resolve(null),
        new Promise<null>((r) => setTimeout(() => r(null), 1200)),
      ]);
    }
    if (a) { setAd(a); setPhase('ad'); }
    else setPhase('video');
    setStarting(false);
  }, [phase, starting]);

  // Advance from the ad to the video, recording the terminal event once.
  const finishedRef = useRef(false);
  const finishAd = useCallback((kind: 'skip' | 'complete') => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    if (ad) recordWebTvAdEvent(browserSb(), ad, kind, viewerRef.current);
    setPhase('video');
  }, [ad]);

  // Drive the ad through the Stream SDK: reveal/skip timing, impression on first
  // genuine play, complete on end. Degrades to "play fully, then video" if the
  // SDK or an event never fires.
  useEffect(() => {
    if (phase !== 'ad' || !ad) return;
    const skipGateMs = adSkipAfterMs(ad.skipMode);
    let player: any = null;
    let cancelled = false;
    let started = false;
    let impressed = false;

    // Safety net: if the SDK never loads / 'ended' never fires, don't trap the
    // viewer on the ad forever — after the creative's own length (or 45s) move on.
    const hardStop = setTimeout(() => { if (!cancelled) finishAd('complete'); }, 45_000);

    const onPlaying = () => {
      if (cancelled) return;
      started = true;
      clearTimeout(watchdog);
      if (!impressed) { impressed = true; recordWebTvAdEvent(browserSb(), ad, 'impression', viewerRef.current); }
      try { player.muted = false; setAdMuted(false); } catch { /* ignore */ }
    };
    const onTime = () => {
      if (cancelled || !player) return;
      const t = (player.currentTime || 0) * 1000;
      const d = player.duration || 0;
      setElapsedMs(t);
      setDurationSec(d);
      if (skipGateMs !== Infinity && t >= skipGateMs) setSkippable(true);
    };
    const onEnded = () => { if (!cancelled) finishAd('complete'); };

    // If the ad hasn't started within 2.5s (unmuted autoplay blocked), mute and
    // retry so it can never freeze on a dead frame; a pill lets them re-enable sound.
    const watchdog = setTimeout(() => {
      if (cancelled || started || !player) return;
      try { player.muted = true; setAdMuted(true); player.play?.(); } catch { /* ignore */ }
    }, 2500);

    loadStreamSdk().then((Stream) => {
      if (cancelled || !Stream || !adIframeRef.current) return;
      player = Stream(adIframeRef.current);
      playerRef.current = player;
      player.addEventListener('playing', onPlaying);
      player.addEventListener('timeupdate', onTime);
      player.addEventListener('ended', onEnded);
    });

    return () => {
      cancelled = true;
      clearTimeout(hardStop);
      clearTimeout(watchdog);
      try {
        player?.removeEventListener('playing', onPlaying);
        player?.removeEventListener('timeupdate', onTime);
        player?.removeEventListener('ended', onEnded);
      } catch { /* ignore */ }
      playerRef.current = null;
    };
  }, [phase, ad, finishAd]);

  const onCta = () => {
    if (!ad?.ctaUrl) return;
    recordWebTvAdEvent(browserSb(), ad, 'click', viewerRef.current);
    window.open(ad.ctaUrl, '_blank', 'noopener,noreferrer');
  };
  const unmute = () => { try { playerRef.current.muted = false; setAdMuted(false); } catch { /* ignore */ } };

  const frameStyle = { ['--ar' as any]: ar };

  if (phase === 'idle') {
    return (
      <div className="watch-player" style={frameStyle}>
        <button className="watch-idle" onClick={onPlay} aria-label="Play video" disabled={starting}>
          {thumb ? <img src={thumb} alt="" /> : null}
          <span className="watch-play">
            <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
          </span>
        </button>
      </div>
    );
  }

  if (phase === 'ad' && ad) {
    const adBase = streamIframeSrc(ad.mediaUrl, ad.thumbUrl);
    const adSrc = adBase ? `${adBase}&autoplay=true&controls=false&muted=false` : null;
    const skipGateMs = adSkipAfterMs(ad.skipMode);
    const skipInS = Math.max(0, Math.ceil((skipGateMs - elapsedMs) / 1000));
    const remainingS = durationSec > 0 ? Math.max(0, Math.ceil(durationSec - elapsedMs / 1000)) : 0;
    return (
      <div className="watch-player tvad-frame" style={frameStyle}>
        {adSrc ? (
          <iframe
            ref={adIframeRef} className="tvad-iframe" src={adSrc}
            allow="autoplay; encrypted-media; fullscreen" title="Sponsored" tabIndex={-1}
          />
        ) : null}

        <div className="tvad-badge">
          <span className="tvad-tag">Ad</span>
          {ad.advertiserName ? <span className="tvad-adv">{ad.advertiserName}</span> : null}
        </div>

        {adMuted ? (
          <button className="tvad-unmute" onClick={unmute}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 00-2.5-4v8a4.5 4.5 0 002.5-4z" /></svg>
            Tap for sound
          </button>
        ) : null}

        {ad.ctaUrl ? <button className="tvad-cta" onClick={onCta}>{ad.ctaLabel}</button> : null}

        <div className="tvad-skip">
          {skipGateMs === Infinity ? (
            <span className="tvad-count">Ad{remainingS ? ` · ${remainingS}s` : ''}</span>
          ) : skippable ? (
            <button className="tvad-skipbtn" onClick={() => finishAd('skip')}>
              Skip Ad
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" /></svg>
            </button>
          ) : (
            <span className="tvad-count">Skip in {skipInS}s</span>
          )}
        </div>
      </div>
    );
  }

  // 'video' — the real clip, autoplaying (we still hold the play-click activation).
  return (
    <div className="watch-player" style={frameStyle}>
      <iframe
        src={`${src}&autoplay=true`} loading="lazy"
        allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture;"
        allowFullScreen title={title || 'Laybell video'}
      />
    </div>
  );
}
