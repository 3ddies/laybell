// Bridge to the comment action sheet (contexts/CommentActionSheetContext). A
// long-press on a comment opens a themed sheet of actions — Reply always, Delete
// for your own comment, Report for someone else's. Kept as a bridge (not a hook)
// so Comments.tsx doesn't have to render its own sheet (which would deadlock
// inside the iOS Now Playing / post overlays).
export type CommentActionRequest = {
  isOwn: boolean;
  onReply: () => void;
  onDelete: () => void;
  onReport: () => void;
};
type Handler = (req: CommentActionRequest) => void;

let handler: Handler | null = null;
export function setCommentActionHandler(h: Handler | null) { handler = h; }

export function openCommentActions(req: CommentActionRequest): void {
  if (handler) handler(req);
}
