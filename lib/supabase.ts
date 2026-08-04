import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

// Exported for direct REST calls (e.g. resumable/progress uploads in lib/upload.ts).
export const supabaseUrl = 'https://wawpaokvtptfmuygjnns.supabase.co';
export const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indhd3Bhb2t2dHB0Zm11eWdqbm5zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5MDgyNjMsImV4cCI6MjA5NTQ4NDI2M30.78PkYUy1rnoGUvqKSF85QWqbFQF9Kfy2PV3Fzs0nPZY';

// ─── Request timeouts ──────────────────────────────────────────────────────────
// React Native's fetch has NO default timeout. On a stalled connection (a dead
// spot, a captive portal, a handoff between towers) the socket neither delivers
// nor errors, so the promise never settles — it just hangs. That is the single
// worst bad-network failure mode in the app, because a promise that never
// settles never reaches a `.catch()` or a `finally`: the screens that were
// hardened to clear their skeletons on failure still spin forever, since the
// failure never arrives. Giving every request a deadline is what makes all of
// that existing recovery actually fire.
//
// Two budgets, because one size genuinely doesn't fit:
//   • Normal calls (PostgREST queries, RPCs, auth) are small JSON round-trips.
//     20s is far beyond a healthy request even on 2G, so a request that blows
//     it is stuck, not slow.
//   • Storage object writes are multi-megabyte uploads on a slow uplink and can
//     legitimately run for minutes. They get their own, much larger budget so
//     this never turns a working upload into a failed one.
const REQUEST_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

function timedFetch(input: any, init?: any): Promise<Response> {
  const url = typeof input === 'string' ? input : (input?.url ?? '');
  // Storage object reads/writes — the only calls that carry a file body.
  const isStorageObject = typeof url === 'string' && url.includes('/storage/v1/object');
  const budget = isStorageObject ? UPLOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS;

  const ctrl = new AbortController();
  // Callers can pass their own signal (PostgREST's `.abortSignal()` — the
  // explore search uses it to cancel superseded queries). Chain it rather than
  // replace it, so BOTH the caller's cancel and our deadline can abort.
  const caller: AbortSignal | undefined | null = init?.signal;
  if (caller) {
    if (caller.aborted) ctrl.abort();
    // Defensive: this runs on every single request, so an environment whose
    // AbortSignal lacks addEventListener must degrade to "our deadline still
    // works" rather than throw and take down all networking.
    else if (typeof caller.addEventListener === 'function') {
      caller.addEventListener('abort', () => ctrl.abort(), { once: true });
    } else {
      const prev = (caller as any).onabort;
      (caller as any).onabort = (...a: any[]) => { try { prev?.(...a); } finally { ctrl.abort(); } };
    }
  }

  const timer = setTimeout(() => ctrl.abort(), budget);
  return fetch(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
  global: { fetch: timedFetch as any },
});