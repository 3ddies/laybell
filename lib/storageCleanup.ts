import { supabase } from './supabase';

// Deleting a row in `posts`/`stories` (or a profile) only removes the database
// record — the underlying file in Supabase Storage lingers, publicly reachable
// by URL. These helpers delete those objects too, so removed content actually
// disappears from the public buckets. Client-side removal needs the per-user
// Storage DELETE policy in supabase/sql/storage_cleanup.sql; the profile-delete
// trigger in that same file is the server-side backstop for account deletion.

// Reverse a Supabase public Storage URL back to { bucket, path }. Public URLs
// look like:  https://<proj>.supabase.co/storage/v1/object/public/<bucket>/<userId>/<file>
export function bucketPathFromPublicUrl(url: string | null | undefined): { bucket: string; path: string } | null {
  if (!url) return null;
  const marker = '/storage/v1/object/public/';
  const i = url.indexOf(marker);
  if (i === -1) return null;
  const rest = url.slice(i + marker.length);
  const slash = rest.indexOf('/');
  if (slash === -1) return null;
  const bucket = rest.slice(0, slash);
  let path = rest.slice(slash + 1);
  const q = path.indexOf('?');
  if (q !== -1) path = path.slice(0, q);
  try { path = decodeURIComponent(path); } catch {}
  return bucket && path ? { bucket, path } : null;
}

// Best-effort delete of Storage objects given their public URLs. Groups by
// bucket (one remove() call each) and never throws — storage cleanup must not
// block or fail the user-facing delete.
export async function removePublicUrls(urls: (string | null | undefined)[]): Promise<void> {
  const byBucket: Record<string, string[]> = {};
  for (const u of urls) {
    const bp = bucketPathFromPublicUrl(u);
    if (!bp) continue;
    (byBucket[bp.bucket] ||= []).push(bp.path);
  }
  await Promise.all(
    Object.entries(byBucket).map(async ([bucket, paths]) => {
      if (!paths.length) return;
      try { await supabase.storage.from(bucket).remove(paths); } catch {}
    }),
  );
}

// Every Storage URL a post can reference: the main media, its thumbnail and
// cover, plus each slideshow slide's media + thumbnail. legacy_media_url is the
// original Storage MP4 of a video the Stream backfill migrated to HLS
// (supabase/sql/stream_backfill.sql) — without it, deleting a migrated post
// would orphan that MP4 (media_url points at cloudflarestream.com by then,
// which bucketPathFromPublicUrl rightly ignores).
export function collectPostMediaUrls(post: any): string[] {
  const urls: (string | null | undefined)[] = [post?.media_url, post?.thumbnail_url, post?.cover_url, post?.legacy_media_url];
  const slides = Array.isArray(post?.slides) ? post.slides : [];
  for (const s of slides) { urls.push(s?.url); urls.push(s?.thumbnail_url); }
  return urls.filter(Boolean) as string[];
}
