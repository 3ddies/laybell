import Link from 'next/link';
import { sb } from '@/lib/supabase';
import { gradientFor } from '@/lib/format';
import { PostTile } from '../components';

export const revalidate = 60;
export const metadata = {
  title: 'Discover',
  description: 'Top music, videos and more from across Laybell.',
};

type Track = { id: string; cover: string | null; title: string; artist: string };
type Vid = { id: string; thumb: string | null; title: string; artist: string };

const titleOf = (c?: string | null) => (c || '').split('\n')[0].trim().slice(0, 48) || 'Untitled';
const aspectNum = (s?: string | null) => {
  if (!s) return 0;
  if (s.includes(':')) { const [w, h] = s.split(':').map(Number); return h ? w / h : 0; }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};

// Hard caps so the page stays short no matter how much content exists.
const N_SONGS = 8;
const N_VIDEOS = 6;
const N_MORE = 12; // 4 rows of 3

export default async function DiscoverPage() {
  const db = sb();
  const [songsRes, vidsRes, moreRes] = await Promise.all([
    db.from('posts').select('id,cover_url,thumbnail_url,caption,user_id,like_count')
      .eq('is_public', true).is('archived_at', null).not('mature', 'is', true)
      .in('type', ['audio', 'podcast', 'audiobook'])
      .order('like_count', { ascending: false }).limit(16),
    db.from('posts').select('id,cover_url,thumbnail_url,caption,user_id,like_count,aspect_ratio')
      .eq('is_public', true).is('archived_at', null).not('mature', 'is', true)
      .in('type', ['video', 'reel', 'film'])
      .order('like_count', { ascending: false }).limit(18),
    db.from('posts').select('id,type,media_url,thumbnail_url,cover_url,like_count,comment_count,user_id')
      .eq('is_public', true).is('archived_at', null).not('mature', 'is', true)
      .order('created_at', { ascending: false }).limit(28),
  ]);
  const songsRaw = (songsRes.data || []) as Record<string, any>[];
  const vidsRaw = ((vidsRes.data || []) as Record<string, any>[]).filter((p) => aspectNum(p.aspect_ratio) > 1);
  const moreRaw = (moreRes.data || []) as Record<string, any>[];

  // profiles.hidden isn't enforced by RLS — fetch all involved authors once,
  // keep only visible ones, and drop any content by a hidden author.
  const ids = Array.from(new Set([...songsRaw, ...vidsRaw, ...moreRaw].map((p) => p.user_id).filter(Boolean)));
  const artist: Record<string, string> = {};
  const visible = new Set<string>();
  if (ids.length) {
    const { data: ps } = await db.from('profiles').select('id,username,display_name,hidden').in('id', ids);
    (ps || []).forEach((p: any) => {
      if (!p.hidden) { visible.add(p.id); artist[p.id] = p.display_name || (p.username ? `@${p.username}` : 'Artist'); }
    });
  }
  const ok = (p: Record<string, any>) => p.user_id && visible.has(p.user_id);

  const songs: Track[] = songsRaw.filter(ok).slice(0, N_SONGS)
    .map((p) => ({ id: p.id, cover: p.cover_url || p.thumbnail_url || null, title: titleOf(p.caption), artist: artist[p.user_id] }));
  const vids: Vid[] = vidsRaw.filter(ok).slice(0, N_VIDEOS)
    .map((p) => ({ id: p.id, thumb: p.thumbnail_url || p.cover_url || null, title: titleOf(p.caption), artist: artist[p.user_id] }));
  const shown = new Set<string>([...songs.map((s) => s.id), ...vids.map((v) => v.id)]);
  const more = moreRaw.filter(ok).filter((p) => !shown.has(p.id)).slice(0, N_MORE);

  const coverImg = (c: string | null) => (c ? <img src={c} alt="" loading="lazy" /> : null);

  if (!songs.length && !vids.length && !more.length) {
    return <main className="wrap music-page"><h1 className="mus-h1">Discover</h1><div className="feed-empty">Nothing to show yet. Check back soon.</div></main>;
  }

  return (
    <main className="wrap music-page discover-page">
      <h1 className="mus-h1">Discover</h1>
      <p className="mus-sub">Top music, videos, and more from across Laybell.</p>

      {songs.length ? (
        <section className="music-sec">
          <h2>Top songs</h2>
          <Link href={`/p/${songs[0].id}`} className="mus-hero">
            <div className="mus-hero-cover" style={{ background: gradientFor(songs[0].id) }}>
              {coverImg(songs[0].cover)}
              <span className="mus-hero-play" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg></span>
            </div>
            <div className="mus-hero-info">
              <span className="mus-kicker">Top song</span>
              <div className="mus-hero-title">{songs[0].title}</div>
              <span className="mus-hero-artist">{songs[0].artist}</span>
            </div>
          </Link>
          {songs.length > 1 ? (
            <div className="shelf">
              {songs.slice(1).map((t) => (
                <Link key={t.id} href={`/p/${t.id}`} className="album">
                  <div className="cover" style={{ background: gradientFor(t.id) }}>{coverImg(t.cover)}<div className="ctitle">{t.title}</div></div>
                  <div className="meta"><b>{t.title}</b><span>{t.artist}</span></div>
                </Link>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {vids.length ? (
        <section className="music-sec">
          <h2>Top on Laybell TV</h2>
          <Link href={`/p/${vids[0].id}`} className="tv-hero">
            <div className="tv-hero-media" style={{ background: gradientFor(vids[0].id) }}>{coverImg(vids[0].thumb)}</div>
            <div className="tv-hero-grad" aria-hidden="true" />
            <div className="tv-hero-cap">
              <span className="mus-kicker">Top video</span>
              <h2>{vids[0].title}</h2>
              <span className="tv-hero-artist">{vids[0].artist}</span>
            </div>
          </Link>
          {vids.length > 1 ? (
            <div className="tv-rail">
              {vids.slice(1).map((v) => (
                <Link key={v.id} href={`/p/${v.id}`} className="tv-card">
                  <div className="tv-card-media" style={{ background: gradientFor(v.id) }}>{coverImg(v.thumb)}</div>
                  <b className="tv-card-title">{v.title}</b>
                  <span className="tv-card-artist">{v.artist}</span>
                </Link>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {more.length ? (
        <section className="music-sec">
          <h2>More to explore</h2>
          <div className="grid">{more.map((p) => <PostTile key={p.id} post={p as any} />)}</div>
        </section>
      ) : null}

      <p className="discover-more">
        <a href="https://laybell.app/open.html" target="_blank" rel="noopener noreferrer">Get the app to see more<span aria-hidden="true"> →</span></a>
      </p>
    </main>
  );
}
