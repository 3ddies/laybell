// "Complete your profile" — the four things a new account does that turn it from
// an empty page into somebody worth following, and the progress through them
// (owner, 2026-09-20: the nudge Instagram and the dating apps use to get new
// users moving).
//
// PURE on purpose: the profile screen renders it, and lib/badges evaluates the
// Bronze Profile badge from the same rules, so both agree by construction rather
// than by two similar-looking checks drifting apart. Tested in
// scripts/tests/test-profilecompletion.mjs.
//
// The badge is NOT permanent, and that follows from this file: the tasks describe
// what the profile IS, not what the user once did. Clear your bio and the profile
// is genuinely incomplete again — the card comes back and says so.

export type ProfileTaskKey = 'avatar' | 'bio' | 'post' | 'shop';

/** What the profile actually has. Every field is optional — absent reads as not done. */
export type ProfileFacts = {
  avatarUrl?: string | null;
  bio?: string | null;
  /** Public posts on the grid; the same count the profile header shows. */
  posts?: number | null;
  /** Whether this user has opened a shop (lib/shop hasOpenShop). */
  hasShop?: boolean | null;
};

export type ProfileTask = { key: ProfileTaskKey; done: boolean };

/**
 * The order the card lists them in: the two that take seconds first, then the
 * one that takes a post, then the shop — the biggest ask goes last so the list
 * opens with something already within reach.
 */
export const PROFILE_TASK_ORDER: ProfileTaskKey[] = ['avatar', 'bio', 'post', 'shop'];

function isDone(key: ProfileTaskKey, f: ProfileFacts): boolean {
  switch (key) {
    // A URL, not a placeholder initial. Whitespace is not a picture.
    case 'avatar': return typeof f.avatarUrl === 'string' && f.avatarUrl.trim().length > 0;
    // Same rule the profile page uses to decide between a bio and "No bio yet".
    case 'bio': return typeof f.bio === 'string' && f.bio.trim().length > 0;
    case 'post': return (f.posts ?? 0) > 0;
    case 'shop': return f.hasShop === true;
    default: return false;
  }
}

export function profileTasks(facts: ProfileFacts): ProfileTask[] {
  return PROFILE_TASK_ORDER.map((key) => ({ key, done: isDone(key, facts) }));
}

export type ProfileProgress = { done: number; total: number; complete: boolean };

export function profileProgress(facts: ProfileFacts): ProfileProgress {
  const tasks = profileTasks(facts);
  const done = tasks.filter((t) => t.done).length;
  return { done, total: tasks.length, complete: done === tasks.length };
}
