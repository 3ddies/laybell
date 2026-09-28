import { Image as ExpoImage } from 'expo-image';
import { StyleSheet } from 'react-native';
import AppVideo from './AppVideo';
import { REPOST_MAX_SEC } from '../lib/stories';
import { SPACING } from '../constants/theme';

const REPOST_MAX_MS = REPOST_MAX_SEC * 1000;

// The reshared post's BASE card size at scale 1 — a fit to the post's aspect inside
// the screen minus the story chrome. Shared by the editor (the post sticker's base
// size, which the gesture layer then scales) and the viewer (so the stored scale
// maps to the same pixels), so the post looks identical in both.
export function repostCardSize(W: number, H: number, insetsTop: number, insetsBottom: number, aspect: number): { cardW: number; cardH: number } {
  const boxW = W - SPACING.md * 2;
  const boxH = H - (insetsTop + 72) - (insetsBottom + 104);
  let cardW = boxW;
  let cardH = cardW / aspect;
  if (cardH > boxH) { cardH = boxH; cardW = cardH * aspect; }
  return { cardW, cardH };
}

export type RepostMediaPost = {
  type: string;
  media_url: string | null;
  thumbnail_url?: string | null;
  cover_url?: string | null;
};

// The reshared post's media, sized to FILL its parent card (the card is sized to
// the post's own aspect, so cover-fit never crops). Shared by the Post-to-story
// EDITOR — where it loops silently as a live preview — and the story VIEWER, where
// it plays with audio and its progress bar is capped + advances at REPOST_MAX_SEC.
// One element in both places so the post looks and behaves the same where it is
// placed and where it is watched.
export default function RepostPostMedia({
  post, active, loop, muted, reloadKey, progressIntervalMs,
  onReady, onProgressFrac, onReachedCap, onEnd, onImageError,
}: {
  post: RepostMediaPost;
  active: boolean;
  loop?: boolean;                          // editor preview loops; the viewer does not
  muted?: boolean;
  reloadKey?: string | number;             // remount an image to retry a 404 (viewer)
  progressIntervalMs?: number;
  onReady?: () => void;
  onProgressFrac?: (frac: number) => void; // 0..1 against the 20s cap (viewer)
  onReachedCap?: () => void;               // reached the 20s cap → advance (viewer)
  onEnd?: () => void;
  onImageError?: () => void;
}) {
  if (post.type === 'video') {
    return (
      <AppVideo
        source={{ uri: post.media_url ?? '' }}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        active={active}
        loop={loop}
        ownsAudio
        muted={muted}
        showStallIndicator
        poster={post.thumbnail_url ?? post.cover_url ?? undefined}
        posterContentFit="cover"
        progressIntervalMs={progressIntervalMs}
        onReady={onReady}
        onProgress={(pos: number, dur: number) => {
          if (onProgressFrac) {
            const cap = Math.min(dur || REPOST_MAX_MS, REPOST_MAX_MS);
            onProgressFrac(Math.min(1, pos / (cap || 1)));
          }
          if (onReachedCap && pos >= REPOST_MAX_MS) onReachedCap();
        }}
        onEnd={onEnd}
      />
    );
  }
  return (
    <ExpoImage
      key={reloadKey}
      source={{ uri: post.cover_url ?? post.thumbnail_url ?? post.media_url ?? '' }}
      style={StyleSheet.absoluteFill}
      contentFit="cover"
      cachePolicy="memory-disk"
      onLoad={onReady}
      onError={onImageError}
    />
  );
}
