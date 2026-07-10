// Laybell TV — casting data layer (Google Cast / Chromecast).
//
// This is the PURE part of casting: turning a Laybell TV item (a horizontal
// video post, or an HLS live) into the `MediaInfo` payload the Cast receiver
// loads. No native module is imported here — the guarded Google Cast bindings
// live in contexts/CastContext. Keeping the mapping here means it's testable and
// safe to import from anywhere (it can't crash a binary that lacks the native
// Cast SDK).
//
// SCOPE: only Laybell TV content is ever castable — landscape video posts (HLS
// via Cloudflare Stream) and RTMP/HLS lives. WebRTC (low-latency) lives are NOT
// castable to a Chromecast receiver, so liveToCastItem returns null for them.

import { aspectToNumber } from './aspectRatio';
import type { LiveStream } from './live';

// HLS mime — tells the default media receiver to use its HLS player.
export const HLS_CONTENT_TYPE = 'application/x-mpegURL';

export type CastItem = {
  /** The Laybell post/stream id — used to de-dupe and to map back to the queue. */
  id: string;
  /** HLS manifest URL the receiver plays (Cloudflare Stream .m3u8). */
  url: string;
  title: string;
  subtitle?: string;
  /** Poster/thumbnail shown on the TV before the first frame + in the remote. */
  poster?: string | null;
  isLive?: boolean;
};

/** A horizontal video post → castable item. Returns null if it has no playable URL. */
export function postToCastItem(p: any): CastItem | null {
  if (!p?.media_url) return null;
  const username = p?.profiles?.username ? `@${p.profiles.username}` : undefined;
  const title = (p.caption?.trim() as string) || p?.profiles?.display_name || username || 'Laybell TV';
  return {
    id: p.id,
    url: p.media_url,
    title,
    subtitle: username,
    poster: p.thumbnail_url ?? null,
    isLive: false,
  };
}

/** True for a landscape video post — mirrors lib/tv.isHorizontalVideo. */
export function isCastableVideo(p: any): boolean {
  return p?.type === 'video' && !!p?.media_url && aspectToNumber(p?.aspect_ratio, 9 / 16) > 1;
}

/**
 * A live stream → castable item. ONLY RTMP lives carry an HLS playback_url a
 * Chromecast can play; WebRTC (WHEP) lives are low-latency-only and can't cast,
 * so those return null and the UI hides the cast affordance for them.
 */
export function liveToCastItem(l: LiveStream): CastItem | null {
  if (l.mode !== 'rtmp' || !l.playback_url) return null;
  const username = l.profile?.username ? `@${l.profile.username}` : undefined;
  return {
    id: l.id,
    url: l.playback_url,
    title: l.title || l.profile?.display_name || username || 'Laybell Live',
    subtitle: username,
    poster: l.profile?.avatar_url ?? null,
    isLive: true,
  };
}

/**
 * Build the Google Cast `MediaInfo` for an item. Shape matches
 * react-native-google-cast's LoadMediaRequest.mediaInfo. Kept untyped (`any`)
 * so this module never has to import the native package's types.
 */
export function buildMediaInfo(item: CastItem): any {
  return {
    contentUrl: item.url,
    contentType: HLS_CONTENT_TYPE,
    streamType: item.isLive ? 'live' : 'buffered',
    metadata: {
      type: 'movie',
      title: item.title,
      subtitle: item.subtitle,
      images: item.poster ? [{ url: item.poster }] : undefined,
    },
  };
}
