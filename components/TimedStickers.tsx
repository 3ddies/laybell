import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { PlacedStickers, type Sticker } from './StickerLayer';
import PlacedBandStickers from './BandStickers';
import { isTimed, postStickers, visibleKey } from '../lib/stickerTiming';
import { isBandSticker } from '../lib/bandCaptions';
import { getPlaybackPosition, subscribePlayback } from '../lib/playbackClock';

const NO_SUBSCRIPTION = () => () => {};

// A post's captions over its playing video. Untimed captions always show; timed
// ones — set in the 1.0.3 editor — appear and leave with the playhead, which the
// player feeds through lib/playbackClock. Re-renders only when a caption enters
// or leaves, never on the player's quarter-second tick.
//
// Takes the two columns separately (posts.captions, posts.timed_captions) so the
// merge is memoized against the row's own arrays rather than rebuilt per render.
//
// Draws one kind: a vertical clip's captions placed over the frame, or — given
// `bandRatio` — a horizontal clip's in its letterbox bands (lib/bandCaptions). A
// band caption never lands on a frame, such as a feed card, that has no bands.
export default function TimedStickers({ postId, captions, timedCaptions, frameW, frameH, bandRatio }: {
  postId: string;
  captions: unknown;
  timedCaptions: unknown;
  frameW: number;
  frameH: number;
  /** A horizontal clip's width over height: draw its band captions, on a screen-sized frame. */
  bandRatio?: number;
}) {
  const band = bandRatio != null;
  const stickers = useMemo(
    () => postStickers<Sticker>(captions, timedCaptions).filter((s) => isBandSticker(s) === band),
    [captions, timedCaptions, band],
  );
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
  return band
    ? <PlacedBandStickers stickers={visible} ratio={bandRatio!} screenW={frameW} screenH={frameH} />
    : <PlacedStickers stickers={visible} frameW={frameW} frameH={frameH} />;
}
