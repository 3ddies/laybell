import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Public share pages (deploy with --no-verify-jwt): every Laybell link shared
// OUTSIDE the app points here, so messaging apps' link crawlers (iMessage,
// WhatsApp, Discord, X, Telegram…) get real Open Graph tags — the post's
// thumbnail, title and author — and unfurl a rich preview card,
// Instagram/TikTok-style. Human visitors are immediately bounced through
// laybell.app/open.html, which deep-links into the app or forwards to the
// right app store.
//
// Uses the ANON key deliberately: RLS applies, so hidden accounts, private
// posts and archived content naturally fall back to the generic Laybell card
// instead of leaking through a service-role read.

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_ANON_KEY') ?? '',
);

// Where the static web pages actually LIVE. laybell.app now points at GitHub
// Pages (the old GoDaddy-builder limitation is gone), so humans bounce
// straight to the domain in one hop — the previous github.io constant sent
// them through a redirect that landed on plain http.
//
// REACH THIS FUNCTION VIA open.laybell.app, NOT *.supabase.co. The shared
// functions domain force-serves HTML as text/plain + nosniff, which Apple's
// LinkPresentation parser refuses to read — the reason per-post cards never
// unfurled in iMessage. The custom domain (live 2026-07-29) is not sanitised.
// lib/appLinks.SHARE_PAGE_CUSTOM_BASE is what points the app at it.
const WEB = 'https://laybell.app';
const LOGO = `${WEB}/logo.png`;

// This function's own PUBLIC address, and it has to be a constant: req.url
// inside the edge runtime is the internal request
// (`http://edge-runtime.supabase.com/share-page`), wrong on scheme, host and
// path all three, and neither `host` nor `x-forwarded-host` carries the real
// one. og:url silently advertised that internal URL until this was spotted.
// Keep in sync with lib/appLinks.SHARE_PAGE_CUSTOM_BASE — the app builds share
// links from that constant, so the two must name the same endpoint.
//
// `open.` rather than `api.` because this hostname is READ BY PEOPLE: Apple
// prints the domain at the foot of every card and no meta tag overrides it, so
// the subdomain IS the branding. Mirrors open.spotify.com.
const PUBLIC_BASE = 'https://open.laybell.app/functions/v1/share-page';
const AUDIO_TYPES = ['audio', 'podcast', 'audiobook'];

// Poster frame for a Cloudflare Stream video — every Stream VOD serves one at
// a URL derivable from its manifest. Mirrors lib/cast.cfStreamThumbnail (this
// Deno function can't import app modules). Without it, a video post that has
// no stored thumbnail_url fell back to the generic logo instead of its frame.
const CF_HLS_SUFFIX = /\/manifest\/video\.m3u8(\?.*)?$/;
function cfStreamThumbnail(url: string | null | undefined): string | null {
  if (!url || !url.includes('cloudflarestream.com') || !CF_HLS_SUFFIX.test(url)) return null;
  // Size on WIDTH, because width is what Apple judges: "images should be at
  // least 900 pixels in width", and under 150 they may be shown as a mere icon
  // (TN3156). Aspect is preserved, so a reel still comes back tall — it just
  // arrives big enough for Messages to give it a full-size card.
  //
  // This was `height=720`, which pinned the wrong edge and starved exactly the
  // portrait video that most needs the space: reels came back 404x720. Measured
  // across the live library, 1280 is the value that regresses nothing —
  // landscape frames return byte-identical to before (1280x720), low-res
  // landscape is unchanged (1276x720 -> 1280x722), and portrait goes
  // 404x720 -> 1280x2274. Largest frame stays 148KB, far inside Apple's 10MB
  // budget for a preview's assets.
  //
  // `fit` is deliberately left at Cloudflare's default: an explicit fit=clip
  // refuses to upscale, which quietly SHRANK the one low-resolution landscape
  // video in the library from 1276x720 to its native 638x360.
  return url.replace(CF_HLS_SUFFIX, '/thumbnails/thumbnail.jpg?width=1280');
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

serve(async (req: Request) => {
  const url = new URL(req.url);
  const t = url.searchParams.get('t') ?? 'app';
  const id = url.searchParams.get('id') ?? '';

  // Generic Laybell card (also the fallback for missing/private content).
  let title = 'Laybell — Music & Social';
  let desc = 'Share music, videos and moments. Laybell — music & social, together.';
  let image = LOGO;
  let ogType = 'website';
  let openPath = '';
  // Author, kept separate from `desc` now that the description line carries the
  // "Listen/Watch on Laybell" call to action — music:musician must still name a
  // person, not a CTA.
  let musician = '';

  try {
    if (t === 'post' && id) {
      const { data: p } = await supabase
        .from('posts')
        .select('id, caption, type, thumbnail_url, cover_url, media_url, profiles!posts_user_id_fkey(username, display_name)')
        .eq('id', id)
        .single();
      if (p) {
        const prof: any = (p as any).profiles;
        const who = prof?.display_name || (prof?.username ? `@${prof.username}` : 'Laybell');
        const isAudio = AUDIO_TYPES.includes((p as any).type);
        title = (p as any).caption?.trim() || `${who} on Laybell`;
        musician = who;
        // The line between the title and the domain: WHO POSTED IT, on every
        // post type. This is the line Spotify uses for the artist ("Migos ·
        // Rap Kings Vol 4 · Song · 2023") and it's the whole reason their card
        // reads like a record rather than a link.
        //
        // It briefly said "Watch on Laybell" for video. Apple only renders one
        // line here, so that spent it on branding the domain already provides.
        desc = who;
        // Songs lead with COVER ART (album square); video/photo lead with the
        // frame. Apple sizes the card from the image's own aspect ratio, so a
        // square cover gives Spotify's square card and a 16:9 still gives
        // TikTok's wide one — no card-type flag involved.
        image = isAudio
          ? ((p as any).cover_url || (p as any).thumbnail_url || LOGO)
          // The Cloudflare frame now leads for video, ahead of the stored
          // thumbnail_url. They're the same frame, but the stored copy is
          // baked at whatever size the app saved it (portrait ones measure
          // 404x720 in the live library) while Cloudflare re-renders on demand
          // at native resolution. Falls through unchanged for anything not on
          // Stream, since cfStreamThumbnail returns null there.
          : (((p as any).type === 'video' ? cfStreamThumbnail((p as any).media_url) : null)
              || (p as any).thumbnail_url || (p as any).cover_url
              || ((p as any).type === 'image' ? (p as any).media_url : null)
              || LOGO);
        ogType = isAudio ? 'music.song' : (p as any).type === 'video' ? 'video.other' : 'article';
        openPath = `post/${(p as any).id}`;
      }
    } else if (t === 'community' && id) {
      const { data: c } = await supabase
        .from('communities')
        .select('id, name, description, hashtag, banner_url, member_count')
        .eq('id', id)
        .single();
      if (c) {
        const cc: any = c;
        title = cc.name || 'Community on Laybell';
        // The community's #hashtag is its handle, so it takes the same slot a
        // post's author does — the line above the domain always identifies WHO
        // or WHAT you're being sent to.
        desc = cc.hashtag ? `#${cc.hashtag}` : (cc.description?.trim() || 'Community on Laybell');
        image = cc.banner_url || LOGO;
        ogType = 'website';
        openPath = `communities/${cc.id}`;
      }
    } else if (t === 'profile' && id) {
      const { data: u } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, bio')
        .eq('id', id)
        .single();
      if (u) {
        const name = (u as any).display_name || (u as any).username || 'Laybell artist';
        title = `${name}${(u as any).username ? ` (@${(u as any).username})` : ''} • Laybell`;
        desc = ((u as any).bio || '').trim().slice(0, 160) || `Follow ${name} on Laybell — music & social, together.`;
        image = (u as any).avatar_url || LOGO;
        ogType = 'profile';
        openPath = `profile/${(u as any).id}`;
      }
    }
  } catch { /* fall through to the generic card */ }

  // Humans bounce straight into the app (or the store) via the existing smart
  // landing page; crawlers never execute this and just read the tags.
  const target = `${WEB}/open.html${openPath ? `?p=${encodeURIComponent(openPath)}` : ''}`;

  const q = (extra?: Record<string, string>) =>
    `${PUBLIC_BASE}?${new URLSearchParams({ t, ...(id ? { id } : {}), ...extra })}`;
  const canonicalUrl = q();


  // ONE response for everybody. There used to be a user-agent split here —
  // browsers got a 302 to open.html, "crawlers" got the OG document — which was
  // a workaround for the old *.supabase.co domain, where sanitised HTML meant a
  // human saw raw source and the meta-refresh never ran.
  //
  // On the custom domain it stopped being a workaround and became the bug.
  // Measured against real user-agent strings: a plain iOS Safari or macOS
  // LinkPresentation UA got the 302 and was carried off to open.html, so Apple
  // read THAT page's generic tags and rendered the stock Laybell card — the
  // per-post title, artist and thumbnail never reached it. Only a UA carrying
  // the literal `facebookexternalhit` token landed on the real document, and
  // whether iOS appends that token is not something to depend on.
  //
  // Serving the document to everyone is also what TN3156 assumes: previews do
  // not follow meta redirects and do not run JavaScript, so a crawler reads the
  // tags and stops, while a human is bounced on by the refresh and the script
  // below. It removes a redirect hop from the preview fetch too, which is the
  // kind of thing that makes Messages fall back to "Tap to Load Preview".
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="theme-color" content="#FF0A00">
<meta property="og:site_name" content="Laybell">
<meta property="og:type" content="${esc(ogType)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:alt" content="${esc(title)}">
<meta property="og:url" content="${esc(canonicalUrl)}">${ogType === 'music.song' ? `
<meta property="music:musician" content="${esc(musician)}">` : ''}
<!-- Deliberately NO twitter:card, and no og:image:width/height. This head is
     modelled on a real Spotify track page, fetched and diffed against ours
     because Spotify's card is the one being matched. Spotify sends og:title,
     og:description, og:type=music.song, og:site_name, og:image and the twitter
     title/description/image — and NO twitter:card element whatsoever. Its card
     still renders square, which confirms the shape comes from the image's own
     aspect ratio, not from a card-type flag.
     twitter:card=summary was in here for exactly that shape, and is the likely
     reason the description line vanished: it selects a compact layout that
     drops it.
     The dimensions were hardcoded 640x640 to match Spotify's covers. Measured
     against the real library, ours are 542x543, 777x577, 1176x1176 — mostly
     NOT square and never 640, so the tag was telling Apple the wrong aspect and
     inviting a reflow or a bad crop. Omitted, so Apple measures for itself. -->
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(image)}">
<meta http-equiv="refresh" content="0;url=${esc(target)}">
<style>body{margin:0;background:#0d0d0f;color:#f5f4f2;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh}a{color:#F26522}</style>
</head><body>
<p>Opening Laybell… <a href="${esc(target)}">Continue</a></p>
<script>location.replace(${JSON.stringify(target)});</script>
</body></html>`;

  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Short CDN cache: fresh enough for edited captions, cheap for crawler bursts.
      'cache-control': 'public, max-age=300, s-maxage=600',
    },
  });
});
