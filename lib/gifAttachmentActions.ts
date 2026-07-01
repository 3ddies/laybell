import type { Attachment } from './attachments';

// Bridge to the polished GIF action sheet (contexts/GifActionSheetContext). Tap
// handlers call openGifAttachment(); the provider registers the handler and shows
// the sheet. Kept as a bridge (not a hook) so the message/comment tap handlers
// don't each have to render their own sheet.
export type GifTapRequest = {
  att: Attachment;
  userId: string | null;
  onView: () => void;
  // Set when the tapped GIF is the viewer's OWN (their comment/message) — adds a
  // "Delete GIF" action that runs onDelete.
  canDelete?: boolean;
  onDelete?: () => void;
};
type Handler = (req: GifTapRequest) => void;

let handler: Handler | null = null;
export function setGifTapHandler(h: Handler | null) { handler = h; }

// Tapping/holding a GIF opens the action sheet when there's something to do beyond
// viewing: a Laybell-made GIF (carrying `src` — the original video post id) can be
// saved / opened at its source / reported, and the viewer's OWN GIF can be deleted.
// Anything else (a plain image, a stranger's Giphy GIF) or a missing provider just
// opens the full-screen viewer.
export function openGifAttachment(
  att: Attachment,
  opts: { userId: string | null; onView: () => void; canDelete?: boolean; onDelete?: () => void },
): void {
  const hasActions = att.type === 'gif' && (!!att.src || !!opts.canDelete);
  if (!hasActions) { opts.onView(); return; }
  if (handler) handler({ att, userId: opts.userId, onView: opts.onView, canDelete: opts.canDelete, onDelete: opts.onDelete });
  else opts.onView();
}
