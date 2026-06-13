import AsyncStorage from '@react-native-async-storage/async-storage';

// Per-device ad-personalization preference. When OFF ("Limit ad targeting" in
// Settings), targeted ads stop for this user — only campaigns with NO targeting
// (house / broad ads) are served, and no profile/affinity signals are used to
// pick ads. Default ON. Stored locally; this is the user-facing privacy control
// the ad ecosystem exposes today (a real launch also ties it to a server-side
// flag + privacy-policy disclosure — see ad_ecosystem.sql notes).

const KEY = 'ad_personalization_v1';
let cached: boolean | null = null;

export async function isAdPersonalizationEnabled(): Promise<boolean> {
  if (cached != null) return cached;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    cached = raw == null ? true : raw === '1';
  } catch {
    cached = true;
  }
  return cached;
}

export async function setAdPersonalization(enabled: boolean): Promise<void> {
  cached = enabled;
  try { await AsyncStorage.setItem(KEY, enabled ? '1' : '0'); } catch {}
}

// Synchronous best-effort read (returns the last loaded value, defaulting to
// ON). Call isAdPersonalizationEnabled() once on mount to warm it.
export function adPersonalizationCached(): boolean {
  return cached ?? true;
}
