// Helpers for Laybell post links shared inside the app.
// A shared post is sent as a bare post link (https://laybell.app/post/<id>); the
// chat detects that and renders it as a rich, tappable preview card instead of
// raw text.

// If `body` is exactly a single Laybell post link, return its post id; else null.
export function sharedPostId(body: string): string | null {
  const m = body.trim().match(/^(?:https?:\/\/(?:www\.)?laybell\.app\/post\/|laybell:\/\/post\/)([^/?\s]+)$/i);
  return m ? m[1] : null;
}

// Map any Laybell link (https universal link or laybell:// scheme) to an in-app
// route, or null if it's an external link. e.g. https://laybell.app/post/1 → /post/1
export function internalPathFromUrl(url: string): string | null {
  if (url.startsWith('laybell://')) return '/' + url.slice('laybell://'.length);
  const m = url.match(/^https?:\/\/(?:www\.)?laybell\.app(\/[^\s]*)/i);
  return m ? m[1] : null;
}

// ─── Story replies in DMs ──────────────────────────────────────────────────────
// Replying to a story sends ONE message whose first line is a structured link
// (story id + owner + the stillshot URL) and whose remaining lines are the
// user's text. The stillshot URL is embedded ON PURPOSE: story rows expire
// after 24h (and can be deleted), but the chat must keep showing the snapshot
// forever — only tapping it checks live availability.

export type StoryReplyRef = { storyId: string; ownerId: string; thumb: string | null; text: string };

export function storyReplyBody(
  ref: { storyId: string; ownerId: string; thumb?: string | null },
  text: string,
): string {
  const img = ref.thumb ? `?img=${encodeURIComponent(ref.thumb)}` : '';
  return `laybell://story-reply/${ref.storyId}/${ref.ownerId}${img}\n${text}`.trimEnd();
}

// If `body` is a story reply, decode it; else null (regular message).
export function parseStoryReply(body: string): StoryReplyRef | null {
  const nl = body.indexOf('\n');
  const first = (nl === -1 ? body : body.slice(0, nl)).trim();
  const m = first.match(/^laybell:\/\/story-reply\/([^/?\s]+)\/([^/?\s]+)(?:\?img=([^\s]+))?$/i);
  if (!m) return null;
  let thumb: string | null = null;
  try { thumb = m[3] ? decodeURIComponent(m[3]) : null; } catch {}
  return { storyId: m[1], ownerId: m[2], thumb, text: nl === -1 ? '' : body.slice(nl + 1).trim() };
}
