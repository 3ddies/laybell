// A post its author just edited, for the screens already showing it. The edit
// screen saves and goes back — without this, the feed or viewer it returns to
// keeps drawing the old caption, song or cover until its next refresh.
//
// The patch is the columns the edit wrote, so a screen holding the row merges it
// in as it is.

export type PostPatch = Record<string, unknown>;
type Listener = (postId: string, patch: PostPatch) => void;

const listeners = new Set<Listener>();

export function emitPostEdited(postId: string, patch: PostPatch): void {
  for (const l of [...listeners]) {
    try { l(postId, patch); } catch { /* one screen's failure is not the others' */ }
  }
}

export function subscribePostEdited(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** The list with the edit merged in — the same array when the post is not in it. */
export function patchPostList<T extends { id: string }>(list: T[], postId: string, patch: PostPatch): T[] {
  let hit = false;
  const next = list.map((p) => {
    if (p.id !== postId) return p;
    hit = true;
    return { ...p, ...patch } as T;
  });
  return hit ? next : list;
}

// A post its author just deleted, for every OTHER screen already showing it.
// Deleting on one surface (say the home feed) has to drop the row from every
// other mounted list (the profile tab, explore, an open viewer) — otherwise a
// post deleted on one tab lingers as a ghost card on another until that screen
// next refreshes, which is exactly the "deleted on home, still on my profile"
// report. Emitted from deletePostById so EVERY delete path broadcasts.
type DeleteListener = (postId: string) => void;
const deleteListeners = new Set<DeleteListener>();

export function emitPostDeleted(postId: string): void {
  for (const l of [...deleteListeners]) {
    try { l(postId); } catch { /* one screen's failure is not the others' */ }
  }
}

export function subscribePostDeleted(l: DeleteListener): () => void {
  deleteListeners.add(l);
  return () => { deleteListeners.delete(l); };
}

/** The list with the post removed — the same array when it is not in it. */
export function removeFromPostList<T extends { id: string }>(list: T[], postId: string): T[] {
  return list.some((p) => p.id === postId) ? list.filter((p) => p.id !== postId) : list;
}
