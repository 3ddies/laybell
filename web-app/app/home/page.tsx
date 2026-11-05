'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { browserSb } from '@/lib/supabaseBrowser';
import { formatCount, timeAgo, gradientFor, initial } from '@/lib/format';

type Post = { id: string; user_id: string; type: string | null; caption: string | null; media_url: string | null; thumbnail_url: string | null; cover_url: string | null; like_count: number | null; comment_count: number | null; created_at: string };
type Author = { id: string; username: string; display_name: string | null; avatar_url: string | null };

const AUDIO = new Set(['audio', 'podcast', 'audiobook']);
const VIDEO = new Set(['video', 'reel']);
const COLS = 'id,user_id,type,caption,media_url,thumbnail_url,cover_url,like_count,comment_count,created_at';

export default function HomePage() {
  const sb = browserSb();
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [uid, setUid] = useState<string | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [authors, setAuthors] = useState<Record<string, Author>>({});
  const [liked, setLiked] = useState<Record<string, boolean>>({});
  const [following, setFollowing] = useState<Record<string, boolean>>({});

  useEffect(() => {
    (async () => {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { router.replace('/login'); return; }
      const me = session.user.id;
      setUid(me);

      const { data: fol } = await sb.from('follows').select('following_id').eq('follower_id', me);
      const folIds = (fol || []).map((f: any) => f.following_id as string);
      const folMap: Record<string, boolean> = {}; folIds.forEach((id) => (folMap[id] = true)); setFollowing(folMap);

      // Feed = latest from people you follow; if that's empty (or you're new), fall
      // back to the latest public posts so the page is never blank.
      let q = sb.from('posts').select(COLS).eq('is_public', true).is('archived_at', null).not('mature', 'is', true).order('created_at', { ascending: false }).limit(30);
      if (folIds.length) q = q.in('user_id', folIds);
      let { data: ps } = await q;
      if (!ps || !ps.length) {
        const r = await sb.from('posts').select(COLS).eq('is_public', true).is('archived_at', null).not('mature', 'is', true).order('created_at', { ascending: false }).limit(30);
        ps = r.data;
      }
      const list = (ps || []) as Post[];
      setPosts(list);

      const ids = Array.from(new Set(list.map((p) => p.user_id)));
      const postIds = list.map((p) => p.id);
      const [profsRes, likesRes] = await Promise.all([
        ids.length ? sb.from('profiles').select('id,username,display_name,avatar_url').in('id', ids) : Promise.resolve({ data: [] as any }),
        postIds.length ? sb.from('likes').select('post_id').eq('user_id', me).in('post_id', postIds) : Promise.resolve({ data: [] as any }),
      ]);
      const am: Record<string, Author> = {}; (profsRes.data || []).forEach((a: any) => (am[a.id] = a)); setAuthors(am);
      const lm: Record<string, boolean> = {}; (likesRes.data || []).forEach((l: any) => (lm[l.post_id] = true)); setLiked(lm);
      setReady(true);
    })();
  }, [sb, router]);

  const toggleLike = useCallback(async (p: Post) => {
    if (!uid) return;
    const was = !!liked[p.id];
    setLiked((s) => ({ ...s, [p.id]: !was }));
    setPosts((s) => s.map((x) => (x.id === p.id ? { ...x, like_count: (x.like_count || 0) + (was ? -1 : 1) } : x)));
    try {
      if (was) await sb.from('likes').delete().eq('post_id', p.id).eq('user_id', uid);
      else await sb.from('likes').insert({ post_id: p.id, user_id: uid });
    } catch {
      setLiked((s) => ({ ...s, [p.id]: was }));
      setPosts((s) => s.map((x) => (x.id === p.id ? { ...x, like_count: (x.like_count || 0) + (was ? 1 : -1) } : x)));
    }
  }, [uid, liked, sb]);

  const toggleFollow = useCallback(async (authorId: string) => {
    if (!uid || authorId === uid) return;
    const was = !!following[authorId];
    setFollowing((s) => ({ ...s, [authorId]: !was }));
    try {
      if (was) await sb.from('follows').delete().eq('follower_id', uid).eq('following_id', authorId);
      else await sb.from('follows').insert({ follower_id: uid, following_id: authorId });
    } catch {
      setFollowing((s) => ({ ...s, [authorId]: was }));
    }
  }, [uid, following, sb]);

  if (!ready) return <main className="feed"><div className="feed-empty">Loading your feed…</div></main>;
  if (!posts.length) return <main className="feed"><div className="feed-empty">Nothing to show yet. Follow some artists to fill your feed.</div></main>;

  return (
    <main className="feed">
      {posts.map((p) => {
        const a = authors[p.user_id];
        const isAudio = p.type ? AUDIO.has(p.type) : false;
        const isVideo = p.type ? VIDEO.has(p.type) : false;
        const img = p.cover_url || p.thumbnail_url || p.media_url;
        return (
          <article className="fcard" key={p.id}>
            <div className="fhead">
              <Link href={a ? `/@${a.username}` : '#'} className="mini-av">{a?.avatar_url ? <img src={a.avatar_url} alt="" /> : initial(a?.display_name, a?.username)}</Link>
              <div style={{ minWidth: 0 }}>
                <Link href={a ? `/@${a.username}` : '#'} className="nm">@{a?.username || 'user'}</Link>
                <div className="tm">{timeAgo(p.created_at)}</div>
              </div>
              {a && a.id !== uid ? (
                <button className={`btn ${following[a.id] ? 'btn-ghost' : 'btn-primary'} followbtn`} style={{ marginLeft: 'auto' }} onClick={() => toggleFollow(a.id)}>
                  {following[a.id] ? 'Following' : 'Follow'}
                </button>
              ) : null}
            </div>
            <div className="fmedia" style={!img || isAudio ? { background: gradientFor(p.id) } : undefined}>
              {isAudio ? (
                <>{p.cover_url ? <img src={p.cover_url} alt="" style={{ opacity: 0.92 }} /> : null}{p.media_url ? <audio className="aud" src={p.media_url} controls preload="none" /> : null}</>
              ) : isVideo ? (
                <video src={p.media_url || undefined} poster={p.thumbnail_url || p.cover_url || undefined} controls playsInline preload="none" />
              ) : p.media_url ? (
                <img src={p.media_url} alt={p.caption || ''} />
              ) : null}
            </div>
            <div className="factions">
              <button className={liked[p.id] ? 'liked' : ''} onClick={() => toggleLike(p)} aria-label="Like">
                <svg viewBox="0 0 24 24" fill={liked[p.id] ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2"><path d="M12 21s-7-4.5-9.3-8.3C1.2 10 2.3 6.5 5.5 6c1.9-.3 3.6.8 4.5 2 .9-1.2 2.6-2.3 4.5-2 3.2.5 4.3 4 2.8 6.7C19 16.5 12 21 12 21Z"/></svg>
                {formatCount(p.like_count)}
              </button>
              <Link href={`/p/${p.id}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontWeight: 700 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="23" height="23"><path d="M21 12a8 8 0 0 1-11.5 7.2L3 21l1.8-6.5A8 8 0 1 1 21 12Z"/></svg>
                {formatCount(p.comment_count)}
              </Link>
            </div>
            {p.caption ? <div className="fcap"><b>@{a?.username} </b>{p.caption}</div> : null}
          </article>
        );
      })}
    </main>
  );
}
