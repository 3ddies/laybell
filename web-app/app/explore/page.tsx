import Link from 'next/link';
import { sb } from '@/lib/supabase';
import { PostTile } from '../components';

export const revalidate = 60;
export const metadata = { title: 'Explore', description: 'Discover artists, posts and communities on Laybell.' };

export default async function ExplorePage() {
  const db = sb();
  const [postsRes, commsRes] = await Promise.all([
    db.from('posts').select('id,type,media_url,thumbnail_url,cover_url,like_count,comment_count')
      .eq('is_public', true).is('archived_at', null).not('mature', 'is', true)
      .order('created_at', { ascending: false }).limit(30),
    db.from('communities').select('id,name,hashtag,member_count').order('member_count', { ascending: false }).limit(10),
  ]);
  const posts = postsRes.data || [];
  const comms = commsRes.data || [];

  return (
    <main className="wrap" style={{ paddingBlock: '22px 48px' }}>
      <h1 style={{ fontFamily: 'var(--f-display)', fontSize: 'clamp(36px, 6vw, 54px)', fontWeight: 800, letterSpacing: '-.025em', lineHeight: 1.04, margin: '6px 2px 20px' }}>Explore</h1>

      <div className="rh" style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--faint)', fontWeight: 700, margin: '4px 2px 12px' }}>Recent</div>
      {posts.length ? <div className="grid">{posts.map((p) => <PostTile key={p.id} post={p} />)}</div> : <div className="feed-empty">Nothing to show yet.</div>}

      {comms.length ? (
        <>
          <div className="rh" style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--faint)', fontWeight: 700, margin: '36px 2px 10px' }}>Communities</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {comms.map((c: any) => <Link key={c.id} href={`/c/${c.hashtag}`} className="btn btn-ghost">#{c.hashtag}</Link>)}
          </div>
        </>
      ) : null}
    </main>
  );
}
