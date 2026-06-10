import { supabase } from './supabase';
import { createNotification } from './createNotification';

// @mentions in post captions and comment bodies. We don't store rich text — the
// raw "@username" stays in the caption/comment; this just DETECTS the mentions
// on create, records them (so the Tagged screen can list them), and notifies the
// mentioned users. Usernames are stored lowercase, so we match case-insensitively.

const MENTION_RE = /@([a-zA-Z0-9_]{2,30})/g;

// --- Autocomplete helpers (caption + comment inputs) ---
// The "@token" currently being typed at the cursor (>=1 char after @), or null.
// Only triggers when @ starts a word (line start or after whitespace).
export function getActiveMentionQuery(text: string, cursor: number): string | null {
  const upto = text.slice(0, Math.max(0, cursor));
  const m = upto.match(/(?:^|\s)@(\w{1,30})$/);
  return m ? m[1] : null;
}

// Replace the active @token at the cursor with "@username " and return the new
// text + caret position (just after the inserted mention).
export function applyMention(text: string, cursor: number, username: string): { text: string; cursor: number } {
  const c = Math.max(0, cursor);
  const upto = text.slice(0, c);
  const m = upto.match(/(?:^|\s)@(\w{1,30})$/);
  if (!m) return { text, cursor: c };
  const start = c - m[1].length - 1; // index of the '@'
  const before = text.slice(0, start);
  const inserted = `@${username} `;
  return { text: before + inserted + text.slice(c), cursor: (before + inserted).length };
}

export function extractMentionUsernames(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text)) !== null) out.add(m[1].toLowerCase());
  return [...out];
}

// Record + notify everyone @mentioned in `text`. Pass exactly one of postId /
// commentId (the host of the mention). Best-effort: failures are swallowed so a
// post/comment never fails to publish because of a mention hiccup.
export async function processMentions(opts: {
  text: string;
  actorId: string;
  postId?: string | null;       // post the mention lives in (caption, or the comment's post)
  commentId?: string | null;    // comment the mention lives in
}): Promise<void> {
  try {
    const usernames = extractMentionUsernames(opts.text || '');
    if (!usernames.length) return;

    const { data: users } = await supabase
      .from('profiles').select('id, username').in('username', usernames);
    if (!users?.length) return;

    for (const u of users) {
      if (u.id === opts.actorId) continue; // don't mention/notify yourself
      await supabase.from('mentions').insert({
        mentioned_user_id: u.id,
        actor_id: opts.actorId,
        post_id: opts.postId ?? null,
        comment_id: opts.commentId ?? null,
      });
      // Mentions in a comment still deep-link to the post that holds the comment.
      createNotification({ userId: u.id, actorId: opts.actorId, type: 'mention', postId: opts.postId ?? null });
    }
  } catch (e) {
    console.log('processMentions:', (e as any)?.message ?? e);
  }
}
