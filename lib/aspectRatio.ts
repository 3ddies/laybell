// Post format options. Stored as a string on posts.aspect_ratio.
export const IMAGE_FORMATS = ['1:1', '9:16'] as const;
export const VIDEO_FORMATS = ['16:9', '9:16'] as const;

// Numeric width/height ratio for React Native's `aspectRatio` style.
export function aspectToNumber(ratio?: string | null, fallback = 1): number {
  switch (ratio) {
    case '9:16': return 9 / 16;
    case '16:9': return 16 / 9;
    case '1:1': return 1;
    default: return fallback;
  }
}

// [width, height] for ImagePicker's crop `aspect`.
export function aspectToArray(ratio: string): [number, number] {
  const [w, h] = ratio.split(':').map(Number);
  return [w || 1, h || 1];
}

export function defaultFormatFor(type: 'image' | 'video' | 'audio'): string {
  if (type === 'video') return '16:9';
  return '1:1';
}
