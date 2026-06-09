// Slideshow (carousel) posts — a post that holds up to 8 images and/or videos
// shown as a swipeable carousel. The media list lives in the posts.slides jsonb
// column (see supabase/sql/post_slideshow.sql); the row's media_url/thumbnail_url/
// aspect_ratio mirror the first slide so existing thumbnail surfaces just work.

export const MAX_SLIDES = 8;

export type Slide = {
  type: 'image' | 'video';
  url: string;
  thumbnail_url?: string | null; // poster for video slides (and convenient for images)
  aspect_ratio?: string | null;  // the slide's native ratio (videos); informational
};

export function isSlideshow(type?: string | null): boolean {
  return type === 'slideshow';
}

// Normalize posts.slides (jsonb → already a JS array from supabase-js, or null)
// into a clean, validated Slide[]. Returns [] for non-slideshow / malformed data.
export function parseSlides(post: any): Slide[] {
  const raw = post?.slides;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s: any) => s && typeof s.url === 'string' && (s.type === 'image' || s.type === 'video'))
    .map((s: any) => ({
      type: s.type,
      url: s.url,
      thumbnail_url: s.thumbnail_url ?? null,
      aspect_ratio: s.aspect_ratio ?? null,
    }));
}

// A guaranteed-image cover URL for a slide (its poster for videos, the image
// itself otherwise). Used for grid thumbnails and the feed poster.
export function slideCover(s: Slide): string {
  return s.type === 'video' ? (s.thumbnail_url || s.url) : s.url;
}
