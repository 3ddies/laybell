// Central definitions for Laybell's public web origin, the smart "open in app
// or send to the store" link a QR encodes, and the app-store URLs.
//
// How the smart link works: a QR code encodes a plain https URL on our domain
// (web/open.html). When someone scans it:
//   • If they have the app, open.html bounces them into it via the laybell://
//     scheme (deep-linking straight to the profile).
//   • If they don't, open.html detects iOS/Android and forwards them to the
//     right app store to download Laybell.
// Using a web landing page (instead of a raw universal link) means the store
// fallback works on every device without depending on iOS AASA / Android
// autoVerify being set up for the profile path.

export const WEB_ORIGIN = 'https://laybell.app';

// App-store destinations for visitors without the app. Keep these in sync with
// the copies hard-coded in web/open.html (that file is static and can't import
// this module).
export const STORE_URLS = {
  // TODO: replace id000000000 with Laybell's real Apple App Store numeric ID
  // once the app is live on the App Store.
  ios: 'https://apps.apple.com/app/laybell/id000000000',
  android: 'https://play.google.com/store/apps/details?id=com.laybell.app',
} as const;

// The static pages now live on the real domain. laybell.app points at GitHub
// Pages (four apex A records + a www CNAME), which publishes web/ on every push
// to dev — so open.html, the legal pages and /.well-known/ are all served from
// the domain root.
//
// This used to be https://3ddies.github.io/laybell, because the GoDaddy website
// builder that previously answered for laybell.app could not host arbitrary
// files and open.html 404'd there. Every QR code minted before this change
// encodes the github.io URL; those keep working, because GitHub redirects the
// old origin to the custom domain.
export const STATIC_WEB_ORIGIN = 'https://laybell.app';

// The QR/share URL for a user's profile. `userId` is the profiles.id used by the
// in-app /profile/[id] route.
export function profileShareUrl(userId: string): string {
  return `${STATIC_WEB_ORIGIN}/open.html?p=${encodeURIComponent('profile/' + userId)}`;
}

// ── External share links ────────────────────────────────────────────────────
// Links shared OUTSIDE the app (post / song / reel) point at the `share-page`
// Edge Function, which serves per-item Open Graph tags so iMessage, WhatsApp,
// Discord etc. unfurl a real card — a song's square album cover (Spotify-style)
// or a post's thumbnail — and bounces humans who tap through open.html into the
// app.
//
// The host matters more than the function, TWICE OVER.
//
// 1. It decides whether a card renders at all. On the SHARED *.supabase.co
//    functions domain, Supabase force-rewrites HTML to `Content-Type:
//    text/plain` with `nosniff` (anti-phishing); Apple's LinkPresentation
//    parser respects the content type, so the tags were never read and shared
//    posts silently showed no card while QR links — which have always used
//    open.html — worked fine. A Supabase CUSTOM domain is not sanitised.
// 2. It decides what the card SAYS at the bottom. Per Apple's TN3156 that line
//    is the domain, and no meta tag replaces it — og:site_name is "Laybell" and
//    the card still printed the hostname. The subdomain is therefore the only
//    lever, which is why this is `open.` and not the original `api.`: Spotify's
//    cards read `open.spotify.com`, so Laybell's now read `open.laybell.app`.
//
// open.laybell.app: CNAME → wawpaokvtptfmuygjnns.supabase.co, ACME + ownership
// TXT verified, SSL provisioned, activated 2026-07-29 (replacing api.laybell.app
// the same day — Supabase allows one custom domain per project, so the old
// hostname is gone and links shared before the swap are dead). Confirmed live on
// activation that it returns `text/html; charset=utf-8` with no nosniff, and
// that a song and a video post each unfurl with the right og:type and a
// fetchable image.
//
// Set this back to null to fall back to the open.html smart link (the branded
// generic Laybell card) — that is the only line that would need to change.
//
// This does NOT affect how the app talks to Supabase: lib/supabase.ts still
// uses the wawpaokvtptfmuygjnns.supabase.co URL, and REST/storage/auth were
// re-verified 200 there after activation. A custom domain adds a hostname, it
// doesn't withdraw the original.
export const SHARE_PAGE_CUSTOM_BASE: string | null = 'https://open.laybell.app/functions/v1/share-page';

export function postShareUrl(postId: string): string {
  return SHARE_PAGE_CUSTOM_BASE
    ? `${SHARE_PAGE_CUSTOM_BASE}?t=post&id=${encodeURIComponent(postId)}`
    : `${STATIC_WEB_ORIGIN}/open.html?p=${encodeURIComponent('post/' + postId)}`;
}

export function profileRichShareUrl(userId: string): string {
  return SHARE_PAGE_CUSTOM_BASE
    ? `${SHARE_PAGE_CUSTOM_BASE}?t=profile&id=${encodeURIComponent(userId)}`
    : profileShareUrl(userId);
}

// A community's share link. Unfurls a card with the community's name, its
// #hashtag and its banner; tapping deep-links to /communities/<id>, or forwards
// to the store for anyone without the app.
export function communityShareUrl(communityId: string): string {
  return SHARE_PAGE_CUSTOM_BASE
    ? `${SHARE_PAGE_CUSTOM_BASE}?t=community&id=${encodeURIComponent(communityId)}`
    : `${STATIC_WEB_ORIGIN}/open.html?p=${encodeURIComponent('communities/' + communityId)}`;
}
