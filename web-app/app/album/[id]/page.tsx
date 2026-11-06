import Link from 'next/link';
import type { Metadata } from 'next';
import { cache } from 'react';
import { sb } from '@/lib/supabase';
import { initial, gradientFor } from '@/lib/format';
import { NotFoundState } from '../../components';

export const revalidate = 60;

type Album = { id: string; title: string; user_id: string; cover_url: string | null };
type Artist = { username: string; display_name: string | null; avatar_url: string | null; hidden: boolean | null };
type Track = { post_id: string; title: string | null; cover: string | null; caption: string | null; dur: number | null };

function fmtDur(s?: number | null) {
  if (!s || s <= 0) return '';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

const getAlbum = cache(async (id: string): Promise<{ album: Album | null; artist: Artist | null; tracks: Track[] }> => {
  const db = sb();
  const { data: album } = await db.from('albums').select('id,title,user_id,cover_url').eq('id', id).maybeSingle();
  if (!album) return { album: null, artist: null, tracks: [] };
  const [{ data: artist }, { data: at }] = await Promise.all([
    db.from('profiles').select('username,display_name,avatar_url,hidden').eq('id', (album as Album).user_id).maybeSingle(),
    db.from('album_tracks').select('post_id,position,title').eq('album_id', id).order('position', { ascending: true }),
  ]);
  const atList = (at || []) as { post_id: string; position: number; title: string | null }[];
  const ids = atList.map((t) => t.post_id);
  let tracks: Track[] = [];
  if (ids.length) {
    const { data: ps } = await db.from('posts').select('id,cover_url,caption,duration_seconds,is_public,archived_at,mature').in('id', ids);
    const pm: Record<string, any> = {}; (ps || []).forEach((p: any) => (pm[p.id] = p));
    tracks = atList
      .map((t) => {
        const p = pm[t.post_id];
        if (!p || p.is_public === false || p.archived_at || p.mature) return null;
        return { post_id: t.post_id, title: t.title, cover: p.cover_url, caption: p.caption, dur: p.duration_seconds };
      })
      .filter(Boolean) as Track[];
  }
  return { album: album as Album, artist: (artist as Artist) || null, tracks };
});

export async function generateMetadata({ params }: { params: { id: string } }): Promise<Metadata> {
  const { album, artist } = await getAlbum(params.id);
  if (!album || !artist || artist.hidden) return { title: 'Album not found' };
  const by = artist.display_name || artist.username;
  return {
    title: `${album.title} by ${by}`,
    description: `${album.title} — an album by ${by} on Laybell.`,
    openGraph: { title: `${album.title} by ${by}`, description: `An album by ${by} on Laybell.`, images: album.cover_url ? [{ url: album.cover_url }] : [] },
  };
}

export default async function AlbumPage({ params }: { params: { id: string } }) {
  const { album, artist, tracks } = await getAlbum(params.id);
  if (!album) return <NotFoundState title="Album not found" body="This album doesn’t exist or was removed." />;
  if (!artist || artist.hidden) return <NotFoundState title="Album unavailable" body="This album can’t be shown on the web." />;
  const by = artist.display_name || artist.username;
  const cover = album.cover_url || tracks[0]?.cover || null;

  return (
    <main className="albumpage">
      <div className="wrap">
        <div className="album-hero">
          <div className="acover" style={!cover ? { background: gradientFor(album.id) } : undefined}>{cover ? <img src={cover} alt="" /> : null}</div>
          <div className="ainfo">
            <div className="akind">Album</div>
            <h1>{album.title}</h1>
            <Link href={`/@${artist.username}`} className="aartist">
              <span className="aav">{artist.avatar_url ? <img src={artist.avatar_url} alt="" /> : initial(by, artist.username)}</span>
              @{artist.username}
            </Link>
            <div className="ameta">{tracks.length} track{tracks.length === 1 ? '' : 's'}</div>
          </div>
        </div>
        <div className="tracklist">
          {tracks.length ? tracks.map((t, i) => (
            <Link key={t.post_id} href={`/p/${t.post_id}`} className="trk">
              <span className="tnum2">{i + 1}</span>
              <span className="tart" style={!t.cover ? { background: gradientFor(t.post_id) } : undefined}>{t.cover ? <img src={t.cover} alt="" /> : null}</span>
              <span className="tnm">{t.title || (t.caption || '').split('\n')[0].slice(0, 50) || 'Untitled'}</span>
              <span className="tdur">{fmtDur(t.dur)}</span>
            </Link>
          )) : <div className="feed-empty">No tracks available.</div>}
        </div>
      </div>
    </main>
  );
}
