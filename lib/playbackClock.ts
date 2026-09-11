// Where each post's video is right now, for overlays that follow it — timed
// captions (components/TimedStickers). Players write it from onProgress, about
// four times a second; overlays subscribe per post.
//
// A module store rather than context: the caption overlay and the player that
// knows the position are siblings inside a feed card, and a context update would
// re-render the whole card on every tick. Positions are only kept for posts
// someone is listening to, so a long scroll does not accumulate them.

type Listener = () => void;

const positions = new Map<string, number>();
const listeners = new Map<string, Set<Listener>>();

/** Record a player's position, in seconds. A no-op unless an overlay is listening. */
export function setPlaybackPosition(postId: string, sec: number): void {
  const set = listeners.get(postId);
  if (!set || positions.get(postId) === sec) return;
  positions.set(postId, sec);
  for (const l of set) l();
}

export function getPlaybackPosition(postId: string): number {
  return positions.get(postId) ?? 0;
}

export function subscribePlayback(postId: string, l: Listener): () => void {
  let set = listeners.get(postId);
  if (!set) { set = new Set(); listeners.set(postId, set); }
  set.add(l);
  return () => {
    const current = listeners.get(postId);
    if (!current) return;
    current.delete(l);
    if (!current.size) { listeners.delete(postId); positions.delete(postId); }
  };
}
