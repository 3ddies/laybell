import { TouchableOpacity } from 'react-native';
import { Image } from 'expo-image';
import { useTheme } from '../contexts/ThemeContext';

// Renders a sent image/GIF attachment inline, sized from its aspect ratio and
// clamped to sensible bounds. expo-image animates GIF/WebP automatically. Pass
// onPress to make it tappable (e.g. to open the full-screen viewer).
export default function AttachmentView({
  url, w, h, maxWidth = 230, radius = 18, onPress, onLongPress,
}: {
  url: string;
  w?: number;
  h?: number;
  maxWidth?: number;
  radius?: number;
  onPress?: () => void;
  onLongPress?: () => void;
}) {
  const { colors } = useTheme();
  const ratio = w && h ? w / h : 1;
  let width = maxWidth;
  let height = width / (ratio || 1);
  // Clamp height so very tall images don't dominate the thread.
  const MAX_H = 300, MIN_H = 80;
  if (height > MAX_H) { height = MAX_H; width = Math.min(maxWidth, height * ratio); }
  if (height < MIN_H) { height = MIN_H; width = Math.min(maxWidth, height * ratio); }
  const img = (
    <Image
      source={{ uri: url }}
      style={{ width, height, borderRadius: radius, backgroundColor: colors.surfaceLight }}
      contentFit="cover"
      transition={120}
    />
  );
  if (!onPress && !onLongPress) return img;
  // alignSelf flex-start so the touch target is JUST the image — not the full
  // width of a stretch-aligned parent (which made taps beside it open the viewer).
  return <TouchableOpacity activeOpacity={0.9} onPress={onPress} onLongPress={onLongPress} delayLongPress={280} style={{ alignSelf: 'flex-start' }}>{img}</TouchableOpacity>;
}
