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
// Links shared OUTSIDE the app use the SAME open.html smart link the QR code
// uses — a real https laybell.app URL that unfurls the branded Laybell card
// and, on tap, deep-links into the exact post (or forwards to the store).
//
// These USED to point at the `share-page` Supabase Edge Function for per-post
// OG cards (thumbnail/title/author). Verified live 2026-07-29: that cannot
// work from the shared *.supabase.co functions domain — Supabase force-serves
// HTML as `Content-Type: text/plain` with `X-Content-Type-Options: nosniff`,
// and Apple's LinkPresentation parser (iMessage) respects the content type, so
// the card never unfurled; worse, the human 302 bounced through the stale
// github.io origin onto plain http. Result: shares from Messages "never worked"
// while QR links (which always used open.html) did.
//
// share-page stays deployed with its OG logic intact: per-post rich cards come
// back the day the function sits behind a CUSTOM domain (e.g. the planned
// Cloudflare move, which the AASA content-type fix wants anyway) — then these
// two builders are the only lines that change.
export function postShareUrl(postId: string): string {
  return `${STATIC_WEB_ORIGIN}/open.html?p=${encodeURIComponent('post/' + postId)}`;
}

export function profileRichShareUrl(userId: string): string {
  return profileShareUrl(userId);
}
