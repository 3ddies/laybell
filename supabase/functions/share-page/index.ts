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
// REACH THIS FUNCTION VIA api.laybell.app, NOT *.supabase.co. The shared
// functions domain force-serves HTML as text/plain + nosniff, which Apple's
// LinkPresentation parser refuses to read — the reason per-post cards never
// unfurled in iMessage. The custom domain (live 2026-07-29) is not sanitised.
// lib/appLinks.SHARE_PAGE_CUSTOM_BASE is what points the app at it.
const WEB = 'https://laybell.app';
const LOGO = `${WEB}/logo.png`;
const AUDIO_TYPES = ['audio', 'podcast', 'audiobook'];

// Poster frame for a Cloudflare Stream video — every Stream VOD serves one at
// a URL derivable from its manifest. Mirrors lib/cast.cfStreamThumbnail (this
// Deno function can't import app modules). Without it, a video post that has
// no stored thumbnail_url fell back to the generic logo instead of its frame.
const CF_HLS_SUFFIX = /\/manifest\/video\.m3u8(\?.*)?$/;
function cfStreamThumbnail(url: string | null | undefined): string | null {
  if (!url || !url.includes('cloudflarestream.com') || !CF_HLS_SUFFIX.test(url)) return null;
  return url.replace(CF_HLS_SUFFIX, '/thumbnails/thumbnail.jpg?height=720');
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
        // Apple's LinkPresentation renders og:title as the headline and
        // og:description as the grey line under it, then the domain. Spotify's
        // card is exactly: song name / ARTIST / open.spotify.com — so a song's
        // description is the artist alone, not a marketing sentence. Video
        // matches TikTok's: caption / creator / domain.
        desc = who;
        // Songs lead with COVER ART (album square); video/photo lead with the
        // frame. Apple sizes the card from the image's own aspect ratio, so a
        // square cover gives Spotify's square card and a 16:9 still gives
        // TikTok's wide one — no card-type flag involved.
        image = isAudio
          ? ((p as any).cover_url || (p as any).thumbnail_url || LOGO)
          : ((p as any).thumbnail_url || (p as any).cover_url
              || ((p as any).type === 'image' ? (p as any).media_url : null)
              || ((p as any).type === 'video' ? cfStreamThumbnail((p as any).media_url) : null)
              || LOGO);
        ogType = isAudio ? 'music.song' : (p as any).type === 'video' ? 'video.other' : 'article';
        openPath = `post/${(p as any).id}`;
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

  // Split by user-agent: BROWSERS get a real 302 straight to open.html, link
  // CRAWLERS get the OG document. Originally a workaround (on *.supabase.co the
  // sanitised HTML meant a human saw raw source and the meta-refresh never
  // ran); kept on the custom domain because a 302 is simply the faster, more
  // reliable bounce — one hop, no parsing, no flash of the interstitial.
  const ua = (req.headers.get('user-agent') ?? '').toLowerCase();
  const isCrawler = /facebookexternalhit|whatsapp|discordbot|twitterbot|telegrambot|slackbot|linkedinbot|pinterest|redditbot|skypeuripreview|applebot|googlebot|bingbot|snapchat|vkshare|embedly|quora link preview|bot|crawler|spider/.test(ua);
  if (!isCrawler) {
    return new Response(null, {
      status: 302,
      headers: {
        location: target,
        'cache-control': 'public, max-age=300, s-maxage=600',
      },
    });
  }

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
<meta property="og:url" content="${esc(url.href)}">${ogType === 'music.song' ? `
<!-- Square cover: declaring the dimensions lets Apple lay the card out BEFORE
     the image finishes downloading, so the song card doesn't reflow — the
     detail that makes Spotify's link feel instant in the bubble. -->
<meta property="og:image:width" content="640">
<meta property="og:image:height" content="640">
<meta property="music:musician" content="${esc(desc)}">` : ''}
<meta name="twitter:card" content="${ogType === 'music.song' ? 'summary' : 'summary_large_image'}">
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
