import { memo, useRef } from 'react';
import { View, TouchableOpacity, StyleSheet, Dimensions } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { previewImageProps } from '../lib/mediaPreview';
import { isAudioPost } from '../lib/genres';
import { slideshowThumb, isSlideshow } from '../lib/slideshow';
import VideoThumb from './VideoThumb';
import ThumbStat from './ThumbStat';
import SpotlightThumbBadge from './SpotlightThumbBadge';

// One square of a profile's grid — Posts, Videos and Reposts, on both profiles.
//
// The grids are FlashLists (1.0.4). They used to mount every post the profile
// had: the query has no limit and all five sub-tabs stay mounted, so a 300-post
// profile built 300 tiles and started 300 image loads before it could scroll.
// Now only the rows near the screen exist, and scrolling reuses them.
//
// Reused views hold no state of their own: everything comes from props, and each
// image's recyclingKey blanks it when the view moves to another post. The
// handlers arrive stable (the screens route them through refs), so the memo
// holds when the profile re-renders.

const SCREEN_W = Dimensions.get('window').width;

export type GridGeometry = { size: number; rowH: number; offsets: number[]; radius: number };

/**
 * FlashList gives each of the three columns an equal third of the width; the
 * gutters come from where the square sits inside its column. Edge to edge
 * (margin 0, gap 2) that is 0, ⅔ and 1⅓pt in — exactly where the old flex-wrap
 * grid put its squares, at the same size.
 */
export function gridGeometry(margin: number, gap: number, radius = 0): GridGeometry {
  const size = (SCREEN_W - margin * 2 - gap * 2) / 3;
  const third = SCREEN_W / 3;
  return { size, rowH: size + gap, offsets: [0, 1, 2].map((k) => margin + k * (size + gap - third)), radius };
}

type Props = {
  post: any;
  tabKey: string;
  col: number;
  geo: GridGeometry;
  spotlighted: boolean;
  // The square's own view comes back with the press, so the viewer can grow out
  // of it (a shared id→view map breaks once views are reused across posts).
  onPress: (post: any, tabKey: string, node: any) => void;
  onLongPress?: (post: any, tabKey: string) => void;
};

function ProfileGridTile({ post, tabKey, col, geo, spotlighted, onPress, onLongPress }: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const nodeRef = useRef<View>(null);
  return (
    <View style={{ height: geo.rowH }}>
      <TouchableOpacity
        ref={nodeRef}
        style={[
          { width: geo.size, height: geo.size, marginLeft: geo.offsets[col] ?? 0 },
          geo.radius ? { borderRadius: geo.radius, overflow: 'hidden' } : null,
        ]}
        onPress={() => onPress(post, tabKey, nodeRef.current)}
        onLongPress={onLongPress ? () => onLongPress(post, tabKey) : undefined}
      >
        {isSlideshow(post.type) ? (
          <>
            {/* Slide 1's screenshot (video) or slide 1 itself (image) */}
            <Image source={{ uri: post.thumb_url || slideshowThumb(post) || undefined }} style={styles.image} contentFit="cover" cachePolicy="memory-disk" recyclingKey={post.id} {...previewImageProps(post)} />
            <View style={styles.typeBadge}>
              <Ionicons name="copy" size={13} color="#fff" />
            </View>
          </>
        ) : post.type === 'video' ? (
          <>
            <VideoThumb thumbnailUrl={post.thumb_url || post.thumbnail_url} placeholder={post.placeholder} mediaUrl={post.media_url} style={styles.image} />
            <View style={styles.typeBadge}>
              <Ionicons name="play" size={14} color="#fff" />
            </View>
          </>
        ) : post.type === 'image' ? (
          <Image source={{ uri: post.thumb_url || post.media_url }} style={styles.image} contentFit="cover" cachePolicy="memory-disk" recyclingKey={post.id} {...previewImageProps(post)} />
        ) : isAudioPost(post.type) && post.cover_url ? (
          <>
            <Image source={{ uri: post.thumb_url || post.cover_url }} style={styles.image} contentFit="cover" cachePolicy="memory-disk" recyclingKey={post.id} {...previewImageProps(post)} />
            <View style={styles.typeBadge}>
              <Ionicons name="musical-notes" size={13} color="#fff" />
            </View>
          </>
        ) : (
          <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.placeholder}>
            <Ionicons name={isAudioPost(post.type) ? 'musical-notes' : 'videocam'} size={28} color={colors.primary} />
          </LinearGradient>
        )}
        {/* Subtle yellow sparkle when this post has a live spotlight. */}
        {spotlighted && <SpotlightThumbBadge />}
        {/* View count (video) / listen count (audio) */}
        <ThumbStat type={post.type} viewCount={post.view_count} streamCount={post.stream_count} />
      </TouchableOpacity>
    </View>
  );
}

export default memo(ProfileGridTile);

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  image: { width: '100%', height: '100%' },
  placeholder: {
    width: '100%', height: '100%',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 0.5, borderColor: colors.border,
  },
  typeBadge: {
    position: 'absolute', top: 6, left: 6,
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center',
  },
});
