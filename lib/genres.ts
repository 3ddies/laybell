// Canonical genres. Stored on posts.genre in lowercase; matched exactly on Explore.
export const GENRES = [
  'Rap', 'R&B', 'Pop', 'Rock', 'Jazz', 'Electronic', 'Gospel', 'Afrobeats', 'Lo-Fi', 'Soul', 'Meme',
] as const;

export const GENRE_FILTERS = ['All', ...GENRES] as const;

// Non-music content types shown as filter tags in Explore and Music discover.
// Matched against posts.type ('podcast' | 'audiobook') rather than posts.genre.
export const CONTENT_TAGS = ['Podcasts', 'Audiobooks'] as const;
export type ContentTag = typeof CONTENT_TAGS[number];
