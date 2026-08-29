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
  // How this slide meets the carousel's frame: 'cover' crops it to fill,
  // 'contain' letterboxes it so nothing is cut off. Absent on every post made
  // before the Arrange screen existed, which is why the reader below falls back
  // to 'cover' — that is what those posts were published as.
  fit?: 'cover' | 'contain' | null;
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
      fit: s.fit === 'contain' ? 'contain' : 'cover',
    }));
}

/** How a slide should meet the frame. Older posts carry no `fit` and were
 *  published cropped, so cover is the only safe default. */
export function slideFit(s: Slide): 'cover' | 'contain' {
  return s.fit === 'contain' ? 'contain' : 'cover';
}

// A guaranteed-image cover URL for a slide (its poster for videos, the image
// itself otherwise). Used for grid thumbnails and the feed poster.
export function slideCover(s: Slide): string {
  return s.type === 'video' ? (s.thumbnail_url || s.url) : s.url;
}

// Best STATIC thumbnail for a slideshow post on grids: slide 1's screenshot
// when it's a video, or slide 1 itself when it's an image. Falls back to the
// first image-type slide (older posts where the video screenshot upload
// failed — media_url would be a video file an <Image> can't render).
export function slideshowThumb(post: {
  thumbnail_url?: string | null; media_url?: string | null; slides?: any;
}): string | null {
  if (post.thumbnail_url) return post.thumbnail_url;
  const slides = parseSlides(post);
  const first = slides[0];
  if (first) {
    if (first.type === 'image') return first.url;
    if (first.thumbnail_url) return first.thumbnail_url;
  }
  const img = slides.find((s) => s.type === 'image');
  if (img) return img.url;
  // Last resort — only correct when slide 1 was an image.
  return first?.type === 'image' ? first.url : post.media_url ?? null;
}
