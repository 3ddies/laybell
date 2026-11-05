import { cache } from 'react';
import type { Metadata } from 'next';
import { sb } from '@/lib/supabase';
import { formatCount } from '@/lib/format';
import { PostTile, OpenCTA, NotFoundState } from '../../components';

export const revalidate = 60;

type Community = { id: string; name: string | null; hashtag: string; description: string | null; banner_url: string | null; member_count: number | null };

const getCommunity = cache(async (tag: string): Promise<Community | null> => {
  const { data } = await sb().from('communities')
    .select('id,name,hashtag,description,banner_url,member_count')
    .ilike('hashtag', tag).limit(1).maybeSingle();
  return (data as Community) ?? null;
});

function clean(h: string) { return decodeURIComponent(h).replace(/^#/, '').toLowerCase(); }

export async function generateMetadata({ params }: { params: { hashtag: string } }): Promise<Metadata> {
  const tag = clean(params.hashtag);
  const c = await getCommunity(tag);
  const name = c?.name || `#${tag}`;
  return { title: `${name} on Laybell`, description: c?.description || `The ${name} community on Laybell.` };
}

export default async function CommunityPage({ params }: { params: { hashtag: string } }) {
  const tag = clean(params.hashtag);
  const db = sb();
  const [c, postsRes] = await Promise.all([
    getCommunity(tag),
    db.from('posts').select('id,type,media_url,thumbnail_url,cover_url,like_count,comment_count', { count: 'exact' })
      .eq('community_hashtag', tag).eq('is_public', true).is('archived_at', null).not('mature', 'is', true)
      .order('created_at', { ascending: false }).limit(60),
  ]);
  if (!c && !(postsRes.data && postsRes.data.length)) {
    return <NotFoundState title="Community not found" body="There’s no community at this hashtag yet." />;
  }
  const posts = postsRes.data || [];
  const name = c?.name || `#${tag}`;

  return (
    <>
      <section className="hero chero">
        <div className="wrap">
          <div className="cbanner">{c?.banner_url ? <img src={c.banner_url} alt="" /> : null}</div>
          <div className="chead">
            <div>
              <h1 className="ctag">#{tag}</h1>
              <div className="cmeta">
                {name !== `#${tag}` ? <><b style={{ color: 'var(--fg)' }}>{name}</b> · </> : null}
                {formatCount(c?.member_count ?? 0)} members · {formatCount(postsRes.count ?? posts.length)} posts
              </div>
            </div>
            <div style={{ marginLeft: 'auto' }}><OpenCTA label="Join in Laybell" /></div>
          </div>
          {c?.description ? <p className="pbio" style={{ marginTop: 14, padding: '0 8px' }}>{c.description}</p> : null}
        </div>
      </section>

      <main className="panel wrap" style={{ paddingTop: 20 }}>
        {posts.length ? (
          <div className="grid">{posts.map((pt) => <PostTile key={pt.id} post={pt} />)}</div>
        ) : (
          <div className="state"><h2>No public posts yet</h2><p>Be the first to post in #{tag} — open Laybell to join.</p></div>
        )}
      </main>
    </>
  );
}
