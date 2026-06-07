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
