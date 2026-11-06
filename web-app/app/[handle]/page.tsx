import { cache } from 'react';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { sb, isVisibleProfile } from '@/lib/supabase';
import { formatCount } from '@/lib/format';
import { LISTING_PUBLIC_COLS, type WebListing } from '@/lib/shop';
import { Avatar, TierBadge, OpenCTA, NotFoundState } from '../components';
import ProfileTabs from '../ProfileTabs';

export const revalidate = 60;

type Profile = {
  id: string; username: string; display_name: string | null; avatar_url: string | null;
  bio: string | null; link: string | null; badge_tier: string | null; badge_show: boolean | null; hidden: boolean | null;
};

// cache() dedupes this so generateMetadata and the page itself share one query.
const getProfile = cache(async (username: string): Promise<Profile | null> => {
  const { data } = await sb()
    .from('profiles')
    .select('id,username,display_name,avatar_url,bio,link,badge_tier,badge_show,hidden')
    .ilike('username', username)
    .limit(1)
    .maybeSingle();
  return (data as Profile) ?? null;
});

function hrefFor(link: string) { return /^https?:\/\//i.test(link) ? link : 'https://' + link; }
function labelFor(link: string) { return link.replace(/^https?:\/\//i, '').replace(/\/$/, ''); }

export async function generateMetadata({ params }: { params: { handle: string } }): Promise<Metadata> {
  const raw = decodeURIComponent(params.handle);
  if (!raw.startsWith('@')) return {};
  const p = await getProfile(raw.slice(1));
  if (!p || !isVisibleProfile(p)) return { title: 'Not found' };
  const name = p.display_name || p.username;
  const desc = p.bio || `${name} on Laybell — music, posts and more.`;
  return {
    title: `${name} (@${p.username})`,
    description: desc,
    openGraph: { title: `${name} (@${p.username})`, description: desc, images: p.avatar_url ? [{ url: p.avatar_url }] : [] },
    twitter: { card: 'summary', title: `${name} (@${p.username})`, description: desc, images: p.avatar_url ? [p.avatar_url] : [] },
  };
}

export default async function ProfilePage({ params }: { params: { handle: string } }) {
  const raw = decodeURIComponent(params.handle);
  if (!raw.startsWith('@')) notFound();
  const p = await getProfile(raw.slice(1));
  if (!p) return <NotFoundState title="Profile not found" body="This handle doesn’t exist on Laybell yet." />;
  if (!isVisibleProfile(p)) return <NotFoundState title="Account unavailable" body="This account is private or no longer available." />;

  const db = sb();
  const [postsRes, followersRes, followingRes, albumsRes, listingsRes, shopRes] = await Promise.all([
    db.from('posts').select('id,type,caption,media_url,thumbnail_url,cover_url,like_count,comment_count', { count: 'exact' })
      .eq('user_id', p.id).eq('is_public', true).is('archived_at', null).not('mature', 'is', true)
      .order('created_at', { ascending: false }).limit(60),
    db.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', p.id),
    db.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', p.id),
    db.from('albums').select('id,title,cover_url,created_at').eq('user_id', p.id).order('created_at', { ascending: false }),
    // Shop listings — RLS returns only active, non-hidden, non-removed rows (anon key).
    db.from('shop_listings').select(LISTING_PUBLIC_COLS).eq('user_id', p.id).eq('status', 'active').order('created_at', { ascending: false }).limit(48),
    // Shop row — RLS returns it only when the shop is open (is_open), so a hit == open.
    db.from('shops').select('name,bio,is_open').eq('user_id', p.id).maybeSingle(),
  ]);
  const posts = (postsRes.data || []) as any[];
  const badge = p.badge_show !== false ? p.badge_tier : null;
  const name = p.display_name || p.username;

  // Music tab: albums (cover derived from their first track) + singles (audio posts
  // not in any album) + videos.
  const albumsRaw = (albumsRes.data || []) as any[];
  const trackPostIds = new Set<string>();
  let albums: { id: string; title: string; cover: string | null; trackCount: number; firstTrackId: string | null }[] = [];
  if (albumsRaw.length) {
    const { data: tracks } = await db.from('album_tracks').select('album_id,post_id,position').in('album_id', albumsRaw.map((a) => a.id)).order('position', { ascending: true });
    const trackList = (tracks || []) as any[];
    const tpIds = Array.from(new Set(trackList.map((t) => t.post_id)));
    tpIds.forEach((id) => trackPostIds.add(id));
    const tpMap: Record<string, any> = {};
    if (tpIds.length) {
      const { data: tps } = await db.from('posts').select('id,cover_url').in('id', tpIds);
      (tps || []).forEach((tp: any) => (tpMap[tp.id] = tp));
    }
    albums = albumsRaw.map((a) => {
      const t = trackList.filter((x) => x.album_id === a.id);
      const first = t[0] ? tpMap[t[0].post_id] : null;
      return { id: a.id, title: a.title, cover: a.cover_url || first?.cover_url || null, trackCount: t.length, firstTrackId: t[0]?.post_id || null };
    });
  }
  const AUDIO = new Set(['audio', 'podcast', 'audiobook']);
  const VIDEO = new Set(['video', 'reel']);
  const singles = posts
    .filter((pt) => pt.type && AUDIO.has(pt.type) && !trackPostIds.has(pt.id))
    .map((pt) => ({ id: pt.id, cover: pt.cover_url as string | null, label: (pt.caption || '').split('\n')[0].slice(0, 44) || 'Audio' }));
  const videos = posts.filter((pt) => pt.type && VIDEO.has(pt.type));

  const listings = (listingsRes.data || []) as WebListing[];
  const shopRow = (shopRes.data as { name: string | null; bio: string | null } | null) || null;
  const shop = { open: !!shopRow, listings, name: shopRow?.name ?? null, bio: shopRow?.bio ?? null };

  return (
    <>
      <section className="hero">
        <div className="glow" aria-hidden="true" />
        <div className="wrap">
          <Avatar url={p.avatar_url} name={name} handle={p.username} tier={badge} />
          <div className="pinfo">
            <div className="pname-row">
              <h1 className="handle">@{p.username}</h1>
              <TierBadge tier={badge} />
            </div>
            <div className="cta-row">
              <OpenCTA />
              <a className="btn btn-ghost" href="https://laybell.app/open.html">Follow</a>
            </div>
            <div className="counts">
              <div><b className="tnum">{formatCount(postsRes.count ?? posts.length)}</b> posts</div>
              <div><b className="tnum">{formatCount(followersRes.count ?? 0)}</b> followers</div>
              <div><b className="tnum">{formatCount(followingRes.count ?? 0)}</b> following</div>
            </div>
            <div className="pinfo-extra">
              <div className="pdisplay">{name}</div>
              {p.bio ? <div className="pbio">{p.bio}</div> : null}
              {p.link ? (
                <a className="plink" href={hrefFor(p.link)} target="_blank" rel="noopener noreferrer">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>
                  {labelFor(p.link)}
                </a>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <ProfileTabs posts={posts} albums={albums} singles={singles} videos={videos} shop={shop} />
    </>
  );
}
