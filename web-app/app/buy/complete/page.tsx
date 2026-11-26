'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { browserSb } from '@/lib/supabaseBrowser';

// Guest checkout success page. Stripe redirects here with ?i=<guest intent id>. We poll until
// the webhook has delivered (or refunded), then reveal an instant download. The buyer also
// gets the same link by email, so this page is a convenience, not the only copy.
function CompleteInner() {
  const sb = browserSb();
  const intentId = useSearchParams().get('i');
  const [state, setState] = useState<'wait' | 'ready' | 'refunded' | 'err'>('wait');
  const [token, setToken] = useState<string | null>(null);
  const [dl, setDl] = useState(false);

  useEffect(() => {
    if (!intentId) { setState('err'); return; }
    let tries = 0; let active = true;
    const tick = async () => {
      if (!active) return;
      const { data, error } = await sb.rpc('shop_poll_stripe_guest', { p_intent_id: intentId });
      if (error) { setState('err'); return; }
      if ((data as any)?.delivered && (data as any)?.download_token) { setToken((data as any).download_token); setState('ready'); return; }
      if ((data as any)?.refunded || (data as any)?.status === 'failed') { setState('refunded'); return; }
      if (tries++ < 25) setTimeout(tick, 1500);
      else setState('err');
    };
    tick();
    return () => { active = false; };
  }, [intentId, sb]);

  async function download() {
    if (!token) return;
    setDl(true);
    try {
      const { data, error } = await sb.functions.invoke('shop-guest-download', { body: { token } });
      if (error || (data as any)?.error || !(data as any)?.url) throw new Error('download_failed');
      const a = document.createElement('a'); a.href = (data as any).url as string; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
    } catch {
      alert('Could not start the download here — please use the link we emailed you.');
    } finally { setDl(false); }
  }

  return (
    <main className="purchases">
      <h1>Your purchase</h1>
      {state === 'wait' ? <div className="pbanner wait">Completing your purchase…</div> : null}
      {state === 'refunded' ? <div className="pbanner refund">That purchase couldn’t be completed and your card was refunded.</div> : null}
      {state === 'err' ? <div className="pbanner err">We couldn’t confirm this purchase yet — check the email we sent for your download link.</div> : null}
      {state === 'ready' ? (
        <>
          <div className="pbanner ok">Purchased! We’ve also emailed your download link — keep it as your receipt.</div>
          <button className="btn btn-primary lbuy" disabled={dl} onClick={download}>{dl ? 'Preparing…' : 'Download your beat'}</button>
          <p className="lnote">Want all your purchases in one place next time? <Link href="/login">Create a free account.</Link></p>
        </>
      ) : null}
    </main>
  );
}

export default function GuestCompletePage() {
  return (
    <Suspense fallback={<main className="purchases"><div className="feed-empty">Loading…</div></main>}>
      <CompleteInner />
    </Suspense>
  );
}
