// Bridge to the global full-screen image/GIF viewer (contexts/ImageViewerContext).
// Rendered at the app root so it appears ABOVE the Now Playing FullWindowOverlay
// (a viewer opened inline from comments-in-Now-Playing would deadlock as a Modal).
export type ImageViewerState = { url: string; circle?: boolean } | null;
type Handler = (state: ImageViewerState) => void;

let handler: Handler | null = null;
export function setImageViewerHandler(h: Handler | null) { handler = h; }

// Full-screen rectangular viewer (post images, comment/DM attachments, GIFs).
export function openImageViewer(url: string) { handler?.({ url }); }

// Avatar viewer — the image is framed in a large circle (matches the round
// profile picture it expands from) instead of filling the screen as a square.
export function openAvatarViewer(url: string) { handler?.({ url, circle: true }); }
