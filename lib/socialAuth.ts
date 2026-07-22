import { Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as AppleAuthentication from 'expo-apple-authentication';
import type { User } from '@supabase/supabase-js';
import { supabase } from './supabase';

// ── Express login (Google OAuth + native Sign in with Apple) ─────────────────
// Google runs Supabase's OAuth flow in an in-app auth session and hands the
// callback straight back over the app scheme; Apple uses the native sheet and
// exchanges its identity token directly (no browser). Either way the session
// lands in the SAME supabase client the rest of the app uses, so the root
// auth listener takes over from there.
//
// Requires (one-time, dashboard-side):
//  • Supabase → Auth → URL Configuration → add laybell://auth-callback to
//    the Redirect URLs allow-list.
//  • Supabase → Auth → Providers → Google: client id + secret from Google
//    Cloud Console (authorized redirect = the Supabase /auth/v1/callback URL).
//  • Supabase → Auth → Providers → Apple: add the iOS bundle id to Client IDs.
//  • A dev-client rebuild (expo-web-browser + expo-apple-authentication are
//    native modules; app.json gained the Apple plugin + usesAppleSignIn).

WebBrowser.maybeCompleteAuthSession();

const REDIRECT_URL = 'laybell://auth-callback';

// ── Native Google Sign-In config ─────────────────────────────────────────────
// From Google Cloud Console → Credentials (both under the same project):
//  • WEB client ("Laybell Supabase") — its ID goes here AND in the Supabase
//    Google provider's Client IDs field (it is the idToken's audience).
//  • iOS client (bundle id com.laybell.app) — its ID goes here, and its
//    REVERSED form (com.googleusercontent.apps.<id-prefix>) goes into the
//    app.json plugin entry as iosUrlScheme.
// While either is empty, signInWithGoogle uses the browser-based Supabase
// OAuth flow instead — so nothing breaks before the console setup + rebuild.
const GOOGLE_WEB_CLIENT_ID = '102825886853-k3lr1b25akbgvvobe9tr1srdk16odf4k.apps.googleusercontent.com';
const GOOGLE_IOS_CLIENT_ID = '102825886853-qmqp3uea0vqgljigkhtdhnbq0tjqkur7.apps.googleusercontent.com';

export type SocialAuthResult = { error?: string; cancelled?: boolean };

// Lazily resolved so clients built BEFORE the native module existed fall back
// to the web flow instead of crashing at import time.
let googleModCache: any | undefined;
function getGoogleSigninModule(): any | null {
  if (googleModCache !== undefined) return googleModCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    googleModCache = require('@react-native-google-signin/google-signin');
  } catch {
    googleModCache = null;
  }
  return googleModCache;
}

let googleConfigured = false;

/**
 * Native Google sheet (no browser, no system consent dialog) when the client
 * IDs are set and the native module is present; otherwise the Supabase
 * browser OAuth flow. Both land the session in the same supabase client.
 */
export async function signInWithGoogle(): Promise<SocialAuthResult> {
  if (GOOGLE_WEB_CLIENT_ID && GOOGLE_IOS_CLIENT_ID) {
    const mod = getGoogleSigninModule();
    if (mod?.GoogleSignin) {
      try {
        const { GoogleSignin } = mod;
        if (!googleConfigured) {
          GoogleSignin.configure({ webClientId: GOOGLE_WEB_CLIENT_ID, iosClientId: GOOGLE_IOS_CLIENT_ID });
          googleConfigured = true;
        }
        // Android-only Play Services gate; resolves trivially on iOS.
        await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true }).catch(() => {});
        const res: any = await GoogleSignin.signIn();
        if (res?.type === 'cancelled') return { cancelled: true };
        // v13+ wraps the account in {type:'success', data}; older shapes are flat.
        const idToken = res?.data?.idToken ?? res?.idToken ?? null;
        if (idToken) {
          const { error } = await supabase.auth.signInWithIdToken({ provider: 'google', token: idToken });
          return error ? { error: error.message } : {};
        }
        // Signed in natively but no idToken (misconfigured webClientId) — the
        // web flow below still works, so fall through rather than dead-end.
      } catch (e: any) {
        if (e?.code === mod?.statusCodes?.SIGN_IN_CANCELLED) return { cancelled: true };
        // Native side missing (pre-rebuild client) or SDK error → web fallback.
      }
    }
  }
  return signInWithGoogleWeb();
}

async function signInWithGoogleWeb(): Promise<SocialAuthResult> {
  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: REDIRECT_URL, skipBrowserRedirect: true },
    });
    if (error || !data?.url) return { error: error?.message ?? 'Could not start sign-in' };

    const res = await WebBrowser.openAuthSessionAsync(data.url, REDIRECT_URL);
    if (res.type !== 'success' || !('url' in res) || !res.url) {
      return res.type === 'cancel' || res.type === 'dismiss' ? { cancelled: true } : { error: 'Sign-in was interrupted' };
    }

    // The callback carries either ?code= (PKCE) or #access_token=… (implicit)
    // depending on the project's flow type — accept both.
    const url = new URL(res.url);
    const code = url.searchParams.get('code');
    if (code) {
      const { error: exErr } = await supabase.auth.exchangeCodeForSession(code);
      return exErr ? { error: exErr.message } : {};
    }
    const frag = new URLSearchParams((url.hash || '').replace(/^#/, ''));
    const access_token = frag.get('access_token');
    const refresh_token = frag.get('refresh_token');
    if (access_token && refresh_token) {
      const { error: setErr } = await supabase.auth.setSession({ access_token, refresh_token });
      return setErr ? { error: setErr.message } : {};
    }
    const oauthErr = url.searchParams.get('error_description') ?? frag.get('error_description');
    return { error: oauthErr ?? 'No session in the sign-in callback' };
  } catch (e: any) {
    return { error: e?.message ?? 'Sign-in failed' };
  }
}

// ── Apple Sign-In (restored — ships in the INTERACTIVE build) ────────────────
// The com.apple.developer.applesignin entitlement must be registered on the
// App ID, which only happens during an INTERACTIVE `eas build` (Apple login).
// This code + the app.json plugin/usesAppleSignIn config are now in place; the
// next `npx eas-cli build --platform ios --profile development` run WITH an
// Apple sign-in at the prompts registers the capability and regenerates the
// provisioning profile. (Do NOT run that build non-interactively — it fails at
// code-signing until the capability exists; that's what burned builds #1/#2.)

/** Native Apple sheet — iOS only, and only where the capability is present. */
export async function appleSignInAvailable(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  try { return await AppleAuthentication.isAvailableAsync(); } catch { return false; }
}

export async function signInWithApple(): Promise<SocialAuthResult> {
  try {
    const cred = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
    if (!cred.identityToken) return { error: 'Apple returned no identity token' };
    const { error } = await supabase.auth.signInWithIdToken({ provider: 'apple', token: cred.identityToken });
    if (error) return { error: error.message };
    // Apple shares the name ONLY on the very first authorization — stash it in
    // auth metadata now so the starter profile below can use it.
    const name = [cred.fullName?.givenName, cred.fullName?.familyName].filter(Boolean).join(' ').trim();
    if (name) await supabase.auth.updateUser({ data: { full_name: name } }).catch(() => {});
    return {};
  } catch (e: any) {
    if (e?.code === 'ERR_REQUEST_CANCELED') return { cancelled: true };
    return { error: e?.message ?? 'Sign-in failed' };
  }
}

// ── Starter profile for OAuth first-timers ───────────────────────────────────
// Email signups carry username/display_name in the signup metadata (the server
// trigger builds the profiles row from it). OAuth users don't — so when a
// session exists with no profile row (or a row with no username), derive a
// starter identity from the OAuth account: display name from the provider,
// username from the email local-part (sanitized, collision-suffixed). The user
// then flows through the normal onboarding (onboarded=false) and can change
// the username any time in Edit Profile.
export async function ensureProfileForSession(user: User): Promise<void> {
  try {
    const { data: existing } = await supabase
      .from('profiles').select('id, username').eq('id', user.id).maybeSingle();
    if (existing?.username) return;

    const meta: any = user.user_metadata ?? {};
    const displayName = String(
      meta.full_name || meta.name || meta.display_name || user.email?.split('@')[0] || 'Artist',
    ).slice(0, 40);
    let base = String(meta.username || user.email?.split('@')[0] || 'artist')
      .toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24);
    if (base.length < 5) base = (base + 'artist').slice(0, 24);

    for (let attempt = 0; attempt < 5; attempt++) {
      const username = attempt === 0 ? base : `${base}${Math.floor(1000 + Math.random() * 9000)}`.slice(0, 30);
      const { error } = existing
        ? await supabase.from('profiles').update({ username, display_name: displayName }).eq('id', user.id)
        : await supabase.from('profiles').insert({ id: user.id, username, display_name: displayName, onboarded: false });
      if (!error) return;
      // Username collision → retry with a suffix; anything else (RLS, missing
      // column) won't improve with retries.
      if (!/duplicate|unique/i.test(error.message)) return;
    }
  } catch { /* best effort — checkOnboarding re-fetches and copes */ }
}
