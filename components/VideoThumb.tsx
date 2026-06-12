import { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';

// Shows a video's thumbnail. Uses the stored thumbnail_url when present; otherwise
// generates one from the (remote) media URL in the background, falling back to a
// placeholder until it's ready.
export default function VideoThumb({ thumbnailUrl, mediaUrl, style }: {
  thumbnailUrl?: string | null;
  mediaUrl: string;
  style?: any;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [uri, setUri] = useState<string | null>(thumbnailUrl || null);

  useEffect(() => {
    let cancelled = false;
    if (thumbnailUrl) { setUri(thumbnailUrl); return; }
    setUri(null);
    (async () => {
      try {
        const r = await VideoThumbnails.getThumbnailAsync(mediaUrl, { time: 1000, quality: 0.5 });
        if (!cancelled) setUri(r.uri);
      } catch {
        // keep placeholder
      }
    })();
    return () => { cancelled = true; };
  }, [thumbnailUrl, mediaUrl]);

  if (uri) return <ExpoImage source={{ uri }} style={style} contentFit="cover" />;
  return (
    <LinearGradient colors={['#1C0E06', '#120A04']} style={[style, styles.fallback]}>
      <Ionicons name="videocam" size={24} color={colors.primary} />
    </LinearGradient>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  fallback: { alignItems: 'center', justifyContent: 'center' },
});
