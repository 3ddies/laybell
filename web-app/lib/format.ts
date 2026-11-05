// Small pure helpers, matching the mobile app's behaviour (ported, not shared, to
// avoid the monorepo refactor while 1.1.2 is in flight — see docs/WEB_APP_PLAN.md §3).

export function formatCount(n?: number | null): string {
  if (!n || n <= 0) return '0';
  if (n < 10000) return String(Math.round(n));
  const unit = n >= 1_000_000 ? 1_000_000 : 1_000;
  const v = n / unit;
  const s = v.toFixed(v < 100 ? 1 : 0).replace(/\.0$/, '');
  return `${s}${unit === 1_000_000 ? 'M' : 'k'}`;
}

export function timeAgo(iso?: string | null): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24); if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7); if (w < 5) return `${w}w`;
  const mo = Math.floor(d / 30); if (mo < 12) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
}

export type GridPost = {
  id: string;
  type: string | null;
  media_url: string | null;
  thumbnail_url: string | null;
  cover_url: string | null;
  like_count?: number | null;
  comment_count?: number | null;
};

// The thumbnail for a grid tile: cover art for audio, the poster/thumbnail for
// video, the image itself for a photo/slideshow. Null → a gradient placeholder.
export function thumbFor(p: GridPost): string | null {
  if (p.cover_url) return p.cover_url;
  if (p.thumbnail_url) return p.thumbnail_url;
  if (p.type === 'image' || p.type === 'slideshow') return p.media_url;
  return null;
}

export function initial(name?: string | null, handle?: string | null): string {
  return (name || handle || '?').trim().charAt(0).toUpperCase() || '?';
}

// A deterministic gradient for a missing thumbnail, keyed off the id so the same
// post always gets the same colours.
const GRADIENTS = [
  'linear-gradient(150deg,#1e1340,#4b1f8f 55%,#8b2fb0)',
  'linear-gradient(150deg,#0b2a4a,#1f6f9f 60%,#67c6e8)',
  'linear-gradient(150deg,#3a1206,#8a2b12 55%,#f0792a)',
  'linear-gradient(150deg,#101016,#2a2a33 60%,#5b5b66)',
  'linear-gradient(150deg,#16110a,#4a2e12 55%,#f0b03a)',
  'linear-gradient(150deg,#2a0a1e,#7a1f4a 55%,#e85c8a)',
];
export function gradientFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return GRADIENTS[h % GRADIENTS.length];
}
