import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, RADIUS } from '../constants/theme';
import { formatCount } from '../lib/format';
import { isAudioPost } from '../lib/genres';

// Corner overlay on a post thumbnail: video → view count, audio → listen (stream)
// count. Renders nothing for images or zero counts.
export default function ThumbStat({ type, viewCount, streamCount, style }: {
  type?: string | null;
  viewCount?: number | null;
  streamCount?: number | null;
  style?: any;
}) {
  const isVideo = type === 'video';
  const isAudio = isAudioPost(type ?? '');
  const count = isVideo ? (viewCount ?? 0) : isAudio ? (streamCount ?? 0) : 0;
  if ((!isVideo && !isAudio) || count <= 0) return null;
  return (
    <View style={[styles.badge, style]}>
      <Ionicons name={isVideo ? 'play' : 'headset'} size={9} color="#fff" />
      <Text style={styles.text}>{formatCount(count)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    position: 'absolute', bottom: 6, right: 6,
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: RADIUS.full,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  text: { color: '#fff', fontSize: 10, fontWeight: '700' },
});
