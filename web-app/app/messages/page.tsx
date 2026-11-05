'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { browserSb } from '@/lib/supabaseBrowser';
import { timeAgo, initial } from '@/lib/format';

type Msg = { id: string; sender_id: string; receiver_id: string | null; body: string; created_at: string };
type Prof = { id: string; username: string; display_name: string | null; avatar_url: string | null };

function preview(body: string) { return body && body.startsWith('laybell://attach') ? 'Attachment' : body; }

export default function MessagesPage() {
  const sb = browserSb();
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [uid, setUid] = useState<string | null>(null);
  const [convs, setConvs] = useState<{ other: string; last: Msg }[]>([]);
  const [profs, setProfs] = useState<Record<string, Prof>>({});

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { router.replace('/login'); return; }
      const me = session.user.id;
      if (!alive) return;
      setUid(me);
      // 1:1 DMs: messages with no conversation_id, where I'm the sender or receiver.
      const { data } = await sb.from('messages').select('id,sender_id,receiver_id,body,created_at')
        .is('conversation_id', null).or(`sender_id.eq.${me},receiver_id.eq.${me}`)
        .order('created_at', { ascending: false }).limit(300);
      const seen = new Set<string>();
      const list: { other: string; last: Msg }[] = [];
      for (const m of (data || []) as Msg[]) {
        const other = m.sender_id === me ? (m.receiver_id || '') : m.sender_id;
        if (!other || seen.has(other)) continue;
        seen.add(other);
        list.push({ other, last: m });
      }
      if (!alive) return;
      setConvs(list);
      const ids = list.map((c) => c.other);
      if (ids.length) {
        const { data: ps } = await sb.from('profiles').select('id,username,display_name,avatar_url').in('id', ids);
        const pm: Record<string, Prof> = {}; (ps || []).forEach((p: any) => (pm[p.id] = p));
        if (alive) setProfs(pm);
      }
      if (alive) setReady(true);
    })();
    return () => { alive = false; };
  }, [sb, router]);

  if (!ready) return <main className="msgs"><h1>Messages</h1><div className="feed-empty">Loading…</div></main>;
  return (
    <main className="msgs">
      <h1>Messages</h1>
      {convs.length ? (
        <div className="convlist">
          {convs.map((c) => {
            const p = profs[c.other];
            return (
              <Link key={c.other} href={`/messages/${c.other}`} className="conv">
                <div className="ca">{p?.avatar_url ? <img src={p.avatar_url} alt="" /> : initial(p?.display_name, p?.username)}</div>
                <div className="cx"><b>@{p?.username || 'user'}</b><span>{c.last.sender_id === uid ? 'You: ' : ''}{preview(c.last.body)}</span></div>
                <div className="ct">{timeAgo(c.last.created_at)}</div>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="feed-empty">No conversations yet. Start one from someone’s profile in the app.</div>
      )}
    </main>
  );
}
