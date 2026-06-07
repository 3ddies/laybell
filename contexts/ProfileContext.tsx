import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

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
  }, []);

  useEffect(() => {
    refresh();
    // Reload when the signed-in user changes (login / logout / token refresh).
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) refresh();
      else { setProfile(null); setLoading(false); }
    });
    return () => subscription.unsubscribe();
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
