// Bridge to the global full-screen image/GIF viewer (contexts/ImageViewerContext).
// Rendered at the app root so it appears ABOVE the Now Playing FullWindowOverlay
// (a viewer opened inline from comments-in-Now-Playing would deadlock as a Modal).
type Handler = (url: string | null) => void;

let handler: Handler | null = null;
export function setImageViewerHandler(h: Handler | null) { handler = h; }
export function openImageViewer(url: string) { handler?.(url); }
