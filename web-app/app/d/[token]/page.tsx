'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { browserSb } from '@/lib/supabaseBrowser';

// The durable guest download page — the target of the link we email after a guest purchase.
// The token in the path is the credential; shop-guest-download validates it (service role) and
// returns a short-lived signed URL. We validate on load (so a bad/expired link shows an error),
// then download on click.
export default function GuestDownloadPage({ params }: { params: { token: string } }) {
  const sb = browserSb();
  const [state, setState] = useState<'checking' | 'ready' | 'busy' | 'err'>('checking');
  const [title, setTitle] = useState<string | null>(null);

  async function fetchUrl(): Promise<string | null> {
    const { data, error } = await sb.functions.invoke('shop-guest-download', { body: { token: params.token } });
    if (error || (data as any)?.error || !(data as any)?.url) return null;
    if ((data as any)?.title) setTitle((data as any).title as string);
    return (data as any).url as string;
  }

  useEffect(() => {
    let active = true;
    (async () => { const url = await fetchUrl(); if (active) setState(url ? 'ready' : 'err'); })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function download() {
    setState('busy');
    const url = await fetchUrl();
    if (!url) { setState('err'); return; }
    const a = document.createElement('a'); a.href = url; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setState('ready');
  }

  return (
    <main className="purchases">
      <h1>Your download</h1>
      {state === 'err' ? (
        <div className="pbanner err">This download link is invalid or has expired. If you just bought, check your email for the latest link.</div>
      ) : (
        <>
          {title ? <div className="pbanner ok">{title} — ready to download.</div> : null}
          <button className="btn btn-primary lbuy" disabled={state === 'checking' || state === 'busy'} onClick={download}>
            {state === 'checking' ? 'Checking…' : state === 'busy' ? 'Preparing…' : 'Download your beat'}
          </button>
        </>
      )}
      <p className="lnote"><Link href="/market">Browse more beats →</Link></p>
    </main>
  );
}
