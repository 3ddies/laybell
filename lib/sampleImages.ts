import type { FilterKey } from './filters';

// Curated, label-matched sample photos (Unsplash CDN — free license, no attribution
// required, stable per-id URLs). Used as:
//   • the effect-chip preview on the LIVE camera, where there's no captured media yet
//     (lib/filters / EffectsTray) — each effect gets a photo that suits its mood;
//   • a genre-matched fallback banner for a community with no uploaded banner_url
//     (CommunityCard).
// Hosted (not bundled) by owner's choice (2026-10-24): zero app-size cost and any image
// can be swapped later by editing a URL — which matters since there's no OTA. A graceful
// gradient still renders underneath, so a failed/slow load never shows a blank tile.

// Small, fast, auto-format; components cover-fit it.
const P = '?w=600&q=70&auto=format';

const u = (base: string) => base + P;

export const EFFECT_SAMPLE: Record<FilterKey, string> = {
  original: u('https://images.unsplash.com/photo-1614204424926-196a80bf0be8'),
  vivid: u('https://images.unsplash.com/photo-1463438690606-f6778b8c1d10'),
  warm: u('https://images.unsplash.com/photo-1496614932623-0a3a9743552e'),
  cool: u('https://images.unsplash.com/photo-1612175228968-956649d3d467'),
  mono: u('https://images.unsplash.com/photo-1504019853082-9a4cb128c1ef'),
  noir: u('https://images.unsplash.com/photo-1634733049839-0292be607569'),
  sepia: u('https://images.unsplash.com/photo-1735739904388-201c3396a0c2'),
  fade: u('https://images.unsplash.com/photo-1551499779-ee50f1aa4d25'),
  dramatic: u('https://images.unsplash.com/photo-1500740516770-92bd004b996e'),
  dreamy: u('https://images.unsplash.com/photo-1501630834273-4b5604d2ee31'),
};

// Keyed by the canonical genre value, LOWERCASED (matches genreLabel()'s input).
const GENRE_SAMPLE: Record<string, string> = {
  rap: u('https://images.unsplash.com/photo-1415886541506-6efc5e4b1786'),
  'r&b': u('https://images.unsplash.com/photo-1629327896333-7ecec1515ae5'),
  meme: u('https://images.unsplash.com/photo-1582298538104-fe2e74c27f59'),
  life: u('https://images.unsplash.com/photo-1656177965828-9e0df65c8e30'),
  pop: u('https://images.unsplash.com/photo-1459749411175-04bf5292ceea'),
  rock: u('https://images.unsplash.com/photo-1565035010268-a3816f98589a'),
  jazz: u('https://images.unsplash.com/photo-1415201364774-f6f0bb35f28f'),
  electronic: u('https://images.unsplash.com/photo-1506157786151-b8491531f063'),
  gospel: u('https://images.unsplash.com/photo-1593678820334-91d5f99be314'),
  afrobeats: u('https://images.unsplash.com/photo-1523689119443-df96632084a1'),
  'lo-fi': u('https://images.unsplash.com/photo-1617239098289-ad0ee436361e'),
  soul: u('https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4'),
  country: u('https://images.unsplash.com/photo-1510915361894-db8b60106cb1'),
  classical: u('https://images.unsplash.com/photo-1612225330812-01a9c6b355ec'),
  reggae: u('https://images.unsplash.com/photo-1629664775239-b6b566b290fa'),
  latin: u('https://images.unsplash.com/photo-1508700929628-666bc8bd84ea'),
};

// The 12 official "Laybell" communities are TOPIC tabs with a NULL genre (see
// laybell_communities.sql), so they get no genre image — key them by their stable hashtag.
const TOPIC_SAMPLE: Record<string, string> = {
  newsmedia: u('https://images.unsplash.com/photo-1566378246598-5b11a0d486cc'),
  sports: u('https://images.unsplash.com/photo-1522778119026-d647f0596c20'),
  entertainment: u('https://images.unsplash.com/photo-1637248578458-934f03db3ea2'),
  politics: u('https://images.unsplash.com/photo-1594581979864-36977b15d0dc'),
  food: u('https://images.unsplash.com/photo-1504674900247-0877df9cc836'),
  education: u('https://images.unsplash.com/photo-1497633762265-9d179a990aa6'),
  gaming: u('https://images.unsplash.com/photo-1493711662062-fa541adb3fc8'),
  health: u('https://images.unsplash.com/photo-1517836357463-d25dfeac3438'),
  fashion: u('https://images.unsplash.com/photo-1613909671501-f9678ffc1d33'),
  lifestyle: u('https://images.unsplash.com/photo-1578894381163-e72c17f2d45f'),
  makeup: u('https://images.unsplash.com/photo-1596462502278-27bfdc403348'),
  beauty: u('https://images.unsplash.com/photo-1555820585-c5ae44394b79'),
};

// Last-resort photo so a community card ALWAYS has a picture (owner: no gradient fallbacks).
const DEFAULT_COMMUNITY = u('https://images.unsplash.com/photo-1727383196205-7205669078f7');

// The label-matched photo for a genre, or undefined.
export function genreImage(genre?: string | null): string | undefined {
  if (!genre) return undefined;
  return GENRE_SAMPLE[genre.toLowerCase()];
}

// A community's picture — a genre photo, else the official-topic photo (by hashtag), else a
// generic default. ALWAYS returns a URL (callers show no gradient). A real uploaded
// banner_url still takes precedence at the call site.
export function communityImage(genre?: string | null, hashtag?: string | null): string {
  return genreImage(genre) ?? (hashtag ? TOPIC_SAMPLE[hashtag.toLowerCase()] : undefined) ?? DEFAULT_COMMUNITY;
}
