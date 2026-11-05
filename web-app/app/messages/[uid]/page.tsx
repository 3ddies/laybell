'use client';
import { useEffect, useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { browserSb } from '@/lib/supabaseBrowser';
import { initial } from '@/lib/format';

type Msg = { id: string; sender_id: string; receiver_id: string | null; body: string; created_at: string };
type Prof = { id: string; username: string; display_name: string | null; avatar_url: string | null };

function parseBody(body: string): { media: string | null; text: string } {
  if (body && body.startsWith('laybell://attach?')) {
    try { const u = new URLSearchParams(body.split('?')[1]); return { media: u.get('url'), text: '' }; }
    catch { return { media: null, text: '' }; }
  }
  return { media: null, text: body };
}

export default function ThreadPage({ params }: { params: { uid: string } }) {
  const other = params.uid;
  const sb = browserSb();
  const router = useRouter();
  const [me, setMe] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [prof, setProf] = useState<Prof | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async (meId: string) => {
    const { data } = await sb.from('messages').select('id,sender_id,receiver_id,body,created_at').is('conversation_id', null)
      .or(`and(sender_id.eq.${meId},receiver_id.eq.${other}),and(sender_id.eq.${other},receiver_id.eq.${meId})`)
      .order('created_at', { ascending: true }).limit(500);
    setMsgs((data || []) as Msg[]);
  }, [sb, other]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    (async () => {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { router.replace('/login'); return; }
      const meId = session.user.id;
      if (!alive) return;
      setMe(meId);
      const { data: p } = await sb.from('profiles').select('id,username,display_name,avatar_url').eq('id', other).maybeSingle();
      if (!alive) return;
      setProf(p as Prof);
      await load(meId);
      if (!alive) return;
      setReady(true);
      timer = setInterval(() => load(meId), 4000); // poll — messages realtime publication isn't assumed
    })();
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [sb, router, other, load]);

  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }, [msgs]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body || !me || sending) return;
    setSending(true);
    const optimistic: Msg = { id: 'tmp-' + Date.now(), sender_id: me, receiver_id: other, body, created_at: new Date().toISOString() };
    setMsgs((m) => [...m, optimistic]);
    setText('');
    try { await sb.from('messages').insert({ sender_id: me, receiver_id: other, body }); await load(me); }
    catch { setMsgs((m) => m.filter((x) => x.id !== optimistic.id)); }
    finally { setSending(false); }
  }

  const name = prof?.display_name || prof?.username;
  return (
    <div className="thread">
      <div className="thread-head">
        <Link href="/messages" className="navlink" style={{ padding: '6px 8px', fontSize: 20 }} aria-label="Back">‹</Link>
        <Link href={prof ? `/@${prof.username}` : '#'} className="ca">{prof?.avatar_url ? <img src={prof.avatar_url} alt="" /> : initial(name, prof?.username)}</Link>
        <Link href={prof ? `/@${prof.username}` : '#'}><b style={{ fontFamily: 'var(--f-display)' }}>@{prof?.username || 'user'}</b></Link>
      </div>
      <div className="thread-body" ref={bodyRef}>
        {!ready ? <div className="feed-empty">Loading…</div>
          : msgs.length ? msgs.map((m) => {
            const pb = parseBody(m.body);
            const mine = m.sender_id === me;
            return <div key={m.id} className={`bub ${mine ? 'me' : 'them'}`}>{pb.text || null}{pb.media ? <img src={pb.media} alt="" /> : null}</div>;
          }) : <div className="feed-empty">No messages yet. Say hi 👋</div>}
      </div>
      <form className="thread-input" onSubmit={send}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Message…" maxLength={2000} />
        <button type="submit" disabled={sending || !text.trim()}>Send</button>
      </form>
    </div>
  );
}
