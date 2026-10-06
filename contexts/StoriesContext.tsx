import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { useProfile } from './ProfileContext';
import { fetchStoryTray, fetchActiveStoryFlags, fetchStoriesForUsers, type StoryGroup, type SourceRect, type StoryRingInfo } from '../lib/stories';
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
  // The user whose story ring is mid-open (pre-loading its first frame), or null — an
  // avatar shows the travelling-light loading sweep while it equals its own userId.
  openingUserId: string | null;
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
  openingUserId: null,
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
  // Which ring is currently pre-loading its first frame before the viewer opens (null = none).
  // Drives the travelling-light loading sweep on that avatar's story ring (IG-style).
  const [openingUserId, setOpeningUserId] = useState<string | null>(null);
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
      const push = (seedGroup?: StoryGroup | null) =>
        router.push({
          pathname: '/story/[userId]',
          params: {
            userId: uid,
            users: JSON.stringify(list),
            ...(src ? { src: JSON.stringify(src) } : {}),
            // Hand the viewer the group we already have/fetched, so it renders instantly
            // instead of showing its own grey skeleton while it re-fetches.
            ...(seedGroup ? { seed: JSON.stringify(seedGroup) } : {}),
          },
        });
      // Show the ring's loading sweep, warm the first frame (DECODED, in memory via
      // 'memory-disk' so the viewer paints it instantly), THEN open — so it never flashes
      // grey. If the tray hasn't loaded this user's group yet (e.g. the very first tap after
      // launch), fetch just their group first so we can both warm the frame AND seed the
      // viewer. Capped at 2s; on slow wifi the cap wins and the grey loader shows, as before.
      setOpeningUserId(uid);
      let done = false;
      const finish = (seedGroup?: StoryGroup | null) => {
        if (done) return;
        done = true;
        setOpeningUserId(null);
        push(seedGroup ?? null);
      };
      setTimeout(() => finish(), 2000);
      const warm = (g: StoryGroup | null, passSeed: boolean) => {
        const s = g?.stories?.[0];
        const url = s ? (s.media_type === 'image' ? s.media_url : s.thumbnail_url) : null;
        const onWarm = () => finish(passSeed ? g : null);
        if (url) ExpoImage.prefetch(url, 'memory-disk').then(onWarm).catch(onWarm);
        else onWarm();
      };
      const existing = groups.find((g) => g.user.id === uid) ?? null;
      if (existing && existing.stories.length > 0) { warm(existing, false); return; }
      // Tray not loaded for this user yet → fetch their group, warm it, and seed the viewer.
      if (currentUserId) {
        fetchStoriesForUsers([uid], currentUserId).then((gs) => warm(gs[0] ?? null, true)).catch(() => finish(null));
      } else {
        finish(null);
      }
    },
    [groups, router, currentUserId],
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
    () => ({ groups, hasStory, hasUnseen, ringColors, ringTier, openStory, openingUserId, openCamera, markSeen, refresh }),
    [groups, hasStory, hasUnseen, ringColors, ringTier, openStory, openingUserId, openCamera, markSeen, refresh],
  );

  return <StoriesContext.Provider value={value}>{children}</StoriesContext.Provider>;
}
