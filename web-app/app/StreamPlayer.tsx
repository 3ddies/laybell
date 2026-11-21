'use client';

import { useEffect, useState } from 'react';

// Sizes the video frame to the clip's EXACT aspect ratio so the Cloudflare
// Stream player never has to letterbox (no black bars, ever — vertical stays
// vertical, landscape stays wide). `initialAr` (from posts.aspect_ratio) is the
// SSR guess; once the Stream thumbnail loads we read its true pixel dimensions
// and correct the frame to match the real video.
export default function StreamPlayer({
  src, thumb, initialAr, title, className = 'watch-player',
}: {
  src: string; thumb?: string | null; initialAr: number; title?: string; className?: string;
}) {
  const [ar, setAr] = useState(initialAr);
  useEffect(() => {
    if (!thumb) return;
    let alive = true;
    const img = new Image();
    img.onload = () => {
      if (alive && img.naturalWidth > 0 && img.naturalHeight > 0) setAr(img.naturalWidth / img.naturalHeight);
    };
    img.src = thumb;
    return () => { alive = false; };
  }, [thumb]);

  return (
    <div className={className} style={{ ['--ar' as any]: ar }}>
      <iframe src={src} loading="lazy" allow="accelerometer; gyroscope; encrypted-media; picture-in-picture;" allowFullScreen title={title || 'Laybell video'} />
    </div>
  );
}
