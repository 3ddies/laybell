import AsyncStorage from '@react-native-async-storage/async-storage';

// User preferences for offline music. Persisted locally (device-scoped, not synced).
// Defaults: the automatic Layer-0 safety net is ON, but Wi-Fi-only is also ON — so it
// quietly caches recently played tracks on Wi-Fi for connection resilience and never
// silently burns cellular data. Both are user-toggleable in Settings. (Auto-cache only
// actually runs once the NetInfo native module is in the build; until then it stays
// dormant because Wi-Fi can't be confirmed — see lib/network.ts.)

export type OfflinePrefs = {
  autoCache: boolean;          // Layer-0 safety net (auto-cache recently played)
  wifiOnly: boolean;           // only download on Wi-Fi
  maxStorageBytes: number | null; // optional user cap below the 3 GB hard ceiling
};

export const DEFAULT_PREFS: OfflinePrefs = { autoCache: true, wifiOnly: true, maxStorageBytes: null };

const KEY = 'offline_prefs_v1';
let cache: OfflinePrefs | null = null;
const listeners = new Set<() => void>();

export function subscribePrefs(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export async function getPrefs(): Promise<OfflinePrefs> {
  if (cache) return cache;
  let next: OfflinePrefs;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    next = raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : { ...DEFAULT_PREFS };
  } catch { next = { ...DEFAULT_PREFS }; }
  cache = next;
  return next;
}

export async function setPrefs(patch: Partial<OfflinePrefs>): Promise<OfflinePrefs> {
  const next = { ...(cache ?? (await getPrefs())), ...patch };
  cache = next;
  try { await AsyncStorage.setItem(KEY, JSON.stringify(next)); } catch {}
  listeners.forEach((l) => { try { l(); } catch {} });
  return next;
}
