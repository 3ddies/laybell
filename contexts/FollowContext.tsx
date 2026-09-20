import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { createNotification } from '../lib/createNotification';

// Single source of truth for the current user's connections, so the many inline
// "Follow" buttons across feeds don't each hit the network.
//
// Two tiers (Laybell):
//   • follower = one-directional. `following` is who I follow.
//   • friend   = mutual follow. `friends` = `following` ∩ `followers`.
// Toggling updates `following` optimistically, so every button for that user flips
// at once; `friends` is derived, so a button becomes "Friends" the moment a follow
// becomes mutual.

type FollowContextValue = {
  currentUserId: string | null;
  following: Set<string>;
  followers: Set<string>;
  friends: Set<string>;
  isFriend: (userId: string) => boolean;
  toggleFollow: (userId: string) => void;
  /** Report a follow row that was written elsewhere — see syncFollow below. */
  syncFollow: (userId: string, isFollowing: boolean) => void;
};

const FollowContext = createContext<FollowContextValue>({
  currentUserId: null,
  following: new Set(),
  followers: new Set(),
  friends: new Set(),
  isFriend: () => false,
  toggleFollow: () => {},
  syncFollow: () => {},
});

export function useFollow() {
  return useContext(FollowContext);
}

export function FollowProvider({ children }: { children: React.ReactNode }) {
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [following, setFollowing] = useState<Set<string>>(new Set());
  const [followers, setFollowers] = useState<Set<string>>(new Set());

  const uidRef = useRef<string | null>(null); uidRef.current = currentUserId;
  const followingRef = useRef(following); followingRef.current = following;
  const followersRef = useRef(followers); followersRef.current = followers;

  const load = useCallback(async () => {
    // getSession (on the phone), not getUser (a round trip) — see app/(tabs)/index.tsx.
    const { data: { session } } = await supabase.auth.getSession();
    const user = session?.user ?? null;
    setCurrentUserId(user?.id ?? null);
    if (!user) { setFollowing(new Set()); setFollowers(new Set()); return; }
    // Who I follow + who follows me, so we can derive friends (mutual).
    const [followingRes, followersRes] = await Promise.all([
      supabase.from('follows').select('following_id').eq('follower_id', user.id),
      supabase.from('follows').select('follower_id').eq('following_id', user.id),
    ]);
    setFollowing(new Set((followingRes.data ?? []).map((f: any) => f.following_id)));
    setFollowers(new Set((followersRes.data ?? []).map((f: any) => f.follower_id)));
  }, []);

  useEffect(() => {
    load();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      if (session?.user) load();
      else { setCurrentUserId(null); setFollowing(new Set()); setFollowers(new Set()); }
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
      else {
        // If they already follow me, this follow makes us friends → tell them so.
        const nowMutual = followersRef.current.has(userId);
        createNotification({ userId, actorId: uid, type: nowMutual ? 'friend' : 'follow' });
      }
    }
  }, []);

  // For the two screens that write the follow row THEMSELVES: the visited
  // profile (it keeps its own follower count and private-post visibility, both
  // seeded from its own query) and onboarding's suggestions.
  //
  // Without this the row lands in the database and NOTHING else in the app
  // notices — this context loads once at startup, so every other Follow button
  // for that person keeps its old label for the rest of the session. That was a
  // real bug: follow someone from their profile, go back to the feed, and their
  // post's top bar still said "Follow back".
  //
  // It writes nothing and notifies nobody. It is the caller saying what it has
  // already done.
  const syncFollow = useCallback((userId: string, isFollowing: boolean) => {
    setFollowing(prev => {
      // Same answer → same Set, so consumers don't re-render for nothing.
      if (prev.has(userId) === isFollowing) return prev;
      const next = new Set(prev);
      if (isFollowing) next.add(userId); else next.delete(userId);
      return next;
    });
  }, []);

  const friends = useMemo(() => {
    const out = new Set<string>();
    following.forEach(id => { if (followers.has(id)) out.add(id); });
    return out;
  }, [following, followers]);

  const isFriend = useCallback((userId: string) => friends.has(userId), [friends]);

  const value = useMemo(
    () => ({ currentUserId, following, followers, friends, isFriend, toggleFollow, syncFollow }),
    [currentUserId, following, followers, friends, isFriend, toggleFollow, syncFollow],
  );

  return <FollowContext.Provider value={value}>{children}</FollowContext.Provider>;
}
