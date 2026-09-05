import { supabase } from './supabase';
import { maskHiddenProfile } from './hiddenProfile';
import { parseAttachment } from './attachments';

// The most relevant comments on a post, for surfaces that show a FEW rather than
// all of them — currently the square song card in the feed, which floats them up
// over the artwork.
//
// The ranking lives here, not in the comments screen, because both now order the
// same comments and two copies of a scoring formula drift. Comments.tsx imports
// rankTopLevelIds from here.

export type TopComment = {
  id: string;
  name: string;
  avatarUrl: string | null;
  /** The comment's words. Empty when it is nothing but an attachment. */
  text: string;
  /** Set when the comment IS a gif — the card shows it playing. */
  gifUrl: string | null;
  /** An image attachment rather than a gif; shown as a marker, not rendered. */
  isImage: boolean;
};

/**
 * Rank TOP-LEVEL comments most-relevant-first. Blends likes, reply count, like
 * velocity (likes earned per hour since posting — "recency to the amount of
 * likes received"), and a gentle recency baseline so unengaged comments fall
 * newest-first and ties break by recency. Computed once per load (snapshot), so
 * an optimistic like never reshuffles the list under the reader. Returns
 * ordered ids.
 */
export function rankTopLevelIds(comments: any[], likeCounts: Record<string, number>): string[] {
  const now = Date.now();
  const replyCount: Record<string, number> = {};
  for (const c of comments) if (c.parent_id) replyCount[c.parent_id] = (replyCount[c.parent_id] || 0) + 1;
  const score = (c: any) => {
    const likes = likeCounts[c.id] || 0;
    const replies = replyCount[c.id] || 0;
    const ageH = Math.max(0, (now - (Date.parse(c.created_at) || now)) / 3_600_000);
    const recency = 1 / Math.pow(ageH + 2, 0.6); // ~0.66 when fresh, decays with age
    const velocity = likes / (ageH + 1);         // fast-liked comments rank higher
    return likes * 2.5 + replies * 2 + velocity * 3 + recency * 1.5;
  };
  return comments
    .filter((c) => !c.parent_id)
    .sort((a, b) => score(b) - score(a) || (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0))
    .map((c) => c.id);
}

// Cached with a short life rather than for the session: a song card can sit in a
// feed for a long time, and comments are the thing on it most likely to change
// while it does. Long enough that scrolling past the same card repeatedly costs
// one query, short enough that a new comment shows up without a restart.
const TTL_MS = 3 * 60_000;
const cache = new Map<string, { at: number; rows: TopComment[] }>();

export function clearTopCommentsCache(): void {
  cache.clear();
}

/** The top `limit` comments on a post. Returns [] on any failure — this feeds a
 *  decorative overlay, and it must never be the reason a card fails to draw. */
export async function fetchTopComments(postId: string, limit = 3): Promise<TopComment[]> {
  const hit = cache.get(postId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;

  try {
    const { data: comments } = await supabase
      .from('comments')
      .select('id, body, created_at, user_id, parent_id, profiles!comments_user_id_fkey(username, display_name, avatar_url, hidden)')
      .eq('post_id', postId)
      // A cap, because this runs for cards in a scrolling feed. Ranking wants the
      // whole set to count replies properly, but a post with thousands of
      // comments does not need all of them to decide the top three.
      .limit(300);
    if (!comments || comments.length === 0) {
      cache.set(postId, { at: Date.now(), rows: [] });
      return [];
    }

    const counts: Record<string, number> = {};
    const { data: likes } = await supabase
      .from('comment_likes')
      .select('comment_id')
      .in('comment_id', comments.map((c: any) => c.id));
    (likes ?? []).forEach((l: any) => { counts[l.comment_id] = (counts[l.comment_id] || 0) + 1; });

    const byId = new Map<string, any>(comments.map((c: any) => [c.id, c]));
    const rows: TopComment[] = [];
    for (const id of rankTopLevelIds(comments, counts)) {
      const c = byId.get(id);
      if (!c) continue;
      // Hidden accounts read as "Hidden account" with no avatar, exactly as they
      // do in the comments screen — this must not become the one surface that
      // still shows a hidden person's name and face.
      const p = maskHiddenProfile(c.profiles);
      const att = parseAttachment(c.body ?? '');
      const text = (att ? att.text : (c.body ?? '')).trim();
      // Nothing to show at all — no words, no attachment — is not worth a bubble.
      if (!text && !att) continue;
      rows.push({
        id: c.id,
        name: p?.display_name || p?.username || '',
        avatarUrl: p?.avatar_url ?? null,
        text,
        gifUrl: att?.type === 'gif' ? att.url : null,
        isImage: att?.type === 'image',
      });
      if (rows.length >= limit) break;
    }

    cache.set(postId, { at: Date.now(), rows });
    return rows;
  } catch {
    return [];
  }
}
