import { Platform } from 'react-native';

// Network state wrapper around @react-native-community/netinfo.
//
// NetInfo is a NATIVE module, so it only works once the app binary is rebuilt with
// it (dev client / store build). We load it DYNAMICALLY and fall back gracefully
// when it isn't in the build yet — exactly like react-native-compressor in
// lib/upload.ts — so this ships ahead of the rebuild without crashing. Until the
// rebuild lands: getNetworkState() reports "connected, not Wi-Fi", which keeps the
// Wi-Fi-only auto-cache dormant and never shows a false "offline" state (playback
// still falls back to local files lazily). After the rebuild it reports real state.

export type NetState = { isConnected: boolean; isInternetReachable: boolean | null; isWifi: boolean };

// Optimistic connectivity, pessimistic Wi-Fi (so wifi-only auto-cache stays off until
// we can actually confirm Wi-Fi).
const FALLBACK: NetState = { isConnected: true, isInternetReachable: null, isWifi: false };

let modPromise: Promise<any | null> | null = null;
function loadNetInfo(): Promise<any | null> {
  if (Platform.OS === 'web') return Promise.resolve(null);
  if (!modPromise) {
    modPromise = import('@react-native-community/netinfo')
      .then((m: any) => m?.default ?? m ?? null)
      .catch(() => null);   // module not in this build yet → graceful fallback
  }
  return modPromise;
}

function toState(s: any): NetState {
  return {
    isConnected: s?.isConnected !== false,
    isInternetReachable: s?.isInternetReachable ?? null,
    isWifi: s?.type === 'wifi' || s?.type === 'ethernet',
  };
}

export async function getNetworkState(): Promise<NetState> {
  const ni = await loadNetInfo();
  if (!ni?.fetch) return FALLBACK;
  try { return toState(await ni.fetch()); } catch { return FALLBACK; }
}

// Subscribe to changes. No-ops (and reports nothing) when NetInfo isn't in the build.
export function subscribeNetwork(cb: (s: NetState) => void): () => void {
  let unsub = () => {};
  let cancelled = false;
  loadNetInfo().then((ni) => {
    if (!ni?.addEventListener || cancelled) return;
    unsub = ni.addEventListener((s: any) => cb(toState(s)));
  });
  return () => { cancelled = true; try { unsub(); } catch {} };
}
