import Link from 'next/link';
import { sb } from '@/lib/supabase';
import { Avatar } from '../components';

export const revalidate = 15; // broadcasts come and go quickly
export const metadata = {
  title: 'Live now',
  description: 'See who is broadcasting live on Laybell right now, and tune in.',
};

const OPEN = 'https://laybell.app/open.html';

type Live = {
  id: string;
  title: string | null;
  host_username: string | null;
  host_display_name: string | null;
  host_avatar_url: string | null;
  member_count: number;
};

async function fetchLives(): Promise<Live[]> {
  try {
    const db = sb();
    // Definer RPC that returns only live, broadcasting sessions (no join codes).
    const { data } = await db.rpc('fetch_live_studio_sessions');
    return (data || []).map((r: Record<string, unknown>) => ({
      id: String(r.id),
      title: (r.title as string) ?? null,
      host_username: (r.host_username as string) ?? null,
      host_display_name: (r.host_display_name as string) ?? null,
      host_avatar_url: (r.host_avatar_url as string) ?? null,
      member_count: Number(r.member_count ?? 0),
    }));
  } catch {
    return [];
  }
}

export default async function LivePage() {
  const lives = await fetchLives();

  return (
    <main className="live-page">
      <div className="wrap">
        <div className="live-head">
          <h1 className="live-h1"><span className="live-dot" />Live now</h1>
          <p className="live-sub">Artists broadcasting on Laybell right now.</p>
        </div>

        {lives.length ? (
          <div className="live-grid">
            {lives.map((s) => (
              <a key={s.id} className="live-card" href={`${OPEN}?p=studio/listen/${s.id}`} target="_blank" rel="noopener noreferrer">
                <div className="live-card-media">
                  <Avatar url={s.host_avatar_url} name={s.host_display_name} handle={s.host_username} size={72} />
                  <span className="live-badge"><span className="live-dot sm" />LIVE</span>
                </div>
                <b className="live-title">{s.title || 'Live session'}</b>
                <span className="live-host">{s.host_display_name || (s.host_username ? `@${s.host_username}` : 'Laybell artist')}</span>
                <span className="live-metacount">{s.member_count} in session</span>
              </a>
            ))}
          </div>
        ) : (
          <div className="live-empty">
            <div className="live-empty-ic"><span className="live-dot" /></div>
            <h2>No one&apos;s live right now</h2>
            <p>When artists go live, their broadcasts show up here. Go live yourself, or open the app to tune in.</p>
            <div className="live-empty-cta">
              <a className="btn btn-primary" href={OPEN} target="_blank" rel="noopener noreferrer">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4M3.5 3.5a12 12 0 0 0 0 17M20.5 3.5a12 12 0 0 1 0 17" /></svg>
                Go live
              </a>
              <Link className="btn btn-ghost" href="/tv">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="2.5" y="5" width="19" height="13" rx="2.5" /><path d="M10 9.3 15 12l-5 2.7z" fill="currentColor" stroke="none" /><path d="M8 21h8" /></svg>
                Browse Laybell TV
              </Link>
            </div>
          </div>
        )}

        <p className="live-note">Tap a broadcast to tune in through the Laybell app. In-browser live playback is on the way.</p>
      </div>
    </main>
  );
}
