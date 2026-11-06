'use client';
import { useState } from 'react';
import Link from 'next/link';
import { PostTile, ListingCard } from './components';
import { gradientFor, type GridPost } from '@/lib/format';
import type { WebListing } from '@/lib/shop';

type Album = { id: string; title: string; cover: string | null; trackCount: number; firstTrackId: string | null };
type Single = { id: string; cover: string | null; label: string };
type Shop = { open: boolean; listings: WebListing[]; name: string | null; bio: string | null };
type Tab = 'posts' | 'music' | 'videos' | 'shop';

const ICON: Record<Tab, React.ReactNode> = {
  music: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>,
  posts: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>,
  videos: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3z" fill="currentColor"/></svg>,
  shop: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M3 9h18M4.5 9 6 4.5A2 2 0 0 1 7.9 3h8.2a2 2 0 0 1 1.9 1.5L19.5 9M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M9 13a3 3 0 0 0 6 0"/></svg>,
};

function Empty({ label }: { label: string }) {
  return <div className="state"><h2 style={{ fontSize: 18 }}>{label}</h2></div>;
}

export default function ProfileTabs({ posts, albums, singles, videos, shop }: { posts: GridPost[]; albums: Album[]; singles: Single[]; videos: GridPost[]; shop: Shop }) {
  const hasMusic = albums.length > 0 || singles.length > 0;
  const hasShop = shop.open && shop.listings.length > 0;
  const [tab, setTab] = useState<Tab>(hasMusic ? 'music' : 'posts');

  const TabBtn = ({ id, label }: { id: Tab; label: string }) => (
    <button className={`tabbtn ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)} role="tab" aria-selected={tab === id}>{ICON[id]}{label}</button>
  );

  return (
    <>
      <nav className="tabs"><div className="wrap tabsrow" role="tablist">
        {hasMusic ? <TabBtn id="music" label="Music" /> : null}
        <TabBtn id="posts" label="Posts" />
        {videos.length ? <TabBtn id="videos" label="Videos" /> : null}
        {hasShop ? <TabBtn id="shop" label="Shop" /> : null}
      </div></nav>

      <main className="panel wrap">
        {tab === 'music' ? (
          <>
            {albums.length ? (
              <section className="music-sec">
                <h2>Albums</h2>
                <div className="shelf">
                  {albums.map((al) => (
                    <Link key={al.id} href={`/album/${al.id}`} className="album">
                      <div className="cover" style={!al.cover ? { background: gradientFor(al.id) } : undefined}>
                        {al.cover ? <img src={al.cover} alt="" /> : null}
                        <div className="ctitle">{al.title}</div>
                      </div>
                      <div className="meta"><b>{al.title}</b><span>{al.trackCount} track{al.trackCount === 1 ? '' : 's'}</span></div>
                    </Link>
                  ))}
                </div>
              </section>
            ) : null}
            {singles.length ? (
              <section className="music-sec">
                <h2>Singles</h2>
                <div className="singles">
                  {singles.map((s) => (
                    <Link key={s.id} href={`/p/${s.id}`} className="srow">
                      <div className="art" style={!s.cover ? { background: gradientFor(s.id) } : undefined}>{s.cover ? <img src={s.cover} alt="" /> : null}</div>
                      <div className="t"><b>{s.label}</b><span>Song</span></div>
                      <div className="dur" aria-hidden="true">▶</div>
                    </Link>
                  ))}
                </div>
              </section>
            ) : null}
          </>
        ) : tab === 'videos' ? (
          videos.length ? <div className="grid">{videos.map((p) => <PostTile key={p.id} post={p} />)}</div> : <Empty label="No videos yet" />
        ) : tab === 'shop' ? (
          hasShop ? (
            <section className="shop-sec shopdark">
              <div className="shop-head">
                <h2>{shop.name || 'Shop'}</h2>
                <span className="shop-note">Buy in the app · {shop.listings.length} item{shop.listings.length === 1 ? '' : 's'}</span>
              </div>
              {shop.bio ? <p className="shop-bio">{shop.bio}</p> : null}
              <div className="shop-grid">
                {shop.listings.map((l) => <ListingCard key={l.id} l={l} />)}
              </div>
            </section>
          ) : <Empty label="No items yet" />
        ) : (
          posts.length ? <div className="grid">{posts.map((p) => <PostTile key={p.id} post={p} />)}</div> : <Empty label="No posts yet" />
        )}
      </main>
    </>
  );
}
