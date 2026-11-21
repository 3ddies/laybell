import Link from 'next/link';
import { sb } from '@/lib/supabase';
import { gradientFor } from '@/lib/format';

export const revalidate = 60;
export const metadata = {
  title: 'Music',
  description: 'Listen to music from Laybell artists. Singles and tracks, right here on the web.',
};

type Track = { id: string; cover: string | null; title: string; artist: string; likes: number };
const titleOf = (c?: string | null) => (c || '').split('\n')[0].trim().slice(0, 48) || 'Untitled';

async function getTracks(): Promise<Track[]> {
  const db = sb();
  // ALL and ONLY music: public audio posts (RLS limits to non-hidden).
  const { data } = await db
    .from('posts')
    .select('id,cover_url,thumbnail_url,caption,user_id,like_count,created_at')
    .eq('is_public', true).is('archived_at', null).not('mature', 'is', true)
    .in('type', ['audio', 'podcast', 'audiobook'])
    .order('created_at', { ascending: false }).limit(60);
  const posts = (data || []) as Record<string, any>[];
  const ids = Array.from(new Set(posts.map((p) => p.user_id).filter(Boolean)));
  const artist: Record<string, string> = {};
  if (ids.length) {
    // profiles.hidden isn't enforced by RLS — guard it here, and drop tracks by hidden artists.
    const { data: ps } = await db.from('profiles').select('id,username,display_name,hidden').in('id', ids);
    (ps || []).forEach((p: any) => { if (!p.hidden) artist[p.id] = p.display_name || (p.username ? `@${p.username}` : 'Artist'); });
  }
  return posts
    .filter((p) => artist[p.user_id] !== undefined)
    .map((p) => ({ id: p.id, cover: p.cover_url || p.thumbnail_url || null, title: titleOf(p.caption), artist: artist[p.user_id], likes: p.like_count || 0 }));
}

const coverImg = (c: string | null) => (c ? <img src={c} alt="" loading="lazy" /> : null);
// The gradient always sits behind the cover, so a null OR broken (404) image
// reveals a deterministic colour instead of an empty box.
const grad = (id: string) => ({ background: gradientFor(id) });

export default async function MusicPage() {
  const tracks = await getTracks();
  if (!tracks.length) {
    return <main className="wrap" style={{ paddingBlock: '22px 48px' }}><h1 className="mus-h1">Music</h1><div className="feed-empty">No music yet. Check back soon.</div></main>;
  }
  const byLikes = [...tracks].sort((a, b) => b.likes - a.likes);
  const hero = byLikes[0];
  const hot = byLikes.filter((t) => t.id !== hero.id).slice(0, 12);

  return (
    <main className="wrap music-page">
      <h1 className="mus-h1">Music</h1>
      <p className="mus-sub">Singles and tracks from Laybell artists. Tap to listen.</p>

      <Link href={`/p/${hero.id}`} className="mus-hero">
        <div className="mus-hero-cover" style={grad(hero.id)}>
          {coverImg(hero.cover)}
          <span className="mus-hero-play" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg></span>
        </div>
        <div className="mus-hero-info">
          <span className="mus-kicker">Featured</span>
          <h2 className="mus-hero-title">{hero.title}</h2>
          <span className="mus-hero-artist">{hero.artist}</span>
        </div>
      </Link>

      {hot.length ? (
        <section className="music-sec">
          <h2>Hot right now</h2>
          <div className="shelf">
            {hot.map((t) => (
              <Link key={t.id} href={`/p/${t.id}`} className="album">
                <div className="cover" style={grad(t.id)}>{coverImg(t.cover)}<div className="ctitle">{t.title}</div></div>
                <div className="meta"><b>{t.title}</b><span>{t.artist}</span></div>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section className="music-sec">
        <h2>New music</h2>
        <div className="singles">
          {tracks.map((t) => (
            <Link key={t.id} href={`/p/${t.id}`} className="srow">
              <div className="art" style={grad(t.id)}>{coverImg(t.cover)}</div>
              <div className="t"><b>{t.title}</b><span>{t.artist}</span></div>
              <div className="dur" aria-hidden="true">▶</div>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
