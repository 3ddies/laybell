// Denormalized like_count / comment_count live as columns on `posts` (see
// supabase/sql/post_engagement_counts.sql). The UI and feedScorer already read
// counts as `post.likes?.[0]?.count` / `post.comments?.[0]?.count`, so instead of
// changing every read site, we reshape the columns back into that exact shape
// right after fetching. This lets a query drop the expensive likes(count) /
// comments(count) aggregates with ZERO read-site changes.
//
// Idempotent + safe: if a row still carries the aggregate (a query we haven't
// swapped), it's preserved via the fallback — so it's harmless to apply anywhere.
export function attachEngagementCounts<T extends Record<string, any>>(row: T): T {
  if (!row || typeof row !== 'object') return row;
  return {
    ...row,
    likes: [{ count: row.like_count ?? row.likes?.[0]?.count ?? 0 }],
    comments: [{ count: row.comment_count ?? row.comments?.[0]?.count ?? 0 }],
  };
}

export function attachEngagementCountsAll<T extends Record<string, any>>(rows: T[] | null | undefined): T[] {
  return (rows ?? []).map(attachEngagementCounts);
}
