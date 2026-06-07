import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { createNotification } from '../lib/createNotification';

// Single source of truth for who the current user follows, so the many inline
// "Follow" buttons across feeds don't each hit the network. Toggling updates the
// set optimistically, so every button for that user flips at once.

type FollowContextValue = {
  currentUserId: string | null;
  following: Set<string>;
  toggleFollow: (userId: string) => void;
};

const FollowContext = createContext<FollowContextValue>({
  currentUserId: null,
  following: new Set(),
  toggleFollow: () => {},
});

export function useFollow() {
  return useContext(FollowContext);
}

export function FollowProvider({ children }: { children: React.ReactNode }) {
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [following, setFollowing] = useState<Set<string>>(new Set());

  const uidRef = useRef<string | null>(null); uidRef.current = currentUserId;
  const followingRef = useRef(following); followingRef.current = following;

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    setCurrentUserId(user?.id ?? null);
    if (!user) { setFollowing(new Set()); return; }
    const { data } = await supabase.from('follows').select('following_id').eq('follower_id', user.id);
    setFollowing(new Set((data ?? []).map((f: any) => f.following_id)));
  }, []);

  useEffect(() => {
    load();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      if (session?.user) load();
      else { setCurrentUserId(null); setFollowing(new Set()); }
    });
    return () => subscription.unsubscribe();
  }, [load]);

  const toggleFollow = useCallback(async (userId: string) => {
    const uid = uidRef.current;
    if (!uid || uid === userId) return;
    const wasFollowing = followingRef.current.has(userId);
    // Optimistic update.
    setFollowing(prev => {
      const next = new Set(prev);
      wasFollowing ? next.delete(userId) : next.add(userId);
      return next;
    });
    if (wasFollowing) {
      const { error } = await supabase.from('follows').delete().eq('follower_id', uid).eq('following_id', userId);
      if (error) setFollowing(prev => { const n = new Set(prev); n.add(userId); return n; }); // revert
    } else {
      const { error } = await supabase.from('follows').insert({ follower_id: uid, following_id: userId });
      if (error) setFollowing(prev => { const n = new Set(prev); n.delete(userId); return n; }); // revert
      else createNotification({ userId, actorId: uid, type: 'follow' });
    }
  }, []);

  const value = useMemo(
    () => ({ currentUserId, following, toggleFollow }),
    [currentUserId, following, toggleFollow],
  );

  return <FollowContext.Provider value={value}>{children}</FollowContext.Provider>;
}
