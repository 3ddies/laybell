import './globals.css';
import type { Metadata } from 'next';
import { Inter, Nunito } from 'next/font/google';
import AuthNav from './AuthNav';
import SearchBox from './SearchBox';

// Inter is the site's one UI/display face — clean, iOS/SF-Pro feel, the same look
// the music tab uses. globals.css aliases --f-display and --f-body to --f-ui, so
// every title + body on the site runs on it (TV, shop, explore, …). The owner
// loved this on /music and asked to make it site-wide (2026-11-21).
const ui = Inter({ subsets: ['latin'], variable: '--f-ui', display: 'swap', weight: ['400', '500', '600', '700', '800', '900'] });
// Nunito — kept ONLY for the LAYBELL wordmark lockup (topbar + hero brand).
const logo = Nunito({ subsets: ['latin'], variable: '--f-logo', display: 'swap', weight: ['700', '800', '900'] });

export const metadata: Metadata = {
  title: { default: 'Laybell', template: '%s · Laybell' },
  description: 'Laybell is the home for music creators — drop albums and singles, sell and lease beats, go live, and grow your audience.',
};

const OPEN = 'https://laybell.app/open.html';

function Bell() {
  // The real Laybell mark (bell + note on the brand gradient), copied to /public.
  return <img className="logo-img" src="/logo.png" alt="" aria-hidden="true" />;
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning className={`${ui.variable} ${logo.variable}`}>
      <body>
        <header className="topbar">
          <div className="wrap">
            <a className="brand" href="/">
              <Bell /> Laybell
            </a>
            <SearchBox />
            <div className="top-actions">
              <a className="navlink shoplink" href="/market">Shop</a>
              <AuthNav />
              <a className="btn btn-primary" href={OPEN} target="_blank" rel="noopener noreferrer">Get the app</a>
            </div>
          </div>
        </header>

        {children}

        <footer className="site">
          <div className="wrap">
            <div className="foot-brand">
              <div className="bl"><Bell /> Laybell</div>
              <p>The home for music creators. Make music, sell beats, go live.</p>
            </div>
            <div className="foot-col"><h4>Laybell</h4><a href="/market">Shop</a><a href={OPEN} target="_blank" rel="noopener noreferrer">Get the app</a><a href="https://laybell.app/advertising.html">Advertise</a></div>
            <div className="foot-col"><h4>Legal</h4><a href="https://laybell.app/privacy.html">Privacy</a><a href="https://laybell.app/terms.html">Terms</a><a href="https://laybell.app/community.html">Guidelines</a><a href="https://laybell.app/payouts.html">Payouts</a></div>
            <div className="foot-bottom"><span>© 2026 Laybell LLC</span><span>English (US)</span></div>
          </div>
        </footer>
      </body>
    </html>
  );
}
