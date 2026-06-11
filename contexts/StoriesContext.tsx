import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { useProfile } from './ProfileContext';
import { fetchStoryTray, fetchActiveStoryFlags, type StoryGroup, type SourceRect, type StoryRingInfo } from '../lib/stories';
import { chosenTier, badgeRingColors, specialRingTier, type Tier } from '../lib/badges';

// Global source of truth for "who (that I can see) has an active story". Lets any
// avatar in the app render a story ring + open the viewer via <StoryAvatar>, and
// backs the Home stories tray. Visibility = self + people you follow (RLS).

type StoriesContextValue = {
  groups: StoryGroup[];
  hasStory: (userId?: string | null) => boolean;
  hasUnseen: (userId?: string | null) => boolean;
  // Badge-tier ring colors for a user with an active story (null if no story or no
  // badge). Lets any avatar app-wide show the badge ring while a story is live.
  ringColors: (userId?: string | null) => readonly [string, string] | null;
  // The special ring tier (silver/gold/diamond, else null) for a user's active
  // story — drives the "seen rings dim to gray except diamond" policy app-wide.
  ringTier: (userId?: string | null) => Tier | null;
  openStory: (userId: string, orderedIds?: string[], src?: SourceRect) => void;
  openCamera: () => void;
  // Optimistically flip a user's ring to "seen" the moment their story is watched,
  // so the ring updates instantly everywhere (any avatar app-wide) without waiting
  // on the background refetch — works for anyone, followed or not. Pass the watched
  // story ids so the seen state sticks across refreshes (even before the view write
  // reaches the server).
  markSeen: (userId?: string | null, storyIds?: string[]) => void;
  refresh: () => void;
};

const StoriesContext = createContext<StoriesContextValue>({
  groups: [],
  hasStory: () => false,
  hasUnseen: () => false,
  ringColors: () => null,
  ringTier: () => null,
  openStory: () => {},
  openCamera: () => {},
  markSeen: () => {},
  refresh: () => {},
});

export function useStories() {
  return useContext(StoriesContext);
}

export function StoriesProvider({ children }: { children: React.ReactNode }) {
  const { profile } = useProfile();
  const currentUserId = profile?.id ?? null;
  const router = useRouter();
  const [groups, setGroups] = useState<StoryGroup[]>([]);
  // Global user_id -> ring info (unseen + badge tier) for ALL active stories the
  // viewer can see (powers story + badge rings on any avatar app-wide). `groups`
  // stays self+following for the tray + viewer order.
  const [flags, setFlags] = useState<Map<string, StoryRingInfo>>(new Map());
  // Story ids the viewer has watched this session. Merged into every load so a
  // just-watched ring never flips back to "unseen" on the next refresh while the
  // view-record write is still in flight (the source of the laggy/buggy ring).
  const seenRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(() => {
    if (!currentUserId) { setGroups([]); setFlags(new Map()); return; }
    fetchStoryTray(currentUserId, seenRef.current).then(setGroups).catch(() => {});
    fetchActiveStoryFlags(currentUserId, seenRef.current).then(setFlags).catch(() => {});
  }, [currentUserId]);

  useEffect(() => { refresh(); }, [refresh]);

  const hasStory = useCallback((uid?: string | null) => !!uid && flags.has(uid), [flags]);
  const hasUnseen = useCallback(
    (uid?: string | null) => !!uid && flags.get(uid)?.unseen === true,
    [flags],
  );
  // Badge ring colors for a user who has an active story (their tier color); null
  // if they have no active story or no badge. The ring only ever shows with a story.
  const ringColors = useCallback(
    (uid?: string | null): readonly [string, string] | null => {
      const info = uid ? flags.get(uid) : undefined;
      if (!info) return null;
      const tier = specialRingTier(chosenTier({ badge_tier: info.badge_tier, profile_theme: info.profile_theme }));
      return tier ? badgeRingColors(tier) : null;
    },
    [flags],
  );
  const ringTier = useCallback(
    (uid?: string | null): Tier | null => {
      const info = uid ? flags.get(uid) : undefined;
      if (!info) return null;
      return specialRingTier(chosenTier({ badge_tier: info.badge_tier, profile_theme: info.profile_theme }));
    },
    [flags],
  );

  const openStory = useCallback(
    (uid: string, orderedIds?: string[], src?: SourceRect) => {
      const ids = orderedIds ?? groups.map((g) => g.user.id);
      const list = ids.includes(uid) ? ids : [uid];
      router.push({
        pathname: '/story/[userId]',
        params: {
          userId: uid,
          users: JSON.stringify(list),
          ...(src ? { src: JSON.stringify(src) } : {}),
        },
      });
    },
    [groups, router],
  );

  const openCamera = useCallback(() => router.navigate('/story-camera'), [router]);

  // Mark a user's active story as seen locally: flips their ring from the unseen
  // (highlighted) state to the normal/seen state immediately, on every avatar that
  // reads this context — regardless of whether the viewer follows them. Recording
  // the story ids in `seenRef` makes it stick across refreshes; the server
  // view-record reconciles it in the background.
  const markSeen = useCallback((uid?: string | null, storyIds: string[] = []) => {
    if (!uid) return;
    for (const id of storyIds) seenRef.current.add(id);
    setFlags((prev) => {
      const info = prev.get(uid);
      if (!info || !info.unseen) return prev; // already seen → no-op (stable ref)
      const next = new Map(prev);
      next.set(uid, { ...info, unseen: false });
      return next;
    });
    setGroups((prev) => {
      let changed = false;
      const next = prev.map((g) => {
        if (g.user.id === uid && g.hasUnseen) { changed = true; return { ...g, hasUnseen: false }; }
        return g;
      });
      return changed ? next : prev;
    });
  }, []);

  const value = useMemo(
    () => ({ groups, hasStory, hasUnseen, ringColors, ringTier, openStory, openCamera, markSeen, refresh }),
    [groups, hasStory, hasUnseen, ringColors, ringTier, openStory, openCamera, markSeen, refresh],
  );

  return <StoriesContext.Provider value={value}>{children}</StoriesContext.Provider>;
}
