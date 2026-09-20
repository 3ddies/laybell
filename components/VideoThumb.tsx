import { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { type ThemePalette } from '../constants/theme';
import { previewImageProps } from '../lib/mediaPreview';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';

// Module-level cache of GENERATED thumbnails, keyed by the source video URL.
// A clip whose post has no stored thumbnail_url is decoded only ONCE — every
// later mount (re-render, re-open, the Page-Layout builder preview ↔ the live
// profile, etc.) reads the cached frame instantly instead of spending a few
// seconds decoding it again. The in-flight map dedupes two instances asking for
// the same URL at the same moment (e.g. a Big Picture hero shown in two places).
const thumbCache = new Map<string, string>();
const thumbInflight = new Map<string, Promise<string | null>>();

function generateThumb(mediaUrl: string): Promise<string | null> {
  const cached = thumbCache.get(mediaUrl);
  if (cached) return Promise.resolve(cached);
  let p = thumbInflight.get(mediaUrl);
  if (!p) {
    p = VideoThumbnails.getThumbnailAsync(mediaUrl, { time: 1000, quality: 0.5 })
      .then((r) => { thumbCache.set(mediaUrl, r.uri); return r.uri; })
      .catch(() => null)
      .finally(() => { thumbInflight.delete(mediaUrl); });
    thumbInflight.set(mediaUrl, p);
  }
  return p;
}

// Shows a video's thumbnail. Uses the stored thumbnail_url when present (instant);
// otherwise generates one from the (remote) media URL once and caches it, falling
// back to a placeholder until it's ready.
//
// Safe inside a recycling list (the profile grids, 1.0.4): what it shows is
// DERIVED from the props on every render, and a generated frame is only used for
// the clip it was made from. It used to copy the props into state and sync them
// in an effect, and a reused view then drew the previous post's picture for a
// frame before the effect caught up.
export default function VideoThumb({ thumbnailUrl, mediaUrl, style, placeholder }: {
  thumbnailUrl?: string | null;
  mediaUrl: string;
  style?: any;
  /** The post's thumbhash (posts.placeholder), drawn blurred while the picture loads. */
  placeholder?: string | null;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  // A frame generated here, tagged with the clip it belongs to.
  const [generated, setGenerated] = useState<{ src: string; uri: string } | null>(null);

  useEffect(() => {
    if (thumbnailUrl || thumbCache.has(mediaUrl)) return;
    let cancelled = false;
    generateThumb(mediaUrl).then((u) => { if (!cancelled && u) setGenerated({ src: mediaUrl, uri: u }); });
    return () => { cancelled = true; };
  }, [thumbnailUrl, mediaUrl]);

  // The cache first, so a known clip paints on the very first frame.
  const uri = thumbnailUrl || thumbCache.get(mediaUrl) || (generated?.src === mediaUrl ? generated.uri : null);

  if (uri || placeholder) {
    return <ExpoImage source={uri ? { uri } : null} style={style} contentFit="cover" cachePolicy="memory-disk" recyclingKey={mediaUrl} {...previewImageProps({ placeholder })} />;
  }
  return (
    <LinearGradient colors={['#1C0E06', '#120A04']} style={[style, styles.fallback]}>
      <Ionicons name="videocam" size={24} color={colors.primary} />
    </LinearGradient>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  fallback: { alignItems: 'center', justifyContent: 'center' },
});
