import { createContext, useContext, useRef, type ReactNode } from 'react';
import { Alert } from 'react-native';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { supabase } from '../lib/supabase';
import { tg } from '../lib/i18n';
import { uploadStoryMedia, createStory, type StorySticker } from '../lib/stories';
import { compressVideoIfPossible, uploadToStorageWithProgress } from '../lib/upload';
import { removePublicUrls } from '../lib/storageCleanup';
import { useStories } from './StoriesContext';

// ─── Background story upload ─────────────────────────────────────────────────
//
// Posting a story used to BLOCK the composer while it compressed + uploaded +
// inserted the row, so the user watched a % climb on the Post button. This
// provider makes it optimistic: the heavy work (compress, thumbnail, and the
// byte upload) starts the moment media is captured (prewarm), and tapping Post
// just hands over a snapshot and returns to Home immediately — the row is
// inserted in the background the instant the upload lands, so the user's own
// story appears in the tray already-ready (no % readout, no waiting screen).
//
// It MUST live above the composer screen: story-camera resets all its state on
// blur/retake, which would cancel a component-local upload. Uses plain Supabase
// bucket uploads (lib/upload + lib/stories), NOT the Cloudflare posts pipeline.

export type CapturedMedia = {
  uri: string;
  type: 'image' | 'video';
  durationSec?: number;
  processed?: boolean;
};

export type StoryJob = {
  captured: CapturedMedia;
  caption: string | null;
  aspectRatio: string;
  durationSeconds: number | null;
  song: { id: string; title: string; artist: string; artistId: string } | null;
  stickers: StorySticker[] | null;
};

type Uploaded = { mediaUrl: string; thumbnailUrl: string | null };
type Prewarm = { uri: string; promise: Promise<Uploaded>; claimed: boolean };

type StoryUploadValue = {
  /** Start compress/thumbnail/upload for freshly-captured media, in the
   *  background, keyed by its uri. Safe to call repeatedly for the same uri. */
  prewarmStory: (captured: CapturedMedia) => void;
  /** Publish: claim the prewarmed upload (or start it cold), then insert the
   *  story row in the background. Returns immediately — the caller navigates away. */
  enqueueStory: (job: StoryJob) => void;
  /** Abandon an unposted capture: cancels the claim and best-effort deletes any
   *  already-uploaded orphan object(s). No-op once the upload was claimed by post. */
  discardPrewarm: () => void;
};

const StoryUploadContext = createContext<StoryUploadValue>({
  prewarmStory: () => {},
  enqueueStory: () => {},
  discardPrewarm: () => {},
});

export const useStoryUpload = () => useContext(StoryUploadContext);

// The actual compress + upload for one captured file → its public URL(s).
async function uploadCaptured(captured: CapturedMedia): Promise<Uploaded> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error(tg('storyCamera.notAuthenticated'));

  if (captured.type === 'image') {
    let outUri = captured.uri;
    // Camera shots are pre-processed in takePhoto; only library picks need this.
    if (!captured.processed) {
      try {
        const out = await manipulateAsync(captured.uri, [{ resize: { width: 1920 } }], {
          compress: 0.9, format: SaveFormat.JPEG,
        });
        outUri = out.uri;
      } catch { /* fall back to original bytes */ }
    }
    const mediaUrl = await uploadStoryMedia(user.id, outUri, 'jpg', 'image/jpeg');
    return { mediaUrl, thumbnailUrl: null };
  }

  // Video: shrink to ~1080p when the native compressor is present (pass-through
  // otherwise), stream the bytes up, then upload a poster frame (best-effort).
  const upUri = await compressVideoIfPossible(captured.uri);
  const ext = (upUri === captured.uri ? captured.uri.split('.').pop() : 'mp4') || 'mp4';
  const mediaUrl = await uploadToStorageWithProgress('stories', user.id, upUri, ext, 'video/mp4');
  let thumbnailUrl: string | null = null;
  try {
    const { uri } = await VideoThumbnails.getThumbnailAsync(captured.uri, { time: 0 });
    thumbnailUrl = await uploadStoryMedia(user.id, uri, 'jpg', 'image/jpeg');
  } catch { /* poster is optional */ }
  return { mediaUrl, thumbnailUrl };
}

export function StoryUploadProvider({ children }: { children: ReactNode }) {
  const { refresh: refreshStories } = useStories();
  // The single in-flight prewarm. Lives in a ref (not state) — this provider
  // never needs to re-render; the work just runs.
  const prewarmRef = useRef<Prewarm | null>(null);

  const prewarmStory = (captured: CapturedMedia) => {
    if (prewarmRef.current?.uri === captured.uri) return; // already warming this file
    // A different capture replaced the old one before it was posted — clean it up.
    if (prewarmRef.current && !prewarmRef.current.claimed) discardPrewarm();
    const promise = uploadCaptured(captured);
    promise.catch(() => {}); // the real await/handling is in enqueueStory
    prewarmRef.current = { uri: captured.uri, promise, claimed: false };
  };

  const enqueueStory = (job: StoryJob) => {
    // Reuse the prewarmed upload if it matches; otherwise start it now (cold).
    if (!prewarmRef.current || prewarmRef.current.uri !== job.captured.uri) {
      prewarmStory(job.captured);
    }
    const pre = prewarmRef.current!;
    pre.claimed = true;

    (async () => {
      // Fast path: reuse the prewarmed upload. If it FAILED (a transient blip
      // while the user was still editing), don't trust the dead promise — fall
      // through and re-upload fresh, so a recovered network still posts.
      let uploaded: Uploaded | null = null;
      try { uploaded = await pre.promise; } catch { uploaded = null; }
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error(tg('storyCamera.notAuthenticated'));
        // Bounded retries so a momentary failure doesn't silently lose the post
        // now that the composer is gone. A successful upload is reused across
        // createStory retries; only a failed upload is re-attempted.
        for (let attempt = 1; ; attempt++) {
          try {
            if (!uploaded) uploaded = await uploadCaptured(job.captured);
            await createStory({
              userId: user.id,
              mediaUrl: uploaded.mediaUrl,
              mediaType: job.captured.type,
              thumbnailUrl: uploaded.thumbnailUrl,
              caption: job.caption,
              aspectRatio: job.aspectRatio,
              durationSeconds: job.durationSeconds,
              song: job.song,
              stickers: job.stickers,
            });
            refreshStories(); // the finished story pops into the tray, already ready
            return;
          } catch (e) {
            if (attempt >= 3) throw e;
            await new Promise((r) => setTimeout(r, 1500 * attempt));
          }
        }
      } catch (e: any) {
        // The user has already left the composer, so surface the failure here.
        Alert.alert(tg('storyCamera.postFailTitle'), e?.message ?? tg('post.tryAgain'));
      } finally {
        if (prewarmRef.current === pre) prewarmRef.current = null;
      }
    })();
  };

  const discardPrewarm = () => {
    const pre = prewarmRef.current;
    prewarmRef.current = null;
    if (!pre || pre.claimed) return; // posted uploads are kept
    // Once the abandoned upload resolves, delete the orphaned object(s).
    pre.promise
      .then(({ mediaUrl, thumbnailUrl }) => removePublicUrls([mediaUrl, thumbnailUrl]))
      .catch(() => {});
  };

  return (
    <StoryUploadContext.Provider value={{ prewarmStory, enqueueStory, discardPrewarm }}>
      {children}
    </StoryUploadContext.Provider>
  );
}
