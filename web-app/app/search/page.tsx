import Link from 'next/link';
import type { Metadata } from 'next';
import { sb } from '@/lib/supabase';
import { formatCount, initial } from '@/lib/format';
import { TierBadge } from '../components';

export const dynamic = 'force-dynamic';

export function generateMetadata({ searchParams }: { searchParams: { q?: string } }): Metadata {
  const q = (searchParams.q || '').trim();
  return { title: q ? `Search: ${q}` : 'Search' };
}

export default async function SearchPage({ searchParams }: { searchParams: { q?: string } }) {
  const q = (searchParams.q || '').trim();
  // Strip PostgREST filter-grammar chars so the term can't break out of the ilike.
  const safe = q.replace(/[,()*%\\]/g, ' ').trim().slice(0, 50);

  if (!safe) {
    return (
      <main className="results">
        <div className="state" style={{ marginTop: 60 }}>
          <div className="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m20 20-3-3" /></svg></div>
          <h2>Search Laybell</h2><p>Find artists and communities by name.</p>
        </div>
      </main>
    );
  }

  const db = sb();
  const [profRes, commRes] = await Promise.all([
    db.from('profiles').select('id,username,display_name,avatar_url,badge_tier,badge_show,hidden').or(`username.ilike.%${safe}%,display_name.ilike.%${safe}%`).limit(24),
    db.from('communities').select('id,name,hashtag,member_count').or(`hashtag.ilike.%${safe}%,name.ilike.%${safe}%`).limit(12),
  ]);
  const profiles = (profRes.data || []).filter((p: any) => p.hidden !== true);
  const comms = commRes.data || [];

  return (
    <main className="results">
      <h1 style={{ fontSize: 22, margin: '6px 2px 4px' }}>Results for “{q}”</h1>
      {!profiles.length && !comms.length ? (
        <div className="state" style={{ marginTop: 40 }}><h2>No results</h2><p>Nothing matched “{q}”. Try another name or hashtag.</p></div>
      ) : null}

      {profiles.length ? (
        <>
          <div className="rh">Artists</div>
          {profiles.map((p: any) => {
            const badge = p.badge_show !== false ? p.badge_tier : null;
            const name = p.display_name || p.username;
            return (
              <Link key={p.id} href={`/@${p.username}`} className="rrow">
                <div className="rav">{p.avatar_url ? <img src={p.avatar_url} alt="" /> : initial(name, p.username)}</div>
                <div className="rx"><div className="rn"><b>@{p.username}</b><TierBadge tier={badge} /></div><span>{name}</span></div>
              </Link>
            );
          })}
        </>
      ) : null}

      {comms.length ? (
        <>
          <div className="rh">Communities</div>
          {comms.map((c: any) => (
            <Link key={c.id} href={`/c/${c.hashtag}`} className="rrow">
              <div className="rav tag">#</div>
              <div className="rx"><b>#{c.hashtag}</b><span>{c.name ? c.name + ' · ' : ''}{formatCount(c.member_count ?? 0)} members</span></div>
            </Link>
          ))}
        </>
      ) : null}
    </main>
  );
}
