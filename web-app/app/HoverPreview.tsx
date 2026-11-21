'use client';

import { useEffect, useRef, useState } from 'react';

// Cloudflare Stream Player SDK — loaded once. It lets us (1) learn when the
// preview is ACTUALLY playing, so we only reveal it then (never a frozen
// buffering frame), and (2) unmute it for sound.
let sdkPromise: Promise<any> | null = null;
function loadStreamSdk(): Promise<any> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  const w = window as any;
  if (w.Stream) return Promise.resolve(w.Stream);
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'https://embed.cloudflarestream.com/embed/sdk.latest.js';
      s.async = true;
      s.onload = () => resolve((window as any).Stream || null);
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
  }
  return sdkPromise;
}

// The media box of a Laybell TV card/hero. Shows the thumbnail; on hover it
// mounts a looping Stream preview (after a short delay, like YouTube) but keeps
// it hidden until the video is genuinely playing, then fades it in and unmutes
// it. Leaving unmounts the preview, which stops it.
export default function HoverPreview({ className, bg, thumb, preview }: {
  className: string; bg: string; thumb: string | null; preview: string | null;
}) {
  const [mounted, setMounted] = useState(false); // iframe in the DOM (buffering)
  const [ready, setReady] = useState(false);     // video actually playing → reveal
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const enter = () => {
    if (!preview) return;
    timer.current = setTimeout(() => setMounted(true), 400);
  };
  const leave = () => {
    if (timer.current) clearTimeout(timer.current);
    setMounted(false);
    setReady(false);
  };

  useEffect(() => {
    if (!mounted) return;
    let player: any = null;
    let onPlaying: (() => void) | null = null;
    let cancelled = false;
    // Safety net: reveal anyway if the SDK/event never fires, so a preview can
    // never get stuck invisible.
    const fallback = setTimeout(() => { if (!cancelled) setReady(true); }, 1600);
    loadStreamSdk().then((Stream) => {
      if (cancelled || !Stream || !iframeRef.current) return;
      player = Stream(iframeRef.current);
      onPlaying = () => {
        if (cancelled) return;
        setReady(true); // frames are rolling — safe to show
        // Unmute for sound, but only when the browser allows it (the user has
        // interacted with the page); unmuting without that would PAUSE the
        // preview, reintroducing a frozen frame.
        try {
          const ua = (navigator as any).userActivation;
          if (ua && ua.hasBeenActive) player.muted = false;
        } catch { /* ignore */ }
      };
      player.addEventListener('playing', onPlaying);
    });
    return () => {
      cancelled = true;
      clearTimeout(fallback);
      try { if (player && onPlaying) player.removeEventListener('playing', onPlaying); } catch { /* ignore */ }
    };
  }, [mounted]);

  return (
    <div className={className} style={{ background: bg }} onMouseEnter={enter} onMouseLeave={leave}>
      {thumb ? <img src={thumb} alt="" loading="lazy" /> : null}
      {mounted && preview ? (
        <iframe
          ref={iframeRef}
          className={`tv-preview${ready ? ' ready' : ''}`}
          src={preview}
          allow="autoplay"
          tabIndex={-1}
          aria-hidden="true"
          title=""
        />
      ) : null}
    </div>
  );
}
