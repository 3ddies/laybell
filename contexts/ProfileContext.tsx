import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { touchLogin, evaluateBadges, onBadgeTierChange, type Tier } from '../lib/badges';
import { upsertOwnIdentifiers, loadOwnPhone } from '../lib/identifiers';

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

export function ProfileProvider({ children }: { children: React.ReactNode }) {
  const [profile, setProfile] = useState<CurrentProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setProfile(null); setLoading(false); return; }
    const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single();
    setProfile((data as CurrentProfile) ?? null);
    setLoading(false);
    // Badges: mark today's login and recompute the emblem. Fire-and-forget so it
    // never blocks profile load; no-ops if the badges SQL isn't applied yet.
    touchLogin().then(() => evaluateBadges({ silent: true })).catch(() => {});
    // Keep our contact-discovery hashes in sync (email always; phone only if it's
    // stored on this device, so a fresh device never wipes an existing phone hash).
    // Fire-and-forget; no-ops if expo-crypto/the table aren't available yet.
    loadOwnPhone().then(phone => upsertOwnIdentifiers(user.id, user.email, phone || undefined)).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    // Reload when the signed-in user changes (login / logout / token refresh).
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) refresh();
      else { setProfile(null); setLoading(false); }
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
    setProfile(prev => (prev ? { ...prev, ...patch } : prev));
  }, []);

  return (
    <ProfileContext.Provider value={{ profile, loading, refresh, update }}>
      {children}
    </ProfileContext.Provider>
  );
}
