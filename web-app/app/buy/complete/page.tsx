'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { browserSb } from '@/lib/supabaseBrowser';
import { clearCheckout } from '@/lib/cart';

// Guest checkout success page. Stripe redirects here with ?i=<guest intent id> (single buy-now)
// or ?c=<guest cart id> (cart of N beats). We poll until the webhook has delivered (or refunded),
// then reveal an instant download for every beat. The buyer also gets the same link(s) by email,
// so this page is a convenience, not the only copy.
function CompleteInner() {
  const sb = browserSb();
  const sp = useSearchParams();
  const intentId = sp.get('i');
  const cartId = sp.get('c');
  const [state, setState] = useState<'wait' | 'ready' | 'refunded' | 'err'>('wait');
  const [downloads, setDownloads] = useState<Array<{ token: string; title: string }>>([]);
  const [dl, setDl] = useState<string | null>(null);     // the token currently preparing
  const [dlErr, setDlErr] = useState<string | null>(null);

  useEffect(() => {
    if (!intentId && !cartId) { setState('err'); return; }
    let tries = 0; let active = true;
    const tick = async () => {
      if (!active) return;
      const { data, error } = cartId
        ? await sb.rpc('shop_poll_stripe_guest_cart', { p_cart_id: cartId })
        : await sb.rpc('shop_poll_stripe_guest', { p_intent_id: intentId });
      if (error) { setState('err'); return; }
      const d = data as any;
      if (d?.delivered) {
        if (cartId) {
          setDownloads(Array.isArray(d.downloads) ? d.downloads : []);
          try { clearCheckout(cartId); } catch { /* storage blocked */ }
        } else if (d.download_token) {
          setDownloads([{ token: d.download_token as string, title: '' }]);
        }
        setState('ready'); return;
      }
      if (d?.refunded || d?.status === 'failed') { setState('refunded'); return; }
      // Poll ~90s with gentle backoff (1.5s → 3s). Webhook delivery can lag under Stripe load;
      // don't declare failure early. If it's still not confirmed, the emailed link is the fallback.
      tries++;
      if (tries < 45) setTimeout(tick, tries < 20 ? 1500 : 3000);
      else setState('err');
    };
    tick();
    return () => { active = false; };
  }, [intentId, cartId, sb]);

  async function download(token: string) {
    setDl(token); setDlErr(null);
    try {
      const { data, error } = await sb.functions.invoke('shop-guest-download', { body: { token } });
      if (error || (data as any)?.error || !(data as any)?.url) throw new Error('download_failed');
      const a = document.createElement('a'); a.href = (data as any).url as string; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
    } catch {
      setDlErr('Couldn’t start the download here — use the link we emailed you.');
    } finally { setDl(null); }
  }

  const many = downloads.length > 1;

  return (
    <main className="purchases">
      <h1>Your purchase</h1>

      {state === 'wait' ? (
        <div className="pstatus">
          <span className="cspin big" />
          <div className="ptext">Completing your purchase…</div>
          <div className="psub">This only takes a moment — hang tight.</div>
        </div>
      ) : null}

      {state === 'ready' ? (
        <div className="pstatus">
          <div className="pcheck"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.2 4.3L19 7" /></svg></div>
          <div className="ptext">Purchased!</div>
          <div className="psub">We’ve emailed your {many ? 'download links' : 'download link'} too — keep {many ? 'them' : 'it'} as your receipt.</div>
          {downloads.map((d) => (
            <button key={d.token} className="btn btn-primary lbuy" disabled={dl === d.token} onClick={() => download(d.token)}>
              {dl === d.token ? <><span className="cspin" /> Preparing…</> : (d.title ? `Download ${d.title}` : 'Download your beat')}
            </button>
          ))}
          {dlErr ? <div className="pberr">{dlErr}</div> : null}
          <p className="lnote">Want all your purchases in one place next time? <Link href="/login">Create a free account.</Link></p>
        </div>
      ) : null}

      {state === 'refunded' ? (
        <div className="pstatus">
          <div className="pbanner refund" style={{ marginBottom: 0 }}>That purchase couldn’t be completed and your card was refunded.</div>
        </div>
      ) : null}

      {state === 'err' ? (
        <div className="pstatus">
          <div className="pbanner wait" style={{ marginBottom: 0 }}>Still finishing up — your {cartId ? 'downloads are' : 'download link is'} also on the way by email, so you won’t lose {cartId ? 'them' : 'it'}. You can safely close this page.</div>
        </div>
      ) : null}
    </main>
  );
}

export default function GuestCompletePage() {
  return (
    <Suspense fallback={<main className="purchases"><div className="pstatus"><span className="cspin big" /><div className="ptext">Loading…</div></div></main>}>
      <CompleteInner />
    </Suspense>
  );
}
