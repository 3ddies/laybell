'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { browserSb } from '@/lib/supabaseBrowser';

type Me = { username?: string; avatar_url?: string | null; display_name?: string | null };

export default function AuthNav() {
  const sb = browserSb();
  const [state, setState] = useState<'loading' | 'out' | 'in'>('loading');
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    let active = true;
    async function load(uid?: string) {
      if (!uid) { if (active) { setState('out'); setMe(null); } return; }
      const { data } = await sb.from('profiles').select('username,avatar_url,display_name').eq('id', uid).maybeSingle();
      if (active) { setMe(data as Me); setState('in'); }
    }
    sb.auth.getSession().then(({ data }) => load(data.session?.user?.id));
    const { data: sub } = sb.auth.onAuthStateChange((_e, session) => load(session?.user?.id));
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, [sb]);

  if (state === 'loading') return null;
  if (state === 'out') return <Link className="navlink" href="/login">Log in</Link>;

  const letter = (me?.display_name || me?.username || '?').charAt(0).toUpperCase();
  return (
    <>
      <Link className="navlink" href="/home">Home</Link>
      <Link className="navlink" href="/create">Create</Link>
      <Link className="navlink" href="/messages">Messages</Link>
      <Link className="navlink" href="/purchases">Purchases</Link>
      {me?.username ? (
        <Link href={`/@${me.username}`} className="navav" title={`@${me.username}`}>
          {me.avatar_url ? <img src={me.avatar_url} alt="" /> : letter}
        </Link>
      ) : null}
      <button className="navlink" style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => sb.auth.signOut()}>Log out</button>
    </>
  );
}
