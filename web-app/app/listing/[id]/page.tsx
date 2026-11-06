import { cache } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { sb, isVisibleProfile } from '@/lib/supabase';
import { formatCount, gradientFor } from '@/lib/format';
import { LISTING_PUBLIC_COLS, CATEGORY_LABEL, dealRows, listingAppLink, type WebListing } from '@/lib/shop';
import { TierBadge, NotFoundState } from '../../components';

export const revalidate = 60;

// cache() dedupes so generateMetadata and the page share one query.
const getListing = cache(async (id: string): Promise<WebListing | null> => {
  const { data } = await sb()
    .from('shop_listings')
    .select(LISTING_PUBLIC_COLS)
    .eq('id', id)
    .eq('status', 'active')
    .maybeSingle();
  return (data as WebListing) ?? null;
});

export async function generateMetadata({ params }: { params: { id: string } }): Promise<Metadata> {
  const l = await getListing(params.id);
  if (!l) return { title: 'Not found' };
  const cat = CATEGORY_LABEL[l.category] || 'Digital good';
  const desc = (l.description || '').trim().slice(0, 160) || `${cat}${l.genre ? ` · ${l.genre}` : ''} on Laybell.`;
  return {
    title: `${l.title} — Laybell Shop`,
    description: desc,
    openGraph: { title: l.title, description: desc, images: l.cover_url ? [{ url: l.cover_url }] : [] },
    twitter: { card: 'summary_large_image', title: l.title, description: desc, images: l.cover_url ? [l.cover_url] : [] },
  };
}

export default async function ListingPage({ params }: { params: { id: string } }) {
  const l = await getListing(params.id);
  if (!l) return <NotFoundState title="Item not available" body="This listing is sold, paused or no longer exists." />;

  // Seller for the byline. RLS already excluded hidden sellers from the listing
  // query above, so a visible listing implies a visible seller; this is display only.
  const { data: sellerRow } = await sb()
    .from('profiles').select('id,username,display_name,avatar_url,badge_tier,badge_show,hidden')
    .eq('id', l.user_id).maybeSingle();
  const seller = sellerRow as any;
  const sellerVisible = seller && isVisibleProfile(seller);
  const sellerName = seller ? (seller.display_name || seller.username) : null;
  const badge = seller && seller.badge_show !== false ? seller.badge_tier : null;

  const deals = dealRows(l);
  const cat = CATEGORY_LABEL[l.category] || 'Digital good';
  const stats: string[] = [];
  if ((l.sales_count ?? 0) > 0) stats.push(`${formatCount(l.sales_count!)} sold`);
  if ((l.free_count ?? 0) > 0) stats.push(`${formatCount(l.free_count!)} downloaded`);

  return (
    <main className="listing shopdark">
      <div className="wrap lwrap">
        <div className="lcover" style={!l.cover_url ? { background: gradientFor(l.id) } : undefined}>
          {l.cover_url ? (
            <img src={l.cover_url} alt={l.title} />
          ) : (
            <span className="lcover-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><path d="M3 9h18M4.5 9 6 4.5A2 2 0 0 1 7.9 3h8.2a2 2 0 0 1 1.9 1.5L19.5 9M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M9 13a3 3 0 0 0 6 0"/></svg></span>
          )}
        </div>

        <div className="linfo">
          <span className="lcat">{cat}{l.genre ? ` · ${l.genre}` : ''}</span>
          <h1 className="ltitle">{l.title}</h1>

          {sellerVisible ? (
            <Link className="lseller" href={`/@${seller.username}`}>
              <span className="mini-av">{seller.avatar_url ? <img src={seller.avatar_url} alt="" /> : (sellerName || '?').charAt(0).toUpperCase()}</span>
              <span className="ls-txt"><b>{sellerName}</b><TierBadge tier={badge} /><span className="ls-handle">@{seller.username}</span></span>
            </Link>
          ) : null}

          {l.preview_url ? (
            <div className="lpreview">
              <span className="lp-label"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18V6l9-2v12"/><circle cx="6" cy="18" r="2.6" fill="currentColor"/><circle cx="15" cy="16" r="2.6" fill="currentColor"/></svg> Preview</span>
              <audio controls preload="none" src={l.preview_url} />
            </div>
          ) : null}

          <div className="ldeals">
            {deals.map((d) => (
              <div className={`ldeal ${d.kind}`} key={d.kind}>
                <div className="ld-main"><b>{d.label}</b><span>{d.sub}</span></div>
                <div className="ld-price">{d.price}</div>
              </div>
            ))}
          </div>

          <a className="btn btn-primary lbuy" href={listingAppLink(l.id)}>
            <img className="logo-sm" src="/logo.png" alt="" />Get it in the app
          </a>
          <p className="lnote">Browse here, buy in the app — purchases are handled securely in Laybell.{stats.length ? ` · ${stats.join(' · ')}` : ''}</p>

          {l.description ? (
            <div className="ldesc"><h3>About this {cat.toLowerCase()}</h3><p>{l.description}</p></div>
          ) : null}
        </div>
      </div>
    </main>
  );
}
