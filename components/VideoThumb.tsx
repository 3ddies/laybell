import { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { type ThemePalette } from '../constants/theme';
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
export default function VideoThumb({ thumbnailUrl, mediaUrl, style }: {
  thumbnailUrl?: string | null;
  mediaUrl: string;
  style?: any;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  // Seed straight from the cache so a known clip paints on the very first frame.
  const [uri, setUri] = useState<string | null>(thumbnailUrl || thumbCache.get(mediaUrl) || null);

  useEffect(() => {
    let cancelled = false;
    if (thumbnailUrl) { setUri(thumbnailUrl); return; }
    const cached = thumbCache.get(mediaUrl);
    if (cached) { setUri(cached); return; }
    setUri(null);
    generateThumb(mediaUrl).then((u) => { if (!cancelled && u) setUri(u); });
    return () => { cancelled = true; };
  }, [thumbnailUrl, mediaUrl]);

  if (uri) return <ExpoImage source={{ uri }} style={style} contentFit="cover" cachePolicy="memory-disk" />;
  return (
    <LinearGradient colors={['#1C0E06', '#120A04']} style={[style, styles.fallback]}>
      <Ionicons name="videocam" size={24} color={colors.primary} />
    </LinearGradient>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  fallback: { alignItems: 'center', justifyContent: 'center' },
});
