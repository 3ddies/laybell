import Link from 'next/link';
import { thumbFor, gradientFor, initial, formatCount, type GridPost } from '@/lib/format';

export function Avatar({ url, name, handle, tier, size = 168 }: {
  url?: string | null; name?: string | null; handle?: string | null; tier?: string | null; size?: number;
}) {
  const ring = tier === 'diamond' ? 'diamond' : tier === 'gold' ? 'gold' : 'plain';
  const pad = size > 120 ? 4 : 3;
  return (
    <div className={`av-wrap ${ring}`} style={{ width: size, height: size, padding: pad }}>
      <div className="av" style={{ fontSize: Math.round(size * 0.37) }}>
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
