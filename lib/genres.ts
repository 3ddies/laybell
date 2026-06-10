// Canonical genres. Stored on posts.genre in lowercase; matched exactly on Explore.
export const GENRES = [
  'Rap', 'R&B', 'Meme', 'Life', 'Pop', 'Rock', 'Jazz', 'Electronic', 'Gospel', 'Afrobeats',
  'Lo-Fi', 'Soul', 'Country', 'Classical', 'Reggae', 'Latin',
] as const;

export const GENRE_FILTERS = ['All', ...GENRES] as const;

// Non-music content types shown as filter tags in Explore and Music discover.
// Matched against posts.type ('podcast' | 'audiobook') rather than posts.genre.
export const CONTENT_TAGS = ['Podcasts', 'Audiobooks'] as const;
export type ContentTag = typeof CONTENT_TAGS[number];

// Audio-family post types. Podcasts and audiobooks are audio files stored with
// their own `type` (so they filter into the right tabs) but they must render
// with the same audio/track UI as music everywhere a post is shown.
export function isAudioPost(type?: string | null): boolean {
  return type === 'audio' || type === 'podcast' || type === 'audiobook';
}
