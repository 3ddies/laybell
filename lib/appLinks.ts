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

// ── Rich share pages (server-rendered Open Graph) ───────────────────────────
// Links shared OUTSIDE the app point at the `share-page` Supabase Edge
// Function, which serves real OG tags — the post's thumbnail, title and
// author — so iMessage/WhatsApp/Discord/X unfurl a rich preview card,
// Instagram/TikTok-style (a bare laybell.app/post link has no page behind it
// on the static site, so chats rendered it as dead text). Humans who tap are
// bounced through open.html into the app or on to the store. If laybell.app
// ever gains serverless routing, alias these paths onto the domain and only
// this constant changes.
export const SHARE_PAGE_BASE = 'https://wawpaokvtptfmuygjnns.supabase.co/functions/v1/share-page';

export function postShareUrl(postId: string): string {
  return `${SHARE_PAGE_BASE}?t=post&id=${encodeURIComponent(postId)}`;
}

export function profileRichShareUrl(userId: string): string {
  return `${SHARE_PAGE_BASE}?t=profile&id=${encodeURIComponent(userId)}`;
}
