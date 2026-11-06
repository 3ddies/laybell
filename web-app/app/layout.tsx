import './globals.css';
import type { Metadata } from 'next';
import { Bricolage_Grotesque, Hanken_Grotesk } from 'next/font/google';
import AuthNav from './AuthNav';
import SearchBox from './SearchBox';

const display = Bricolage_Grotesque({ subsets: ['latin'], variable: '--f-display', display: 'swap', weight: ['400', '600', '700', '800'] });
const body = Hanken_Grotesk({ subsets: ['latin'], variable: '--f-body', display: 'swap', weight: ['400', '500', '600', '700', '800'] });

export const metadata: Metadata = {
  title: { default: 'Laybell', template: '%s · Laybell' },
  description: 'Real music, real artists. Albums, singles, films and live — not just a feed.',
};

const OPEN = 'https://laybell.app/open.html';

function Bell() {
  // The real Laybell mark (bell + note on the brand gradient), copied to /public.
  return <img className="logo-img" src="/logo.png" alt="" aria-hidden="true" />;
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>
        <header className="topbar">
          <div className="wrap">
            <a className="brand" href="/">
              <Bell /> Laybell
            </a>
            <SearchBox />
            <div className="top-actions">
              <a className="navlink shoplink" href="/market">Shop</a>
              <button className="icon-btn" id="themeBtn" title="Toggle theme" aria-label="Toggle theme">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
              </button>
              <AuthNav />
              <a className="btn btn-primary" href={OPEN}>Get the app</a>
            </div>
          </div>
        </header>

        {children}

        <footer className="site">
          <div className="wrap">
            <div className="foot-brand">
              <div className="bl"><Bell /> Laybell</div>
              <p>Real music, real artists. Albums, singles, films and live — not just a feed.</p>
            </div>
            <div className="foot-col"><h4>Laybell</h4><a href="/market">Shop</a><a href={OPEN}>Get the app</a><a href="https://laybell.app/advertising.html">Advertise</a></div>
            <div className="foot-col"><h4>Legal</h4><a href="https://laybell.app/privacy.html">Privacy</a><a href="https://laybell.app/terms.html">Terms</a><a href="https://laybell.app/community.html">Guidelines</a><a href="https://laybell.app/payouts.html">Payouts</a></div>
            <div className="foot-bottom"><span>© 2026 Laybell LLC</span><span>English (US)</span></div>
          </div>
        </footer>

        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem('lb-theme');if(s)document.documentElement.setAttribute('data-theme',s);}catch(e){}
var b=document.getElementById('themeBtn');if(b)b.addEventListener('click',function(){var r=document.documentElement;var dark=r.getAttribute('data-theme')==='dark'||(!r.getAttribute('data-theme')&&matchMedia('(prefers-color-scheme: dark)').matches);var n=dark?'light':'dark';r.setAttribute('data-theme',n);try{localStorage.setItem('lb-theme',n);}catch(e){}});})();`,
          }}
        />
      </body>
    </html>
  );
}
