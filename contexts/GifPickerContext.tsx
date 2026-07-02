import { useEffect, useState } from 'react';
import GifPickerModal from '../components/GifPickerModal';
import { setGifPickerHandler, type GifPickRequest } from '../lib/gifPicker';

// Hosts the GIF picker at the app root (via the gifPicker bridge) so it renders
// ABOVE the Now Playing FullWindowOverlay. Opening it inline from comments-in-Now-
// Playing as a <Modal> deadlocks on iOS; `inOverlay` makes it use its own
// FullWindowOverlay instead. The selected GIF is handed back to whoever opened it.
export function GifPickerProvider({ children }: { children: React.ReactNode }) {
  const [req, setReq] = useState<GifPickRequest | null>(null);
  useEffect(() => {
    setGifPickerHandler(setReq);
    return () => setGifPickerHandler(null);
  }, []);
  return (
    <>
      {children}
      <GifPickerModal
        inOverlay
        visible={!!req}
        userId={req?.userId ?? null}
        onClose={() => setReq(null)}
        onSelect={(g) => req?.onSelect(g)}
      />
    </>
  );
}
