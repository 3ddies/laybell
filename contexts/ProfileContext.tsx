import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image as ExpoImage } from 'expo-image';
import { supabase } from '../lib/supabase';
import { touchLogin, evaluateBadges, onBadgeTierChange, type Tier } from '../lib/badges';
import { startBadgeRiskReminders } from '../lib/badgeRisk';
import { upsertOwnIdentifiers, loadOwnPhone } from '../lib/identifiers';
import { endMyStaleLiveStreams } from '../lib/live';
import { syncEntitlementsFromProfile } from '../lib/purchases';

// YOUR OWN PROFILE IS KEPT ON THE PHONE (1.0.4).
//
// Everything that shows you to yourself — the avatar in the tab bar, the one in
// the header, your name — waited on this fetch, so on a cold start they popped
// in a beat after the app did. The picture could not even START loading until
// the row came back with its URL.
//
// So the last row is written to storage and read back synchronously-ish at
// mount: the first frame already knows your avatar's URL, and expo-image has the
// file on disk from last time, so it paints with the app instead of after it.
// The fetch still runs and overwrites it.
//
// Staleness is close to a non-issue here: this is the ONE profile that only
// changes through this app, and update() writes the cache on every edit.
const CACHE_KEY = 'own_profile_v1';

// Run-once-per-process guard for the ghost-live reap. It must fire only at the
// FIRST profile load (cold start) — when the user provably isn't broadcasting yet
// (Go Live is a pushed screen reached only after launch). Later refreshes (token
// refresh, badge-tier change) skip it, so it can never end a live broadcast.
let reapedGhostLives = false;

// Single source of truth for the CURRENT user's own profile (avatar, name, …).
// Before this existed, every screen fetched `profiles` independently, so changing
// your avatar in edit-profile left stale copies everywhere else. Now those screens
// read from here and edit-profile pushes updates through `update()`, so a new
// avatar appears app-wide instantly. (Uploads use unique filenames, so the URL
// itself changes each time — no image-cache busting needed.)

export type CurrentProfile = {
  id: string;
  display_name?: string | null;
  username?: string | null;
  bio?: string | null;
  avatar_url?: string | null;
  badge_tier?: string | null;
  badge_show?: boolean | null;
  profile_theme?: string | null;
  story_ring_style?: string | null;
  link?: string | null;
  gender?: string | null;
  age?: number | null;
  [key: string]: any;
};

type ProfileContextValue = {
  profile: CurrentProfile | null;
  loading: boolean;
  refresh: () => Promise<void>;
  update: (patch: Partial<CurrentProfile>) => void;
};

const ProfileContext = createContext<ProfileContextValue>({
  profile: null,
  loading: true,
  refresh: async () => {},
  update: () => {},
});

export function useProfile() {
  return useContext(ProfileContext);
}

function cacheProfile(p: CurrentProfile | null): void {
  if (!p?.id) return;
  AsyncStorage.setItem(CACHE_KEY, JSON.stringify(p)).catch(() => {});
}

export function ProfileProvider({ children }: { children: React.ReactNode }) {
  const [profile, setProfile] = useState<CurrentProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    // getSession (on the phone), not getUser (a round trip) — see app/(tabs)/index.tsx.
    const { data: { session } } = await supabase.auth.getSession();
    const user = session?.user ?? null;
    if (!user) { setProfile(null); setLoading(false); syncEntitlementsFromProfile(null); return; }
    // Cold start only (guarded): reap any of my own leftover "live" rows from a
    // session that was killed mid-broadcast, so I never reopen the app as a ghost
    // livestream. Fire-and-forget — never blocks profile load.
    if (!reapedGhostLives) {
      reapedGhostLives = true;
      endMyStaleLiveStreams(user.id).catch(() => {});
    }
    const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single();
    setProfile((data as CurrentProfile) ?? null);
    setLoading(false);
    cacheProfile(data as CurrentProfile | null);
    // Reflect the server-written entitlement mirrors into the module flags —
    // no-op once RevenueCat is configured (it owns the flags from then on).
    syncEntitlementsFromProfile(data as any);
    // Badges: mark today's login and recompute the emblem. Fire-and-forget so it
    // never blocks profile load; no-ops if the badges SQL isn't applied yet.
    // startBadgeRiskReminders subscribes BEFORE the evaluation so the first one
    // of the session is not the one that gets missed.
    startBadgeRiskReminders();
    touchLogin().then(() => evaluateBadges({ silent: true })).catch(() => {});
    // Keep our contact-discovery hashes in sync (email always; phone only if it's
    // stored on this device, so a fresh device never wipes an existing phone hash).
    // Fire-and-forget; no-ops if expo-crypto/the table aren't available yet.
    loadOwnPhone().then(phone => upsertOwnIdentifiers(user.id, user.email, phone || undefined)).catch(() => {});
  }, []);

  // Paint from the phone first. Guarded on `prev`: a fetch that already landed
  // (a warm start, where this resolves second) must not be replaced by an older
  // copy of itself.
  useEffect(() => {
    let live = true;
    AsyncStorage.getItem(CACHE_KEY)
      .then((raw) => {
        if (!live || !raw) return;
        const cached = JSON.parse(raw) as CurrentProfile;
        if (!cached?.id) return;
        // The picture, warmed into expo-image's cache before anything renders it.
        if (cached.avatar_url) ExpoImage.prefetch(cached.avatar_url, 'memory-disk').catch(() => {});
        setProfile((prev) => prev ?? cached);
        setLoading(false);
      })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  useEffect(() => {
    refresh();
    // Reload when the signed-in user changes (login / logout / token refresh).
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) refresh();
      else {
        setProfile(null); setLoading(false); syncEntitlementsFromProfile(null);
        // Signed out: the next person to open this app is not you.
        AsyncStorage.removeItem(CACHE_KEY).catch(() => {});
      }
    });
    // Keep the in-memory emblem in sync the instant the evaluator changes our tier
    // (e.g. right after earning a badge). Patch the tier immediately for snappy
    // feedback, then refetch the whole profile so EVERY tier-derived surface — the
    // emblem, theme banner, ring, and accent buttons — updates together instead of
    // half-updating and looking buggy.
    const unsubscribeTier = onBadgeTierChange((tier: Tier | null) => {
      // The displayed badge now follows the earned tier (evaluateBadges snaps
      // profile_theme on a tier change), so patch BOTH optimistically — otherwise
      // the emblem flashes the old badge until the refetch lands.
      setProfile(prev => (prev ? { ...prev, badge_tier: tier, profile_theme: tier ?? 'default' } : prev));
      refresh();
    });
    return () => { subscription.unsubscribe(); unsubscribeTier(); };
  }, [refresh]);

  // Optimistic local patch — callers use this right after writing to the DB so
  // every consumer re-renders immediately without a round-trip.
  const update = useCallback((patch: Partial<CurrentProfile>) => {
    setProfile(prev => {
      const next = prev ? { ...prev, ...patch } : prev;
      cacheProfile(next);   // so the next launch opens on the edit, not before it
      return next;
    });
  }, []);

  return (
    <ProfileContext.Provider value={{ profile, loading, refresh, update }}>
      {children}
    </ProfileContext.Provider>
  );
}
