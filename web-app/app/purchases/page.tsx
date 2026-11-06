'use client';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { browserSb } from '@/lib/supabaseBrowser';
import { gradientFor } from '@/lib/format';
import { CATEGORY_LABEL } from '@/lib/shop';

type Purchase = {
  order_id: string; kind: string; price_cents: number; created_at: string;
  listing_id: string; title: string; cover_url: string | null; category: string; seller_username: string | null;
};

function PurchasesInner() {
  const sb = browserSb();
  const router = useRouter();
  const checkoutIntent = useSearchParams().get('checkout');

  const [checked, setChecked] = useState(false);
  const [items, setItems] = useState<Purchase[] | null>(null);
  const [banner, setBanner] = useState<{ kind: 'wait' | 'ok' | 'refund' | 'err'; text: string } | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await sb.rpc('my_shop_purchases');
    if (!error) setItems((data as Purchase[]) ?? []);
  }, [sb]);

  useEffect(() => {
    sb.auth.getSession().then(({ data }) => {
      if (!data.session) { router.replace('/login'); return; }
      setChecked(true);
      load();
    });
  }, [sb, router, load]);

  // After Stripe redirects back with ?checkout=<intent>, poll until the webhook
  // delivers (or refunds) the purchase.
  useEffect(() => {
    if (!checked || !checkoutIntent) return;
    let tries = 0; let active = true;
    setBanner({ kind: 'wait', text: 'Completing your purchase…' });
    const tick = async () => {
      if (!active) return;
      const { data, error } = await sb.rpc('shop_poll_stripe_order', { p_intent_id: checkoutIntent });
      if (error) { setBanner({ kind: 'err', text: 'We couldn’t confirm this purchase yet — it’ll appear below once it clears.' }); return; }
      if ((data as any)?.delivered) { setBanner({ kind: 'ok', text: 'Purchased! Your download is ready below.' }); load(); return; }
      if ((data as any)?.refunded || (data as any)?.status === 'failed') {
        setBanner({ kind: 'refund', text: 'That purchase couldn’t be completed and your card was refunded.' }); return;
      }
      if (tries++ < 20) setTimeout(tick, 1500);
      else setBanner({ kind: 'err', text: 'Still processing — your purchase will appear below once it clears.' });
    };
    tick();
    return () => { active = false; };
  }, [checked, checkoutIntent, sb, load]);

  async function download(p: Purchase) {
    setDownloading(p.order_id);
    try {
      const { data: path, error } = await sb.rpc('shop_deliverable_path', { p_order_id: p.order_id });
      if (error || !path) throw error || new Error('no_path');
      const { data: signed, error: sErr } = await sb.storage.from('shop-files').createSignedUrl(path as string, 3600, { download: true });
      if (sErr || !signed?.signedUrl) throw sErr || new Error('no_url');
      window.location.href = signed.signedUrl;
    } catch {
      alert('Could not start the download. Please try again.');
    } finally {
      setDownloading(null);
    }
  }

  if (!checked) return <main className="purchases"><div className="feed-empty">Loading…</div></main>;

  return (
    <main className="purchases">
      <h1>Your purchases</h1>
      {banner ? <div className={`pbanner ${banner.kind}`}>{banner.text}</div> : null}
      {items === null ? (
        <div className="feed-empty">Loading…</div>
      ) : items.length === 0 ? (
        <div className="state"><h2 style={{ fontSize: 18 }}>No purchases yet</h2><p>Beats and songs you buy will show up here to download.</p></div>
      ) : (
        <div className="plist">
          {items.map((p) => (
            <div className="prow" key={p.order_id}>
              <Link href={`/listing/${p.listing_id}`} className="part" style={!p.cover_url ? { background: gradientFor(p.listing_id) } : undefined}>
                {p.cover_url ? <img src={p.cover_url} alt="" /> : null}
              </Link>
              <div className="pinfo2">
                <b>{p.title}</b>
                <span>{CATEGORY_LABEL[p.category as keyof typeof CATEGORY_LABEL] || 'Beat'}{p.kind === 'lease' ? ' · Lease' : p.kind === 'sell' ? ' · Exclusive' : ''}{p.seller_username ? ` · @${p.seller_username}` : ''}</span>
              </div>
              <button className="btn btn-primary pdl" disabled={downloading === p.order_id} onClick={() => download(p)}>
                {downloading === p.order_id ? 'Preparing…' : 'Download'}
              </button>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

export default function PurchasesPage() {
  return (
    <Suspense fallback={<main className="purchases"><div className="feed-empty">Loading…</div></main>}>
      <PurchasesInner />
    </Suspense>
  );
}
