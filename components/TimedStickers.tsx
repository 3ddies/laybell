import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { PlacedStickers, type Sticker } from './StickerLayer';
import { isTimed, postStickers, visibleKey } from '../lib/stickerTiming';
import { getPlaybackPosition, subscribePlayback } from '../lib/playbackClock';

const NO_SUBSCRIPTION = () => () => {};

// A post's captions over its playing video. Untimed captions always show; timed
// ones — set in the 1.0.3 editor — appear and leave with the playhead, which the
// player feeds through lib/playbackClock. Re-renders only when a caption enters
// or leaves, never on the player's quarter-second tick.
//
// Takes the two columns separately (posts.captions, posts.timed_captions) so the
// merge is memoized against the row's own arrays rather than rebuilt per render.
export default function TimedStickers({ postId, captions, timedCaptions, frameW, frameH }: {
  postId: string;
  captions: unknown;
  timedCaptions: unknown;
  frameW: number;
  frameH: number;
}) {
  const stickers = useMemo(() => postStickers<Sticker>(captions, timedCaptions), [captions, timedCaptions]);
  const anyTimed = useMemo(() => stickers.some(isTimed), [stickers]);
  const subscribe = useCallback((onChange: () => void) => subscribePlayback(postId, onChange), [postId]);
  const key = useSyncExternalStore(
    anyTimed ? subscribe : NO_SUBSCRIPTION,
    () => (anyTimed ? visibleKey(stickers, getPlaybackPosition(postId)) : ''),
  );
  const visible = useMemo(
    () => (anyTimed ? stickers.filter((_, i) => key.includes(`|${i}|`)) : stickers),
    [anyTimed, stickers, key],
  );
  return <PlacedStickers stickers={visible} frameW={frameW} frameH={frameH} />;
}
