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
export const DASH_CONTENT_TYPE = 'application/dash+xml';

// Cloudflare Stream serves every VOD as BOTH `manifest/video.m3u8` (HLS) and
// `manifest/video.mpd` (DASH) from the same base URL, plus a poster frame at
// `thumbnails/thumbnail.jpg`.
const CF_HLS_SUFFIX = /\/manifest\/video\.m3u8(\?.*)?$/;

export function isCfStreamHls(url: string): boolean {
  return url.includes('cloudflarestream.com') && CF_HLS_SUFFIX.test(url);
}

/** The same Cloudflare Stream video as a DASH manifest. */
export function toCfDash(url: string): string {
  return url.replace(CF_HLS_SUFFIX, '/manifest/video.mpd');
}

/** Poster frame for a Cloudflare Stream video (fallback when a post has no thumbnail). */
export function cfStreamThumbnail(url: string): string | null {
  if (!isCfStreamHls(url)) return null;
  return url.replace(CF_HLS_SUFFIX, '/thumbnails/thumbnail.jpg?height=720');
}

export type CastItem = {
  /** The Laybell post/stream id — used to de-dupe and to map back to the queue. */
  id: string;
  /** HLS manifest URL the receiver plays (Cloudflare Stream .m3u8). */
  url: string;
  title: string;
  subtitle?: string;
  /** Poster/thumbnail shown on the TV before the first frame + in the remote. */
  poster?: string | null;
  /** The post's author — the remote's like/comment actions notify them. */
  authorId?: string | null;
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
    // Callers that haven't resolved the post's thumbnail yet (or old posts
    // without one) still get a poster — Cloudflare serves a frame per video.
    poster: p.thumbnail_url ?? cfStreamThumbnail(p.media_url),
    authorId: p.user_id ?? null,
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
    // Lives have no post row (no like/comment/save), but the remote's 3-dot
    // uses the host's id for the profile-only menu (report/block).
    authorId: l.user_id ?? null,
    isLive: true,
  };
}

// ─── Between-posts splash ─────────────────────────────────────────────────────
// Moving to the next queue item flashes a Laybell-branded card on the TV for a
// beat (TV-only — the phone remote already shows the incoming item). The card
// is web/tv-splash.png, auto-published to GitHub Pages by deploy-legal.yml.
export const TV_SPLASH_URL = 'https://3ddies.github.io/laybell/tv-splash.png';
export const TV_SPLASH_MS = 1400;

/** The Laybell interstitial card as receiver-loadable media (a photo). */
export function buildSplashMediaInfo(): any {
  return {
    contentUrl: TV_SPLASH_URL,
    contentType: 'image/png',
    streamType: 'none',
    metadata: { type: 'photo', title: 'Laybell' },
  };
}

/**
 * Build the Google Cast `MediaInfo` for an item. Shape matches
 * react-native-google-cast's LoadMediaRequest.mediaInfo. Kept untyped (`any`)
 * so this module never has to import the native package's types.
 */
export function buildMediaInfo(item: CastItem): any {
  // VOD prefers the DASH manifest: Cloudflare's fMP4 HLS starts a few seconds
  // into the clip on the Default Media Receiver (the first fragment's
  // timestamps don't begin at zero, and HLS leaves the join point to the
  // player), while the DASH timeline is explicit and zero-based, so playback
  // starts at the true 0:00. Lives stay HLS (that's their only manifest).
  const dash = !item.isLive && isCfStreamHls(item.url);
  return {
    contentUrl: dash ? toCfDash(item.url) : item.url,
    contentType: dash ? DASH_CONTENT_TYPE : HLS_CONTENT_TYPE,
    streamType: item.isLive ? 'live' : 'buffered',
    // Non-Cloudflare VOD HLS (shouldn't exist, but stay safe): declare CMAF
    // segments — the receiver otherwise assumes MPEG-TS, "loads" the item
    // (title + poster show) and then silently never plays. Lives are left to
    // the receiver's default: Stream Live segment format is unverified, and
    // mis-flagging breaks it the same way.
    ...(item.isLive || dash ? {} : { hlsSegmentFormat: 'FMP4', hlsVideoSegmentFormat: 'FMP4' }),
    metadata: {
      type: 'movie',
      title: item.title,
      subtitle: item.subtitle,
      images: item.poster ? [{ url: item.poster }] : undefined,
    },
  };
}
