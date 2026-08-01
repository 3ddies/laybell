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
// via Cloudflare Stream) and RTMP-ingested lives. Chromecast can't speak WHEP,
// and Cloudflare's WebRTC beta can't serve WHIP broadcasts over HLS/DASH
// either (see liveHlsUrl), so phone lives are not castable yet.

import { aspectToNumber } from './aspectRatio';
import { liveThumbnailUrl, type LiveStream } from './live';
import { TV_AD_EVERY_VIDEOS, TV_AD_FIRST_VIDEOS, type AdMeta } from './ads';

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

/**
 * A frame of a Cloudflare Stream video at a specific time — the ONLY way to grab
 * frames from a Stream video on-device: AVAssetImageGenerator (expo-video-
 * thumbnails) can't seek HLS, so the GIF maker + trim strip fetch these instead.
 * Same `height` for every frame keeps the pixel space consistent for cropping.
 */
export function cfStreamFrameUrl(url: string, timeSec: number, height = 640): string | null {
  if (!isCfStreamHls(url)) return null;
  return url.replace(CF_HLS_SUFFIX, `/thumbnails/thumbnail.jpg?time=${Math.max(0, timeSec).toFixed(2)}s&height=${height}`);
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
  /** A woven Laybell TV ad — can't be skipped past until it finishes on the TV. */
  isAd?: boolean;
  /** Ad meta (advertiser/CTA/campaign) for a sponsored cast item. */
  ad?: AdMeta;
};

/** A Laybell TV ad item (lib/ads.tvItemFor) → a castable, unskippable sponsor. */
export function adToCastItem(adItem: any): CastItem | null {
  const meta: AdMeta | undefined = adItem?.__ad;
  if (!adItem?.media_url || !meta) return null;
  return {
    id: adItem.id,
    url: adItem.media_url,
    title: meta.headline || meta.advertiserName || 'Sponsored',
    subtitle: meta.advertiserName,
    poster: adItem.thumbnail_url ?? null,
    authorId: null,
    isLive: false,
    isAd: true,
    ad: meta,
  };
}

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
 * The live HLS manifest for a stream — only RTMP-ingested lives have one.
 * Cloudflare's WebRTC beta explicitly does NOT support "streaming using WHIP
 * and playing using HLS or DASH" (developers.cloudflare.com/stream/webrtc-beta),
 * so a phone (WHIP) live has no manifest a TV receiver could load — casting one
 * shows the title card and never plays. When Cloudflare ships WHIP→HLS
 * ("coming soon"), deriving `origin/<cf_input_uid>/manifest/video.m3u8` from
 * the stored WHEP url here makes phone lives castable with no other change.
 */
export function liveHlsUrl(l: LiveStream): string | null {
  return l.mode === 'rtmp' && l.playback_url ? l.playback_url : null;
}

/**
 * A live stream → castable item, via its live HLS manifest — a Chromecast
 * plays that like any other video, full-screen. Phone (WHIP) lives have no
 * HLS (see liveHlsUrl) → null, and the UI falls back to the on-phone viewer.
 */
export function liveToCastItem(l: LiveStream): CastItem | null {
  const url = liveHlsUrl(l);
  if (!url) return null;
  const username = l.profile?.username ? `@${l.profile.username}` : undefined;
  return {
    id: l.id,
    url,
    title: l.title || l.profile?.display_name || username || 'Laybell Live',
    subtitle: username,
    // The live frame (RTMP inputs) makes a far better TV poster than the avatar;
    // falls back to the avatar when Cloudflare has no thumbnail (WHIP/pre-frame).
    poster: liveThumbnailUrl(l) ?? l.profile?.avatar_url ?? null,
    // Lives have no post row (no like/comment/save), but the remote's 3-dot
    // uses the host's id for the profile-only menu (report/block).
    authorId: l.user_id ?? null,
    isLive: true,
  };
}

// ─── Sponsor cadence for cast queues ──────────────────────────────────────────
/**
 * Weave sponsor items into a cast queue at the Laybell TV cadence: first ad
 * after TV_AD_FIRST_VIDEOS videos, then one every TV_AD_EVERY_VIDEOS — counted
 * since the last sponsor, so the opening gap can differ (identical to the
 * counting the /tv grid tap uses).
 *
 * Returns `items` UNCHANGED when there is nothing to do: empty pool, a queue
 * that already carries ads (never double-weave a pre-woven queue), or a queue
 * with lives in it (ads must not interrupt live-hopping — a live's queue is
 * other lives, and a VOD ad in the middle of it would yank the viewer out of
 * real-time).
 *
 * `startRotation` offsets which sponsor comes first, so consecutive queues in
 * one session rotate through the pool instead of always opening with the same
 * advertiser. Callers pass a running counter and advance it by the number of
 * ads actually woven.
 */
export function weaveAdsIntoCastQueue(items: CastItem[], adPool: CastItem[], startRotation = 0): CastItem[] {
  if (!adPool.length || !items.length) return items;
  if (items.some((x) => x.isAd || x.isLive)) return items;
  const out: CastItem[] = [];
  let adRot = startRotation;
  let sinceAd = 0;
  let need = TV_AD_FIRST_VIDEOS;
  for (const it of items) {
    out.push(it);
    sinceAd++;
    if (sinceAd >= need) {
      out.push(adPool[adRot % adPool.length]);
      adRot++;
      sinceAd = 0;
      need = TV_AD_EVERY_VIDEOS;
    }
  }
  return out;
}

// ─── Between-posts splash ─────────────────────────────────────────────────────
// Moving to the next queue item flashes a Laybell-branded card on the TV for a
// beat (TV-only — the phone remote already shows the incoming item). The card
// is web/tv-splash.png, auto-published to GitHub Pages by deploy-legal.yml.
export const TV_SPLASH_URL = 'https://3ddies.github.io/laybell/tv-splash.png';
// How long the card holds before the next video's load starts. The card and
// the video load are strictly SERIAL on the receiver (it plays one thing at a
// time), so every ms here adds to the total between-video gap — 1000ms reads
// clearly as branding without dragging the transition.
export const TV_SPLASH_MS = 1000;

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
  // A LEGACY ad creative is a progressive MP4 (uploaded straight to the posts
  // bucket) — flag it video/mp4. Newer ad creatives go through Cloudflare Stream
  // (isCfStreamHls → dash above), so they cast exactly like a normal video.
  const mp4 = !!item.isAd && !item.isLive && !isCfStreamHls(item.url);
  return {
    contentUrl: dash ? toCfDash(item.url) : item.url,
    contentType: mp4 ? 'video/mp4' : (dash ? DASH_CONTENT_TYPE : HLS_CONTENT_TYPE),
    streamType: item.isLive ? 'live' : 'buffered',
    // Non-Cloudflare VOD HLS (shouldn't exist, but stay safe): declare CMAF
    // segments — the receiver otherwise assumes MPEG-TS, "loads" the item
    // (title + poster show) and then silently never plays. Lives + MP4 ads are
    // left to the receiver's default.
    ...(item.isLive || dash || mp4 ? {} : { hlsSegmentFormat: 'FMP4', hlsVideoSegmentFormat: 'FMP4' }),
    // Poster = the item's OWN thumbnail (Cloudflare — same CDN as the video, so
    // it resolves as fast as the stream itself). Do NOT put the GitHub-Pages
    // splash image here: the receiver fetches the poster as part of loading the
    // media, and if the TV's network reaches GitHub Pages slowly, playback
    // stalls waiting on it (a multi-minute hang was exactly that). The
    // between-video grey-before-logo is cosmetic and NOT worth risking the
    // load path — leave the splash card to warm via the idle screen only.
    metadata: {
      type: 'movie',
      title: item.title,
      subtitle: item.subtitle,
      images: item.poster ? [{ url: item.poster }] : undefined,
    },
  };
}
