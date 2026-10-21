// Multi-account support (Instagram-style account switcher).
//
// Supabase holds ONE active session at a time (lib/supabase stores it in
// AsyncStorage). To let a user keep several accounts signed in and hop between
// them without a full log-out/log-in, we keep a SEPARATE store of each account's
// session tokens (+ a little profile for the row) and switch by handing the
// client a different session with `supabase.auth.setSession()`.
//
// The whole per-user React tree in app/_layout.tsx is keyed on the user id, so
// the moment the active session changes it remounts clean for the new account —
// no stale data bleeds across. That is what makes an in-place switch safe.
//
// Refresh-token rotation is the one sharp edge: Supabase rotates a refresh token
// every time it's used, invalidating the previous one. So the ACTIVE account's
// stored token must be kept current — _layout calls rememberActiveAccount() on
// every auth event. Inactive accounts' tokens aren't used, so they stay valid
// until the next switch, which immediately re-saves the rotated one.
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { clearAgeCache } from './minors';
import { clearScreenCaches } from './screenCache';

export type StoredAccount = {
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  accessToken: string;
  refreshToken: string;
  savedAt: number;
};

const KEY = 'laybell:accounts:v1';

async function readAll(): Promise<StoredAccount[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as StoredAccount[]) : [];
    return Array.isArray(list) ? list.filter((a) => a && a.userId && a.refreshToken) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: StoredAccount[]): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(list));
  } catch { /* storage full / unavailable — the switcher just won't persist */ }
}

/**
 * Snapshot the ACTIVE session into the store (fresh tokens + display fields).
 * Called from _layout on SIGNED_IN / TOKEN_REFRESHED / INITIAL_SESSION so the
 * active account's rotating refresh token is never stale in the store. The
 * profile read is best-effort: on failure we keep whatever row we already had,
 * so a brief offline moment can't blank out an account's name/avatar.
 */
export async function rememberActiveAccount(session: Session | null): Promise<void> {
  const uid = session?.user?.id;
  if (!uid || !session?.access_token || !session?.refresh_token) return;

  const list = await readAll();
  const existing = list.find((a) => a.userId === uid);

  let username = existing?.username ?? '';
  let displayName = existing?.displayName ?? null;
  let avatarUrl = existing?.avatarUrl ?? null;
  try {
    const { data } = await supabase
      .from('profiles').select('username, display_name, avatar_url').eq('id', uid).single();
    if (data) {
      username = (data as any).username ?? username;
      displayName = (data as any).display_name ?? displayName;
      avatarUrl = (data as any).avatar_url ?? avatarUrl;
    }
  } catch { /* keep existing display fields */ }

  const entry: StoredAccount = {
    userId: uid,
    username,
    displayName,
    avatarUrl,
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    savedAt: Date.now(),
  };
  // Active account first; dedup by id.
  await writeAll([entry, ...list.filter((a) => a.userId !== uid)]);
}

export async function listStoredAccounts(): Promise<StoredAccount[]> {
  return readAll();
}

export async function removeStoredAccount(userId: string): Promise<void> {
  const list = await readAll();
  await writeAll(list.filter((a) => a.userId !== userId));
}

/**
 * Switch to an already-stored account with NO re-login. setSession swaps the
 * active session, refreshing via the stored refresh token when the access token
 * is stale; onAuthStateChange in _layout then remounts the per-user tree.
 * Returns ok:false (and forgets the row) if the stored tokens are dead.
 */
export async function switchToAccount(acc: StoredAccount): Promise<{ ok: boolean; error?: string }> {
  // Per-device caches that must never leak across identities. _layout clears
  // these on SIGNED_IN/OUT, but setSession can emit a different event, so clear
  // here too — before the new session's screens can read them.
  try { clearAgeCache(); } catch {}
  try { clearScreenCaches(); } catch {}

  const { error } = await supabase.auth.setSession({
    access_token: acc.accessToken,
    refresh_token: acc.refreshToken,
  });
  if (error) {
    // Dead tokens (revoked, or rotated out from under us). Drop the row so the
    // UI shows it needs a fresh sign-in rather than silently failing to switch.
    await removeStoredAccount(acc.userId);
    return { ok: false, error: error.message };
  }

  // setSession may have rotated the refresh token — persist the now-current one.
  try {
    const { data: { session } } = await supabase.auth.getSession();
    await rememberActiveAccount(session);
  } catch {}
  return { ok: true };
}

// In-memory flag: true while the user is on the login screen to ADD another
// account, with the current account still signed in underneath. The auth gate
// (app/_layout.tsx) reads it to let the login screen show despite a live session,
// and clears it when a new account signs in or the user cancels back.
let _addAccountMode = false;
export function setAddAccountMode(on: boolean): void { _addAccountMode = on; }
export function isAddingAccount(): boolean { return _addAccountMode; }

/**
 * Begin adding / logging into another account. Unlike a real sign-out this KEEPS
 * the current session ACTIVE, so the login screen can be dismissed (its back
 * button) to return to the current account with nothing lost. The caller then
 * navigates to /(auth)/login; the gate allows it while the flag is set.
 */
export async function beginAddAccount(): Promise<void> {
  _addAccountMode = true;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    await rememberActiveAccount(session);
  } catch {}
}
