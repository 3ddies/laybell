import Link from 'next/link';
import { sb } from '@/lib/supabase';
import { gradientFor, streamPreviewSrc } from '@/lib/format';
import HoverPreview from '../HoverPreview';

export const revalidate = 60;
export const metadata = {
  title: 'Laybell TV',
  description: 'Watch horizontal videos and films from Laybell creators, right here on the web.',
};

type Vid = { id: string; thumb: string | null; title: string; artist: string; likes: number; preview: string | null };
const titleOf = (c?: string | null) => (c || '').split('\n')[0].trim().slice(0, 60) || 'Untitled';
const aspectNum = (s?: string | null) => {
  if (!s) return 0;
  if (s.includes(':')) { const [w, h] = s.split(':').map(Number); return h ? w / h : 0; }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};

async function getVideos(): Promise<Vid[]> {
  const db = sb();
  // Laybell TV = LANDSCAPE video + film. RLS limits the anon key to public, non-hidden rows.
  const { data } = await db
    .from('posts')
    .select('id,media_url,cover_url,thumbnail_url,caption,user_id,like_count,aspect_ratio,created_at')
    .eq('is_public', true).is('archived_at', null).not('mature', 'is', true)
    .in('type', ['video', 'reel', 'film'])
    .order('created_at', { ascending: false }).limit(80);
  const posts = (data || []).filter((p: any) => aspectNum(p.aspect_ratio) > 1) as Record<string, any>[];
  const ids = Array.from(new Set(posts.map((p) => p.user_id).filter(Boolean)));
  const artist: Record<string, string> = {};
  if (ids.length) {
    // profiles.hidden isn't enforced by RLS — guard it here, and drop clips by hidden creators.
    const { data: ps } = await db.from('profiles').select('id,username,display_name,hidden').in('id', ids);
    (ps || []).forEach((p: any) => { if (!p.hidden) artist[p.id] = p.display_name || (p.username ? `@${p.username}` : 'Creator'); });
  }
  return posts
    .filter((p) => artist[p.user_id] !== undefined)
    .map((p) => ({
      id: p.id,
      thumb: p.thumbnail_url || p.cover_url || null,
      title: titleOf(p.caption),
      artist: artist[p.user_id],
      likes: p.like_count || 0,
      // The Stream PREVIEW player URL (never the raw manifest) — only rendered
      // into the DOM on hover by HoverPreview.
      preview: streamPreviewSrc(p.media_url, p.thumbnail_url || p.cover_url),
    }));
}

export default async function TVPage() {
  const vids = await getVideos();
  if (!vids.length) {
    return <main className="wrap" style={{ paddingBlock: '22px 48px' }}><h1 className="mus-h1">Laybell TV</h1><div className="feed-empty">No videos yet. Check back soon.</div></main>;
  }
  const byLikes = [...vids].sort((a, b) => b.likes - a.likes);
  const hero = byLikes[0];
  const trending = byLikes.filter((v) => v.id !== hero.id).slice(0, 10);
  const shown = new Set([hero.id, ...trending.map((t) => t.id)]);
  const rest = vids.filter((v) => !shown.has(v.id));

  const card = (v: Vid) => (
    <Link key={v.id} href={`/p/${v.id}`} className="tv-card">
      <HoverPreview className="tv-card-media" bg={gradientFor(v.id)} thumb={v.thumb} preview={v.preview} />
      <b className="tv-card-title">{v.title}</b>
      <span className="tv-card-artist">{v.artist}</span>
    </Link>
  );

  return (
    <main className="wrap tv-page2">
      <h1 className="mus-h1">Laybell TV</h1>
      <p className="mus-sub">Horizontal videos and films from Laybell creators. Tap to watch.</p>

      <Link href={`/p/${hero.id}`} className="tv-hero">
        <HoverPreview className="tv-hero-media" bg={gradientFor(hero.id)} thumb={hero.thumb} preview={hero.preview} />
        <div className="tv-hero-grad" aria-hidden="true" />
        <div className="tv-hero-cap">
          <span className="mus-kicker">Featured</span>
          <h2>{hero.title}</h2>
          <span className="tv-hero-artist">{hero.artist}</span>
        </div>
      </Link>

      {trending.length ? (
        <section className="music-sec">
          <h2>Trending</h2>
          <div className="tv-rail">{trending.map(card)}</div>
        </section>
      ) : null}

      {rest.length ? (
        <section className="music-sec">
          <h2>More on Laybell TV</h2>
          <div className="tv-cards-grid">{rest.map(card)}</div>
        </section>
      ) : null}
    </main>
  );
}
