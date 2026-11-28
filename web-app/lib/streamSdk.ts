// Cloudflare Stream Player SDK loader — one shared copy. Lets a page learn when
// a Stream iframe is ACTUALLY playing (so we never reveal a frozen buffering
// frame), read currentTime/duration for ad skip countdowns, and toggle mute.
// Resolves null on the server or if the script fails, so every caller must cope
// with no SDK (a graceful "reveal anyway" fallback).
let sdkPromise: Promise<any> | null = null;

export function loadStreamSdk(): Promise<any> {
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
