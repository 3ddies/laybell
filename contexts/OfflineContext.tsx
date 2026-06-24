import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { supabase } from '../lib/supabase';
import { useProfile } from './ProfileContext';
import { rawTier } from '../lib/badges';
import { effectivePinLimit, subscribePremium } from '../lib/entitlements';
import { flushStreamOutbox } from '../lib/streamOutbox';
import { subscribeNetwork, getNetworkState } from '../lib/network';
import { runOfflinePrefetch } from '../lib/offlinePrefetch';
import { getPrefs, setPrefs, subscribePrefs, DEFAULT_PREFS, type OfflinePrefs } from '../lib/offlinePrefs';
import {
  initOffline, subscribe, allEntries, pinnedEntries, isPinned as engineIsPinned,
  totalBytes, pinTrack, removeTrack, reconcileAgainst, type OfflineEntry,
} from '../lib/offline';

// React wrapper over the offline engine (lib/offline.ts). The engine holds the
// real state (module singletons, shared with AudioContext's playback resolver);
// this context just re-renders the UI on changes and owns the tier-gated pin flow.
//
// Design choice (docs/OFFLINE_STREAMING_PLAN.md): the per-tier limit is enforced at
// DOWNLOAD time only. We never delete or disable a user's existing downloads when
// their (free, volatile) badge tier drops — losing 70 saved songs to a missed login
// streak would be punitive. The 3 GB device byte cap is the real scalability guard.

export type PinInput = {
  id: string;
  uri: string;
  title?: string;
  artist?: string;
  cover?: string | null;
  downloadable?: boolean;
};

export type PinOutcome = 'ok' | 'limit' | 'space' | 'cap' | 'optout' | 'error' | 'web' | 'noauth';

type OfflineContextValue = {
  entries: OfflineEntry[];
  pinnedCount: number;
  usageBytes: number;
  pinLimit: number;                               // current user's tier allowance
  progress: Record<string, number>;               // postId → 0..1 while downloading
  isOffline: boolean;                             // real device offline state (NetInfo)
  prefs: OfflinePrefs;                            // auto-cache / wifi-only settings
  setPref: (patch: Partial<OfflinePrefs>) => void;
  isPinned: (postId: string) => boolean;
  isDownloading: (postId: string) => boolean;
  pin: (input: PinInput) => Promise<PinOutcome>;
  remove: (postId: string) => Promise<void>;
  reconcileOnline: () => Promise<void>;
};

const OfflineContext = createContext<OfflineContextValue>({
  entries: [], pinnedCount: 0, usageBytes: 0, pinLimit: 0, progress: {},
  isOffline: false, prefs: DEFAULT_PREFS, setPref: () => {},
  isPinned: () => false, isDownloading: () => false,
  pin: async () => 'web', remove: async () => {}, reconcileOnline: async () => {},
});

export function useOffline() { return useContext(OfflineContext); }

export function OfflineProvider({ children }: { children: React.ReactNode }) {
  const { profile } = useProfile();
  const [, force] = useState(0);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [isOffline, setIsOffline] = useState(false);
  const [prefs, setPrefsState] = useState<OfflinePrefs>(DEFAULT_PREFS);
  const uidRef = useRef<string | null>(null);

  // Re-render whenever the engine's manifest changes, or premium status flips (which
  // changes the pin allowance).
  useEffect(() => subscribe(() => force((n) => n + 1)), []);
  useEffect(() => subscribePremium(() => force((n) => n + 1)), []);

  // Load offline prefs and keep them in sync (they're written from Settings).
  useEffect(() => {
    getPrefs().then(setPrefsState).catch(() => {});
    return subscribePrefs(() => { getPrefs().then(setPrefsState).catch(() => {}); });
  }, []);

  const setPref = useCallback((patch: Partial<OfflinePrefs>) => {
    setPrefsState((p) => ({ ...p, ...patch }));   // optimistic
    setPrefs(patch).catch(() => {});
  }, []);

  // Real device offline state (NetInfo). No-ops to "online" until the native module
  // is in the build (see lib/network.ts), so it never shows a false offline state.
  useEffect(() => {
    let active = true;
    const apply = (s: { isConnected: boolean; isInternetReachable: boolean | null }) => {
      if (!active) return;
      setIsOffline(!s.isConnected || s.isInternetReachable === false);
      // Connectivity returned → top up the offline safety-net set (throttled internally).
      if (s.isConnected && s.isInternetReachable !== false && uidRef.current) {
        runOfflinePrefetch(uidRef.current).catch(() => {});
      }
    };
    getNetworkState().then(apply).catch(() => {});
    const unsub = subscribeNetwork(apply);
    return () => { active = false; unsub(); };
  }, []);

  const reconcileOnline = useCallback(async () => {
    if (Platform.OS === 'web') return;
    const ids = allEntries().map((e) => e.postId);
    if (!ids.length) return;
    try {
      const { data, error } = await supabase.from('posts').select('id, media_url, downloadable').in('id', ids);
      // CRITICAL: only purge "missing" tracks on a CONFIRMED successful response.
      // If the query failed (offline / flaky network) data is null and every id
      // would look inaccessible — purging then would wipe the user's downloads
      // exactly when they're offline. So bail without touching anything.
      if (error || !data) return;
      await reconcileAgainst(data as any[], ids);
    } catch {}
  }, []);

  // Init the engine for the signed-in user, flush any queued offline stream credit,
  // and reconcile cached tracks against the server (opt-outs / deletions / drift).
  useEffect(() => {
    let active = true;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!active || !user) return;
      uidRef.current = user.id;
      await initOffline(user.id);
      flushStreamOutbox(user.id).catch(() => {});
      reconcileOnline().catch(() => {});
      // Proactively cache the user's top-played + most-recent songs for outage
      // resilience (force on launch). Temporary, opt-out-aware, prefs-gated.
      runOfflinePrefetch(user.id, true).catch(() => {});
    })();
    return () => { active = false; };
  }, [reconcileOnline]);

  // On every app foreground: replay offline stream credit + re-check cached tracks.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      const uid = uidRef.current;
      if (uid) flushStreamOutbox(uid).catch(() => {});
      reconcileOnline().catch(() => {});
      if (uid) runOfflinePrefetch(uid).catch(() => {});   // top up the safety-net set (throttled)
    });
    return () => sub.remove();
  }, [reconcileOnline]);

  const tier = rawTier(profile);
  const pinLimit = effectivePinLimit(tier);   // premium → unlimited (byte-capped)

  const pin = useCallback(async (input: PinInput): Promise<PinOutcome> => {
    if (Platform.OS === 'web') return 'web';
    if (input.downloadable === false) return 'optout';
    if (engineIsPinned(input.id)) return 'ok';
    if (!uidRef.current) {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return 'noauth';
      uidRef.current = user.id;
      await initOffline(user.id);
    }
    // Enforce the per-tier count at download time (only).
    if (pinnedEntries().length >= pinLimit) return 'limit';

    setProgress((p) => ({ ...p, [input.id]: 0 }));
    const res = await pinTrack(
      input.id, input.uri,
      { title: input.title, artist: input.artist, cover: input.cover, downloadable: input.downloadable },
      (f) => setProgress((p) => ({ ...p, [input.id]: f })),
    );
    setProgress((p) => { const { [input.id]: _drop, ...rest } = p; return rest; });

    if (res.ok) return 'ok';
    if (res.reason === 'space') return 'space';
    if (res.reason === 'cap') return 'cap';
    if (res.reason === 'permanent') return 'optout';
    return 'error';
  }, [pinLimit]);

  const remove = useCallback(async (postId: string) => { await removeTrack(postId); }, []);

  return (
    <OfflineContext.Provider
      value={{
        entries: allEntries(),
        pinnedCount: pinnedEntries().length,
        usageBytes: totalBytes('pinned'),
        pinLimit,
        progress,
        isOffline,
        prefs,
        setPref,
        isPinned: engineIsPinned,
        isDownloading: (id) => id in progress,
        pin,
        remove,
        reconcileOnline,
      }}
    >
      {children}
    </OfflineContext.Provider>
  );
}
