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
