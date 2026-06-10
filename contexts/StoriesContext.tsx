import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import { useProfile } from './ProfileContext';
import { fetchStoryTray, fetchActiveStoryFlags, type StoryGroup, type SourceRect, type StoryRingInfo } from '../lib/stories';
import { rawTier, badgeRingColors, specialRingTier } from '../lib/badges';

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
  openStory: (userId: string, orderedIds?: string[], src?: SourceRect) => void;
  openCamera: () => void;
  refresh: () => void;
};

const StoriesContext = createContext<StoriesContextValue>({
  groups: [],
  hasStory: () => false,
  hasUnseen: () => false,
  ringColors: () => null,
  openStory: () => {},
  openCamera: () => {},
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

  const refresh = useCallback(() => {
    if (!currentUserId) { setGroups([]); setFlags(new Map()); return; }
    fetchStoryTray(currentUserId).then(setGroups).catch(() => {});
    fetchActiveStoryFlags(currentUserId).then(setFlags).catch(() => {});
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
      const tier = specialRingTier(rawTier({ badge_tier: info.badge_tier }));
      return tier ? badgeRingColors(tier) : null;
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

  const value = useMemo(
    () => ({ groups, hasStory, hasUnseen, ringColors, openStory, openCamera, refresh }),
    [groups, hasStory, hasUnseen, ringColors, openStory, openCamera, refresh],
  );

  return <StoriesContext.Provider value={value}>{children}</StoriesContext.Provider>;
}
