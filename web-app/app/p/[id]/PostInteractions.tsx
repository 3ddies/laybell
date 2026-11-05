'use client';
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { browserSb } from '@/lib/supabaseBrowser';
import { formatCount, timeAgo, initial } from '@/lib/format';

type Comment = { id: string; user_id: string; body: string; created_at: string };
type Author = { id: string; username: string; display_name: string | null; avatar_url: string | null };

// Comments can carry a GIF/image via the app's attach encoding; render the media
// instead of the raw URL.
function parseBody(body: string): { media: string | null; text: string } {
  if (body && body.startsWith('laybell://attach?')) {
    try { const u = new URLSearchParams(body.split('?')[1]); return { media: u.get('url'), text: '' }; }
    catch { return { media: null, text: '' }; }
  }
  return { media: null, text: body };
}

export default function PostInteractions({ postId, initialLikes, initialComments }: { postId: string; initialLikes: number | null; initialComments: number | null }) {
  const sb = browserSb();
  const [uid, setUid] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(initialLikes || 0);
  const [cCount, setCCount] = useState(initialComments || 0);
  const [comments, setComments] = useState<Comment[]>([]);
  const [authors, setAuthors] = useState<Record<string, Author>>({});
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: { session } } = await sb.auth.getSession();
      const me = session?.user?.id ?? null;
      setUid(me);
      const [cRes, lRes] = await Promise.all([
        sb.from('comments').select('id,user_id,body,created_at').eq('post_id', postId).is('parent_id', null).order('created_at', { ascending: false }).limit(50),
        me ? sb.from('likes').select('post_id').eq('user_id', me).eq('post_id', postId).maybeSingle() : Promise.resolve({ data: null } as any),
      ]);
      const cs = (cRes.data || []) as Comment[];
      setComments(cs);
      setLiked(!!lRes.data);
      const ids = Array.from(new Set(cs.map((c) => c.user_id)));
      if (ids.length) {
        const { data: profs } = await sb.from('profiles').select('id,username,display_name,avatar_url').in('id', ids);
        const am: Record<string, Author> = {}; (profs || []).forEach((a: any) => (am[a.id] = a)); setAuthors(am);
      }
      setReady(true);
    })();
  }, [sb, postId]);

  const toggleLike = useCallback(async () => {
    if (!uid) return;
    const was = liked;
    setLiked(!was); setLikeCount((c) => c + (was ? -1 : 1));
    try {
      if (was) await sb.from('likes').delete().eq('post_id', postId).eq('user_id', uid);
      else await sb.from('likes').insert({ post_id: postId, user_id: uid });
    } catch { setLiked(was); setLikeCount((c) => c + (was ? 1 : -1)); }
  }, [uid, liked, sb, postId]);

  async function post(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body || !uid || posting) return;
    setPosting(true);
    try {
      const { data, error } = await sb.from('comments').insert({ post_id: postId, user_id: uid, body }).select('id,user_id,body,created_at').single();
      if (error) throw error;
      setComments((c) => [data as Comment, ...c]);
      setCCount((n) => n + 1);
      setText('');
      if (!authors[uid]) {
        const { data: me } = await sb.from('profiles').select('id,username,display_name,avatar_url').eq('id', uid).maybeSingle();
        if (me) setAuthors((a) => ({ ...a, [uid]: me as Author }));
      }
    } catch { /* keep the text so the user can retry */ } finally { setPosting(false); }
  }

  return (
    <div className="pinteract">
      <div className="likebar">
        <button className={liked ? 'liked' : ''} onClick={toggleLike} disabled={!uid} title={uid ? 'Like' : 'Log in to like'}>
          <svg viewBox="0 0 24 24" fill={liked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2"><path d="M12 21s-7-4.5-9.3-8.3C1.2 10 2.3 6.5 5.5 6c1.9-.3 3.6.8 4.5 2 .9-1.2 2.6-2.3 4.5-2 3.2.5 4.3 4 2.8 6.7C19 16.5 12 21 12 21Z"/></svg>
          {formatCount(likeCount)}
        </button>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: 'var(--muted)', fontWeight: 700 }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="22" height="22"><path d="M21 12a8 8 0 0 1-11.5 7.2L3 21l1.8-6.5A8 8 0 1 1 21 12Z"/></svg>
          {formatCount(cCount)}
        </span>
      </div>

      {!ready ? (
        <div className="cempty">Loading comments…</div>
      ) : comments.length ? (
        <div className="clist">
          {comments.map((c) => {
            const a = authors[c.user_id];
            const pb = parseBody(c.body);
            return (
              <div className="crow" key={c.id}>
                <Link href={a ? `/@${a.username}` : '#'} className="ca">{a?.avatar_url ? <img src={a.avatar_url} alt="" /> : initial(a?.display_name, a?.username)}</Link>
                <div className="cb">
                  <Link href={a ? `/@${a.username}` : '#'} className="ch">@{a?.username || 'user'}</Link>
                  {pb.text ? <div className="ct">{pb.text}</div> : null}
                  {pb.media ? <div className="cm"><img src={pb.media} alt="" /></div> : null}
                  <div className="cd">{timeAgo(c.created_at)}</div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="cempty">No comments yet. Be the first.</div>
      )}

      {uid ? (
        <form className="cinput" onSubmit={post}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a comment…" maxLength={500} />
          <button type="submit" disabled={posting || !text.trim()}>Post</button>
        </form>
      ) : (
        <div className="cloginprompt"><Link href="/login">Log in</Link> to like and comment.</div>
      )}
    </div>
  );
}
