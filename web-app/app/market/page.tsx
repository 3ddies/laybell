import type { Metadata } from 'next';
import { sb } from '@/lib/supabase';
import { LISTING_PUBLIC_COLS, type WebListing } from '@/lib/shop';
import { ListingCard } from '../components';

export const revalidate = 60;

export const metadata: Metadata = {
  title: 'Shop',
  description: 'Browse beats, songs, sample packs and presets from Laybell artists. Buy in the app.',
};

export default async function MarketPage() {
  const db = sb();
  // RLS returns only active, non-hidden, non-removed listings for the anon key.
  const { data } = await db
    .from('shop_listings')
    .select(LISTING_PUBLIC_COLS)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(60);
  const listings = (data || []) as WebListing[];

  // Seller handles for the card bylines.
  const ids = Array.from(new Set(listings.map((l) => l.user_id)));
  const sellerMap: Record<string, { username: string | null }> = {};
  if (ids.length) {
    const { data: ps } = await db.from('profiles').select('id,username,hidden').in('id', ids);
    (ps || []).forEach((p: any) => { if (!p.hidden) sellerMap[p.id] = { username: p.username }; });
  }

  return (
    <main className="market shopdark">
      <section className="market-hero">
        <div className="glow" aria-hidden="true" />
        <div className="wrap">
          <h1>Shop</h1>
          <p>Beats, songs, sample packs and presets from Laybell artists. Browse the web, buy in the app.</p>
        </div>
      </section>
      <div className="wrap">
        {listings.length ? (
          <div className="shop-grid big">
            {listings.map((l) => <ListingCard key={l.id} l={l} seller={sellerMap[l.user_id]} />)}
          </div>
        ) : (
          <div className="state"><h2 style={{ fontSize: 18 }}>No items yet</h2><p>Check back soon — artists are just getting started.</p></div>
        )}
      </div>
    </main>
  );
}
