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

// Where the static web pages actually LIVE. laybell.app is currently a
// GoDaddy builder site that can't host these files (open.html/logo.png 404
// there) — GitHub Pages auto-publishes the repo's web/ folder instead. When
// the laybell.app domain is mapped onto Pages, flip this back.
const WEB = 'https://3ddies.github.io/laybell';
const LOGO = `${WEB}/logo.png`;
const AUDIO_TYPES = ['audio', 'podcast', 'audiobook'];

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
        desc = isAudio
          ? `Listen to ${who} on Laybell 🎵`
          : (p as any).type === 'video'
            ? `Watch ${who} on Laybell`
            : `See ${who}'s post on Laybell`;
        image = (p as any).thumbnail_url || (p as any).cover_url
          || ((p as any).type === 'image' ? (p as any).media_url : null) || LOGO;
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
<meta property="og:url" content="${esc(url.href)}">
<meta name="twitter:card" content="summary_large_image">
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
