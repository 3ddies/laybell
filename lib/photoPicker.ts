// Bridge to the in-app photo picker (contexts/PhotoPickerContext). Used instead of
// the native OS picker for comment image attachments: the native picker presents
// BELOW the Now Playing FullWindowOverlay window, so from the expanded player its
// grid is stranded behind the player. Our own picker renders in a FullWindowOverlay
// (above everything, like the GIF picker) while the comments stay put underneath.
import type { Attachment } from './attachments';

export type PhotoPickRequest = {
  userId: string;
  onPicked: (att: Attachment) => void;
};
type Handler = (req: PhotoPickRequest | null) => void;

let handler: Handler | null = null;
export function setPhotoPickerHandler(h: Handler | null) { handler = h; }
export function openPhotoPicker(req: PhotoPickRequest) { handler?.(req); }
