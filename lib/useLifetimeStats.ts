import { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { supabase } from './supabase';
import { fetchLifetimeStats, type LifetimeStats } from './analytics';

// Lifetime stats (views / song plays / likes) that refresh live while the screen is
// focused. POLLING, never per-row realtime: one cheap denormalized-sum query every
// `intervalMs`, guarded so a slow fetch never stacks and paused the moment the screen
// loses focus. O(posts) — unfazed by how viral a post goes. Shared by the notifications
// header and the full-page stats view so both stay in sync and use one code path.
export function useLifetimeStats(intervalMs = 4000): LifetimeStats | null {
  const [stats, setStats] = useState<LifetimeStats | null>(null);
  const idRef = useRef<string | null>(null);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      if (!idRef.current) {
        const { data: { user } } = await supabase.auth.getUser();
        idRef.current = user?.id ?? null;
      }
      if (idRef.current) setStats(await fetchLifetimeStats(idRef.current));
    } catch {
      /* keep the last good values on a transient failure */
    } finally {
      busy.current = false;
    }
  }, []);

  useFocusEffect(useCallback(() => {
    refresh();
    const id = setInterval(refresh, intervalMs);
    return () => clearInterval(id);
  }, [refresh, intervalMs]));

  return stats;
}
