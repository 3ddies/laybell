// GIF / meme search via Giphy. Free instant key (no Google Cloud): sign up at
// https://developers.giphy.com/dashboard/ → Create an App → API → copy the key,
// then paste it into GIPHY_KEY below.
//
// Giphy asks that results carry a "Powered by GIPHY" attribution — GifPickerModal
// shows it. Until a key is set, gifSearchAvailable() is false and the picker shows
// a "add a key" hint instead of failing.

const GIPHY_KEY = 'cxuBm7EAzemhNppUmg4vCzUhZflCKO3K';

export type Gif = { id: string; url: string; preview: string; w: number; h: number };

export function gifSearchAvailable(): boolean {
  return GIPHY_KEY.length > 0;
}

function mapResults(json: any): Gif[] {
  const out: Gif[] = [];
  for (const r of json?.data ?? []) {
    const img = r.images ?? {};
    const full = img.downsized_medium ?? img.original ?? img.fixed_width; // sent GIF
    const prev = img.fixed_width ?? img.preview_gif ?? full;              // grid thumb
    if (!full?.url) continue;
    out.push({
      id: String(r.id),
      url: full.url,
      preview: prev?.url ?? full.url,
      w: Number(full.width) || Number(prev?.width) || 0,
      h: Number(full.height) || Number(prev?.height) || 0,
    });
  }
  return out;
}

// Search GIFs; an empty query returns Giphy's Trending feed.
export async function searchGifs(query: string, limit = 24): Promise<Gif[]> {
  if (!gifSearchAvailable()) return [];
  const q = query.trim();
  const base = q
    ? `https://api.giphy.com/v1/gifs/search?q=${encodeURIComponent(q)}&`
    : 'https://api.giphy.com/v1/gifs/trending?';
  const url = `${base}api_key=${GIPHY_KEY}&limit=${limit}&rating=pg-13`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    return mapResults(await res.json());
  } catch {
    return [];
  }
}
