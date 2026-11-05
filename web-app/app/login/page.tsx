'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { browserSb } from '@/lib/supabaseBrowser';

export default function LoginPage() {
  const router = useRouter();
  const sb = browserSb();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    sb.auth.getSession().then(({ data }) => { if (data.session) router.replace('/home'); });
  }, [sb, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null); setOk(null);
    try {
      if (mode === 'in') {
        const { error } = await sb.auth.signInWithPassword({ email, password: pw });
        if (error) throw error;
        router.replace('/home');
      } else {
        const { data, error } = await sb.auth.signUp({ email, password: pw });
        if (error) throw error;
        if (data.session) router.replace('/home');
        else setOk('Check your email to confirm your account, then sign in.');
      }
    } catch (e: any) {
      setErr(e?.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function oauth(provider: 'google' | 'apple') {
    setErr(null);
    const { error } = await sb.auth.signInWithOAuth({ provider, options: { redirectTo: window.location.origin + '/home' } });
    if (error) setErr(error.message + ' — the web URL may need adding to Supabase Auth redirect URLs.');
  }

  return (
    <main className="auth">
      <div className="authcard">
        <img className="logo-img" src="/logo.png" alt="Laybell" />
        <h1>{mode === 'in' ? 'Log in to Laybell' : 'Create your account'}</h1>
        <p className="authsub">{mode === 'in' ? 'Welcome back.' : 'Join the music.'}</p>

        <form onSubmit={submit}>
          <label className="field"><span>Email</span>
            <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </label>
          <label className="field"><span>Password</span>
            <input type="password" autoComplete={mode === 'in' ? 'current-password' : 'new-password'} required minLength={6} value={pw} onChange={(e) => setPw(e.target.value)} placeholder="••••••••" />
          </label>
          {err ? <div className="authmsg err">{err}</div> : null}
          {ok ? <div className="authmsg ok">{ok}</div> : null}
          <button className="btn btn-primary submit" type="submit" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'in' ? 'Log in' : 'Sign up'}
          </button>
        </form>

        <div className="sep">or</div>
        <div className="oauth">
          <button className="btn btn-ghost" onClick={() => oauth('google')} type="button">
            <svg viewBox="0 0 24 24" width="17" height="17"><path fill="#4285F4" d="M23 12.3c0-.8-.1-1.5-.2-2.3H12v4.5h6.2a5.3 5.3 0 0 1-2.3 3.5v2.9h3.7C21.7 19 23 16 23 12.3Z"/><path fill="#34A853" d="M12 24c3.1 0 5.7-1 7.6-2.8l-3.7-2.9c-1 .7-2.3 1.1-3.9 1.1-3 0-5.5-2-6.4-4.8H1.8v3C3.7 21.4 7.6 24 12 24Z"/><path fill="#FBBC05" d="M5.6 14.6a7.2 7.2 0 0 1 0-4.6v-3H1.8a12 12 0 0 0 0 10.6l3.8-3Z"/><path fill="#EA4335" d="M12 4.8c1.7 0 3.2.6 4.4 1.7l3.3-3.3C17.7 1.2 15.1 0 12 0 7.6 0 3.7 2.6 1.8 6.4l3.8 3C6.5 6.7 9 4.8 12 4.8Z"/></svg>
            Google
          </button>
          <button className="btn btn-ghost" onClick={() => oauth('apple')} type="button">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M16.3 12.8c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9-.7 0-1.8-.8-3-.8-1.5 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.8 3-.8s1.8.8 3 .7c1.2 0 2-1.1 2.8-2.2.9-1.3 1.2-2.5 1.3-2.6-.1 0-2.5-1-2.5-3.8ZM14 6.3c.6-.8 1-1.9.9-3-.9 0-2 .6-2.7 1.4-.6.7-1.1 1.8-1 2.9 1 .1 2.1-.5 2.8-1.3Z"/></svg>
            Apple
          </button>
        </div>

        <div className="authtoggle">
          {mode === 'in' ? 'New to Laybell? ' : 'Already have an account? '}
          <button type="button" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setErr(null); setOk(null); }}>
            {mode === 'in' ? 'Create one' : 'Log in'}
          </button>
        </div>
      </div>
    </main>
  );
}
