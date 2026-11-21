import Link from 'next/link';
import { sb } from '@/lib/supabase';
import { LISTING_PUBLIC_COLS, type WebListing } from '@/lib/shop';
import { OpenCTA, ListingCard } from './components';

export const revalidate = 60;
export const metadata = { title: 'Laybell — make music, sell beats, go live' };

// Action tiles — each one LEADS somewhere real on the web. Icons stay inline (no
// icon dep) and simple so they read at ~23px on the cards.
const TILES = [
  {
    title: 'Music', desc: 'Singles and tracks from every Laybell artist.',
    cta: 'Listen', href: '/music', external: false,
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M9 18V5l10-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="16" cy="16" r="3" /></svg>,
  },
  {
    title: 'Laybell TV', desc: 'Stream videos and films from the community.',
    cta: 'Watch', href: '/tv', external: false,
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="2.5" y="5" width="19" height="13" rx="2.5" /><path d="M10 9.3 15 12l-5 2.7z" fill="currentColor" stroke="none" /><path d="M8 21h8" /></svg>,
  },
  {
    title: 'The Beat Shop', desc: 'Buy and lease beats, sample packs and presets.',
    cta: 'Shop', href: '/market', external: false,
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 9h18M4.5 9 6 4.5A2 2 0 0 1 7.9 3h8.2a2 2 0 0 1 1.9 1.5L19.5 9M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M9 13a3 3 0 0 0 6 0" /></svg>,
  },
  {
    title: 'Studio', desc: 'Host or join a live studio session from your computer.',
    cta: 'Join a session', href: 'https://laybell.app/studio.html', external: true,
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="9" y="2.5" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4M8.5 21h7" /></svg>,
  },
  {
    title: 'Live', desc: 'See who is broadcasting live right now.',
    cta: "See who's live", href: '/live', external: false,
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="3" /><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4M3.5 3.5a12 12 0 0 0 0 17M20.5 3.5a12 12 0 0 1 0 17" /></svg>,
  },
  {
    title: 'DJ', desc: 'Blend and mix tracks in the Laybell DJ booth.',
    cta: 'Open in the app', href: 'https://laybell.app/open.html', external: true,
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" /><path d="M12 3a9 9 0 0 1 9 9" /></svg>,
  },
];

async function featuredBeats(): Promise<{ beats: WebListing[]; sellers: Record<string, { username: string | null }> }> {
  try {
    const db = sb();
    // RLS already limits the anon key to active, non-hidden, non-removed listings.
    const { data } = await db
      .from('shop_listings')
      .select(LISTING_PUBLIC_COLS)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(8);
    const beats = (data || []) as WebListing[];
    const ids = Array.from(new Set(beats.map((l) => l.user_id)));
    const sellers: Record<string, { username: string | null }> = {};
    if (ids.length) {
      const { data: ps } = await db.from('profiles').select('id,username,hidden').in('id', ids);
      (ps || []).forEach((p: any) => { if (!p.hidden) sellers[p.id] = { username: p.username }; });
    }
    return { beats, sellers };
  } catch {
    return { beats: [], sellers: {} };
  }
}

export default async function Home() {
  const { beats, sellers } = await featuredBeats();

  return (
    <main>
      {/* Hero */}
      <section className="hm-hero">
        <video className="hm-video" autoPlay muted loop playsInline poster="/hero-bg-poster.jpg" aria-hidden="true">
          <source src="/hero-bg.mp4" type="video/mp4" />
        </video>
        <div className="hm-video-tint" aria-hidden="true" />
        <div className="hm-glow" aria-hidden="true" />
        <div className="wrap hm-hero-inner">
          <div className="hm-brand hm-rise" style={{ animationDelay: '0s' }}>
            <span className="hm-brand-bell" aria-hidden="true" />
            <span className="hm-brand-word">Laybell</span>
          </div>
          <h1 className="hm-title hm-rise" style={{ animationDelay: '.08s' }}>
            Make music. <span className="hm-grad">Sell beats.</span> Go live.
          </h1>
          <p className="hm-sub hm-rise" style={{ animationDelay: '.16s' }}>
            Laybell is where artists drop albums and singles, sell and lease their beats, go live,
            and build a following. All in one place.
          </p>
          <div className="hm-cta hm-rise" style={{ animationDelay: '.24s' }}>
            <Link className="btn btn-primary hm-cta-main" href="/market">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true"><path d="M3 9h18M4.5 9 6 4.5A2 2 0 0 1 7.9 3h8.2a2 2 0 0 1 1.9 1.5L19.5 9M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M9 13a3 3 0 0 0 6 0" /></svg>
              Browse the shop
            </Link>
          </div>
          <Link className="hm-more hm-rise" href="/discover" style={{ animationDelay: '.3s' }}>More</Link>
        </div>
      </section>

      {/* Beat shop — real listings, styled as the dark storefront so it reads as THE shop */}
      <section className="hm-beats shopdark">
        <div className="wrap">
          <div className="hm-beats-head">
            <div>
              <span className="hm-kicker">Online Beat Shop</span>
              <h2 className="hm-h2">Beats, packs &amp; presets</h2>
              <p className="hm-beats-sub">Buy or lease straight from Laybell artists. Browse on the web, check out in the app.</p>
            </div>
            <Link className="btn btn-ghost hm-viewall" href="/market">
              View all
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </Link>
          </div>
          {beats.length ? (
            <div className="shop-grid big hm-beats-grid">
              {beats.map((l) => <ListingCard key={l.id} l={l} seller={sellers[l.user_id]} />)}
            </div>
          ) : (
            <div className="hm-beats-empty">
              <p>New drops land here every week. Open the shop to see what&apos;s live.</p>
              <Link className="btn btn-primary" href="/market">Open the shop</Link>
            </div>
          )}
        </div>
      </section>

      {/* What Laybell is — practical overview */}
      <section className="wrap hm-features">
        <h2 className="hm-h2 hm-center">Everything in one place</h2>
        <p className="hm-section-sub hm-center">Jump straight into any corner of Laybell.</p>
        <div className="hm-feat-grid">
          {TILES.map((t) => (
            <Link key={t.title} href={t.href} className="hm-feat" target={t.external ? '_blank' : undefined} rel={t.external ? 'noopener noreferrer' : undefined}>
              <span className="hm-feat-ic">{t.icon}</span>
              <b>{t.title}</b>
              <span className="hm-feat-desc">{t.desc}</span>
              <span className="hm-feat-go">{t.cta} <span aria-hidden="true">{t.external ? '↗' : '→'}</span></span>
            </Link>
          ))}
        </div>
        <div className="hm-browse">
          <Link className="hm-browse-btn" href="/explore">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true"><rect x="3" y="3" width="7.5" height="7.5" rx="1.8" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.8" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.8" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.8" /></svg>
            Browse Laybell
            <span className="hm-browse-arrow" aria-hidden="true">→</span>
          </Link>
        </div>
      </section>

      {/* Get the app */}
      <section className="hm-appcta">
        <div className="wrap hm-appcta-inner">
          <div className="hm-appcta-text">
            <h2 className="hm-h2">Get the full Laybell</h2>
            <p>Listen, post, sell and go live. The whole thing lives in the app.</p>
          </div>
          <OpenCTA label="Get the app" />
        </div>
      </section>
    </main>
  );
}
