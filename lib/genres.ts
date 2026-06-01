// Canonical genres. Stored on posts.genre in lowercase; matched exactly on Explore.
export const GENRES = [
  'Rap', 'R&B', 'Pop', 'Rock', 'Jazz', 'Electronic', 'Gospel', 'Afrobeats', 'Lo-Fi', 'Soul',
] as const;

export const GENRE_FILTERS = ['All', ...GENRES] as const;
