import { tg } from './i18n';

// Canonical genres. Stored on posts.genre in lowercase; matched exactly on Explore.
// These strings are the CANONICAL values (used for storage + comparison); the UI
// renders them through genreLabel() so the display text is localized while the
// stored/compared value stays the English canonical form.
export const GENRES = [
  'Rap', 'R&B', 'Meme', 'Life', 'Pop', 'Rock', 'Jazz', 'Electronic', 'Gospel', 'Afrobeats',
  'Lo-Fi', 'Soul', 'Country', 'Classical', 'Reggae', 'Latin',
] as const;

export const GENRE_FILTERS = ['All', ...GENRES] as const;

// Non-music content types shown as filter tags in Explore and Music discover.
// Matched against posts.type ('podcast' | 'audiobook') rather than posts.genre.
export const CONTENT_TAGS = ['Podcasts', 'Audiobooks'] as const;
export type ContentTag = typeof CONTENT_TAGS[number];

// Localized display label for a genre / filter / content-tag value. Accepts the
// canonical value in any case (e.g. 'Rap' or 'rap'); unknown values fall back to
// the raw input so user-entered or new genres still render.
const GENRE_LABEL_KEYS: Record<string, string> = {
  'all': 'genre.all', 'rap': 'genre.rap', 'r&b': 'genre.rnb', 'meme': 'genre.meme',
  'life': 'genre.life', 'pop': 'genre.pop', 'rock': 'genre.rock', 'jazz': 'genre.jazz',
  'electronic': 'genre.electronic', 'gospel': 'genre.gospel', 'afrobeats': 'genre.afrobeats',
  'lo-fi': 'genre.lofi', 'soul': 'genre.soul', 'country': 'genre.country',
  'classical': 'genre.classical', 'reggae': 'genre.reggae', 'latin': 'genre.latin',
  'podcasts': 'genre.podcasts', 'audiobooks': 'genre.audiobooks',
};
export function genreLabel(value?: string | null): string {
  if (!value) return '';
  const key = GENRE_LABEL_KEYS[value.toLowerCase()];
  return key ? tg(key) : value;
}

// Audio-family post types. Podcasts and audiobooks are audio files stored with
// their own `type` (so they filter into the right tabs) but they must render
// with the same audio/track UI as music everywhere a post is shown.
export function isAudioPost(type?: string | null): boolean {
  return type === 'audio' || type === 'podcast' || type === 'audiobook';
}
