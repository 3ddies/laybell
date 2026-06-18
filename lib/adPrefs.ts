import AsyncStorage from '@react-native-async-storage/async-storage';

// Per-device ad-personalization preference. When OFF, targeted ads stop for
// this user — only campaigns with NO targeting (house / broad ads) are served,
// and no profile/affinity signals are used to pick ads. Default OFF (opt-IN):
// we do not personalize ads until the user explicitly turns on "Personalized
// ads" in Settings. This meets the GDPR/ePrivacy opt-in standard for the EU and
// applies the stricter, privacy-first default everywhere. Stored locally; a real
// launch also ties it to a server-side flag + privacy-policy disclosure.

const KEY = 'ad_personalization_v1';
let cached: boolean | null = null;

export async function isAdPersonalizationEnabled(): Promise<boolean> {
  if (cached != null) return cached;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    cached = raw == null ? false : raw === '1';
  } catch {
    cached = false;
  }
  return cached;
}

export async function setAdPersonalization(enabled: boolean): Promise<void> {
  cached = enabled;
  try { await AsyncStorage.setItem(KEY, enabled ? '1' : '0'); } catch {}
}

// Synchronous best-effort read (returns the last loaded value, defaulting to
// OFF). Call isAdPersonalizationEnabled() once on mount to warm it.
export function adPersonalizationCached(): boolean {
  return cached ?? false;
}
