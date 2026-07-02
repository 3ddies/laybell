// Bridge to the global GIF picker (contexts/GifPickerContext). Rendered at the app
// root so it appears ABOVE the Now Playing FullWindowOverlay — a picker opened
// inline from comments-in-Now-Playing would deadlock as a nested <Modal>.
import type { Gif } from './gifSearch';

export type GifPickRequest = {
  userId: string | null;
  onSelect: (g: Gif & { src?: string }) => void;
};
type Handler = (req: GifPickRequest | null) => void;

let handler: Handler | null = null;
export function setGifPickerHandler(h: Handler | null) { handler = h; }
export function openGifPicker(req: GifPickRequest) { handler?.(req); }
