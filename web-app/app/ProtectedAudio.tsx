'use client';

// Streams on the web, but with the download affordances removed: controlsList
// drops the native player's ⋮ "Download", and onContextMenu blocks right-click
// "Save audio as". (The URL still lives in the DOM — truly un-grabbable audio
// needs signed/expiring URLs or an HLS audio pipeline; this is the frontend
// ceiling: stream, don't hand out a one-click download.)
export default function ProtectedAudio({ src, className }: { src: string; className?: string }) {
  return (
    <audio
      className={className}
      src={src}
      controls
      controlsList="nodownload noplaybackrate"
      onContextMenu={(e) => e.preventDefault()}
      preload="none"
    />
  );
}
