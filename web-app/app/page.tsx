import Link from 'next/link';
import { OpenCTA } from './components';

export const metadata = { title: 'Laybell — real music, real artists' };

export default function Home() {
  return (
    <main className="wrap" style={{ paddingBlock: '56px 64px' }}>
      <section style={{ maxWidth: 640 }}>
        <h1 style={{ fontSize: 'clamp(34px, 6vw, 58px)', lineHeight: 1.02, letterSpacing: '-.03em' }}>
          Real music.<br /><span style={{ background: 'linear-gradient(135deg,var(--accent-deep),var(--accent-warm))', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>Real artists.</span>
        </h1>
        <p style={{ color: 'var(--muted)', fontSize: 18, lineHeight: 1.5, marginTop: 18, maxWidth: 520 }}>
          Albums, singles, films and live — not just a feed. Browse artists and posts on the web, or get the app to listen, post and go live.
        </p>
        <div style={{ display: 'flex', gap: 10, marginTop: 24, flexWrap: 'wrap' }}>
          <OpenCTA label="Get the app" />
          <Link className="btn btn-ghost" href="/@3ddie">Browse a profile</Link>
        </div>
      </section>

      <section style={{ marginTop: 52 }}>
        <h2 style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--faint)', fontWeight: 700 }}>Explore</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12, marginTop: 14 }}>
          {[
            { href: '/@3ddie', label: '@3ddie', sub: 'Artist' },
            { href: '/c/gaming', label: '#gaming', sub: 'Community' },
            { href: '/c/entertainment', label: '#entertainment', sub: 'Community' },
            { href: '/c/education', label: '#education', sub: 'Community' },
          ].map((x) => (
            <Link key={x.href} href={x.href} style={{ border: '1px solid var(--border-2)', borderRadius: 14, padding: '16px 16px', background: 'var(--surface-2)', display: 'block' }}>
              <div style={{ fontFamily: 'var(--f-display)', fontWeight: 700, fontSize: 17 }}>{x.label}</div>
              <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 2 }}>{x.sub}</div>
            </Link>
          ))}
        </div>
        <p style={{ color: 'var(--faint)', fontSize: 13, marginTop: 20 }}>
          Prototype of Laybell on the web (Tier 1 — public, read-only). Login, feed and posting come next.
        </p>
      </section>
    </main>
  );
}
