import { useEffect, useState } from 'react';
import ImageViewerModal from '../components/ImageViewerModal';
import { setImageViewerHandler, type ImageViewerState } from '../lib/imageViewer';

// Hosts the full-screen image/GIF viewer at the app root (via the imageViewer
// bridge) so it renders ABOVE the Now Playing FullWindowOverlay. Opening it inline
// from comments-in-Now-Playing as a <Modal> deadlocks on iOS; `inOverlay` makes
// the viewer use its own FullWindowOverlay instead.
export function ImageViewerProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ImageViewerState>(null);
  useEffect(() => {
    setImageViewerHandler(setState);
    return () => setImageViewerHandler(null);
  }, []);
  return (
    <>
      {children}
      <ImageViewerModal inOverlay state={state} onClose={() => setState(null)} />
    </>
  );
}
