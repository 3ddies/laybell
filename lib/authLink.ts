import * as Linking from 'expo-linking';
import { supabase } from './supabase';

// Confirmation-email LINK handling.
//
// Two ways to confirm an email: type the code (app/(auth)/verify-email.tsx), or
// tap the link in the email. The link used to dead-end — Supabase confirmed the
// address in a browser and the user was left staring at a web page with no sign
// that anything had happened, and no session in the app.
//
// Now signup passes emailRedirectTo (see authRedirectUrl below), so Supabase
// bounces back into the app after confirming. This module turns that inbound URL
// into a real session.
//
// The client is created with detectSessionInUrl:false (correct for native — there
// is no window.location to read), so nothing establishes the session for us.

/** Where Supabase should send the user after it confirms the email. */
export function authRedirectUrl(): string {
  // laybell://auth-callback in a standalone build; an exp:// URL in Expo Go.
  return Linking.createURL('auth-callback');
}

/** Params can arrive in the query string OR the fragment, depending on flow. */
function paramsOf(url: string): URLSearchParams {
  const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1).split('#')[0] : '';
  const frag = url.includes('#') ? url.slice(url.indexOf('#') + 1) : '';
  return new URLSearchParams([...new URLSearchParams(qs), ...new URLSearchParams(frag)]);
}

export type AuthLinkResult =
  | { kind: 'verified' }        // session established — the user is now signed in
  | { kind: 'error'; message: string }
  | { kind: 'ignored' };        // not an auth link; leave it to other handlers

/**
 * Establish a session from a Supabase auth redirect. Handles all three shapes
 * Supabase can send, so this keeps working if the project's flow type changes:
 *   · access_token + refresh_token  (implicit flow)
 *   · code                          (PKCE flow)
 *   · token_hash + type             (verify-link flow)
 */
export async function handleAuthLink(url: string): Promise<AuthLinkResult> {
  if (!url) return { kind: 'ignored' };
  const p = paramsOf(url);

  const err = p.get('error_description') || p.get('error');
  if (err) return { kind: 'error', message: err.replace(/\+/g, ' ') };

  const access_token = p.get('access_token');
  const refresh_token = p.get('refresh_token');
  if (access_token && refresh_token) {
    const { error } = await supabase.auth.setSession({ access_token, refresh_token });
    return error ? { kind: 'error', message: error.message } : { kind: 'verified' };
  }

  const code = p.get('code');
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    return error ? { kind: 'error', message: error.message } : { kind: 'verified' };
  }

  const token_hash = p.get('token_hash');
  const type = p.get('type');
  if (token_hash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash, type: type as any });
    return error ? { kind: 'error', message: error.message } : { kind: 'verified' };
  }

  return { kind: 'ignored' };
}
