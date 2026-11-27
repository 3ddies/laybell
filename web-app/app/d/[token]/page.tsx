'use client';
import { useEffect, useRef, useState } from 'react';
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
  // The signed URL lives 1h; cache the one minted during on-load validation and reuse it on
  // click (re-minting only once it's aged past ~55min) instead of minting a second URL.
  const cached = useRef<{ url: string; at: number } | null>(null);

  async function getUrl(): Promise<string | null> {
    if (cached.current && Date.now() - cached.current.at < 55 * 60 * 1000) return cached.current.url;
    const { data, error } = await sb.functions.invoke('shop-guest-download', { body: { token: params.token } });
    if (error || (data as any)?.error || !(data as any)?.url) return null;
    if ((data as any)?.title) setTitle((data as any).title as string);
    const url = (data as any).url as string;
    cached.current = { url, at: Date.now() };
    return url;
  }

  useEffect(() => {
    let active = true;
    (async () => { const url = await getUrl(); if (active) setState(url ? 'ready' : 'err'); })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function download() {
    setState('busy');
    const url = await getUrl();
    if (!url) { setState('err'); return; }
    const a = document.createElement('a'); a.href = url; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setState('ready');
  }

  return (
    <main className="purchases">
      <h1>Your download</h1>

      {state === 'checking' ? (
        <div className="pstatus">
          <span className="cspin big" />
          <div className="ptext">Checking your link…</div>
        </div>
      ) : state === 'err' ? (
        <div className="pstatus">
          <div className="pbanner err" style={{ marginBottom: 0 }}>This download link is invalid or has expired. If you just bought, check your email for the latest link.</div>
          <p className="lnote"><Link href="/market">Browse more beats →</Link></p>
        </div>
      ) : (
        <div className="pstatus">
          <div className="pcheck"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.2 4.3L19 7" /></svg></div>
          <div className="ptext">{title || 'Your beat'}</div>
          <div className="psub">Ready to download — this link stays valid, so keep it.</div>
          <button className="btn btn-primary lbuy" disabled={state === 'busy'} onClick={download}>
            {state === 'busy' ? <><span className="cspin" /> Preparing…</> : 'Download your beat'}
          </button>
          <p className="lnote"><Link href="/market">Browse more beats →</Link></p>
        </div>
      )}
    </main>
  );
}
