import Link from 'next/link';
import { thumbFor, gradientFor, initial, formatCount, type GridPost } from '@/lib/format';
import { saleTypes, listingPriceLabel, CATEGORY_LABEL, type WebListing } from '@/lib/shop';

export function Avatar({ url, name, handle, tier, size = 168 }: {
  url?: string | null; name?: string | null; handle?: string | null; tier?: string | null; size?: number;
}) {
  const ring = tier === 'diamond' ? 'diamond' : tier === 'gold' ? 'gold' : 'plain';
  const pad = size > 120 ? 4 : 3;
  // Size via CSS vars so a media query can shrink it responsively — an inline
  // width/height would beat the stylesheet and never shrink on mobile.
  return (
    <div className={`av-wrap ${ring}`} style={{ ['--av-size' as any]: `${size}px`, ['--av-pad' as any]: `${pad}px` }}>
      <div className="av">
        {url ? <img src={url} alt="" /> : initial(name, handle)}
      </div>
    </div>
  );
}

export function TierBadge({ tier }: { tier?: string | null }) {
  if (!tier || !['gold', 'diamond', 'silver', 'bronze'].includes(tier)) return null;
  return (
    <span className={`badge ${tier}`}>
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="m12 2 2.5 5 5.5.8-4 3.9.9 5.5L12 14.6 7.1 17.2l.9-5.5-4-3.9L9.5 7z"/></svg>
      {tier}
    </span>
  );
}

const TYPE_ICON: Record<string, React.ReactNode> = {
  video: <svg viewBox="0 0 24 24" fill="currentColor"><path d="m9 8 7 4-7 4z"/></svg>,
  reel: <svg viewBox="0 0 24 24" fill="currentColor"><path d="m9 8 7 4-7 4z"/></svg>,
  audio: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18V6l9-2v12"/><circle cx="6" cy="18" r="2.6" fill="currentColor"/><circle cx="15" cy="16" r="2.6" fill="currentColor"/></svg>,
  podcast: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18V6l9-2v12"/><circle cx="6" cy="18" r="2.6" fill="currentColor"/><circle cx="15" cy="16" r="2.6" fill="currentColor"/></svg>,
  slideshow: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="7" y="4" width="13" height="13" rx="2"/><path d="M4 8v10a2 2 0 0 0 2 2h10"/></svg>,
};

export function PostTile({ post }: { post: GridPost }) {
  const thumb = thumbFor(post);
  const icon = post.type ? TYPE_ICON[post.type] : null;
  return (
    <Link className="tile" href={`/p/${post.id}`}>
      {thumb ? <img src={thumb} alt="" loading="lazy" /> : <span className="ph" style={{ background: gradientFor(post.id) }} />}
      {icon ? <span className="badge-ic">{icon}</span> : null}
      <span className="ov">
        <span><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7-4.5-9.3-8.3C1.2 10 2.3 6.5 5.5 6c1.9-.3 3.6.8 4.5 2 .9-1.2 2.6-2.3 4.5-2 3.2.5 4.3 4 2.8 6.7C19 16.5 12 21 12 21Z"/></svg>{formatCount(post.like_count)}</span>
        <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a8 8 0 0 1-11.5 7.2L3 21l1.8-6.5A8 8 0 1 1 21 12Z"/></svg>{formatCount(post.comment_count)}</span>
      </span>
    </Link>
  );
}

export function OpenCTA({ label = 'Open in Laybell', wide = false }: { label?: string; wide?: boolean }) {
  return (
    <a className="btn btn-primary" href="https://laybell.app/open.html" style={wide ? { width: '100%', justifyContent: 'center' } : undefined}>
      <img className="logo-sm" src="/logo.png" alt="" />
      {label}
    </a>
  );
}

export function ListingCard({ l, seller }: { l: WebListing; seller?: { username: string | null } | null }) {
  const t = saleTypes(l);
  const price = listingPriceLabel(l);
  const free = price === 'Free';
  return (
    <Link className="scard" href={`/listing/${l.id}`}>
      <div className="scover" style={!l.cover_url ? { background: gradientFor(l.id) } : undefined}>
        {l.cover_url ? <img src={l.cover_url} alt="" loading="lazy" /> : (
          <span className="scover-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M3 9h18M4.5 9 6 4.5A2 2 0 0 1 7.9 3h8.2a2 2 0 0 1 1.9 1.5L19.5 9M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M9 13a3 3 0 0 0 6 0"/></svg></span>
        )}
        <span className={`sprice${free ? ' free' : ''}`}>{price}</span>
        {l.preview_url ? <span className="splay" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span> : null}
      </div>
      <div className="smeta">
        <b className="stitle">{l.title}</b>
        <span className="ssub">{CATEGORY_LABEL[l.category] || 'Digital good'}{l.genre ? ` · ${l.genre}` : ''}{seller?.username ? ` · @${seller.username}` : ''}</span>
        <span className="schips">
          {t.sell ? <i className="schip sell">Buy</i> : null}
          {t.lease ? <i className="schip lease">Lease</i> : null}
          {t.free ? <i className="schip free">Free</i> : null}
        </span>
      </div>
    </Link>
  );
}

export function NotFoundState({ title, body }: { title: string; body: string }) {
  return (
    <main className="wrap">
      <div className="state">
        <div className="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3-3"/></svg></div>
        <h2>{title}</h2>
        <p>{body}</p>
        <div style={{ marginTop: 20, display: 'flex', justifyContent: 'center' }}><OpenCTA label="Open Laybell" /></div>
      </div>
    </main>
  );
}
