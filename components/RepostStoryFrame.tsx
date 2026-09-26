import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, useWindowDimensions } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabase';
import { aspectToNumber } from '../lib/aspectRatio';
import { GRADIENTS, RADIUS, SPACING, type ThemePalette } from '../constants/theme';
import { useThemedStyles } from '../contexts/ThemeContext';

// The Instagram-style frame for a post reshared to a story: the post's still sits
// blurred edge-to-edge behind, and the post itself (the `children` — a playing
// video or a still) fills a rounded card sized to the POST'S OWN aspect (so a
// horizontal post reads horizontal, a vertical one fills), with a small author chip
// that opens the original on tap.
//
// The whole frame is pointer-transparent EXCEPT the chip, so it can be layered ABOVE
// the story viewer's tap surface: taps on the media still advance/pause the story,
// only the chip captures.

type RepostPost = {
  type: string;
  media_url: string | null;
  cover_url: string | null;
  thumbnail_url: string | null;
  aspect_ratio: string | null;
  username: string | null;
  avatar_url: string | null;
};

const cache = new Map<string, RepostPost | null>();

export default function RepostStoryFrame({ postId, aspectRatio, onOpenPost, children }: {
  postId: string;
  // The story already carries the post's aspect, so the card is sized right on the
  // first frame without waiting for the fetch.
  aspectRatio?: string | null;
  onOpenPost?: () => void;
  children: React.ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { width: W, height: H } = useWindowDimensions();
  const [post, setPost] = useState<RepostPost | null | undefined>(cache.has(postId) ? cache.get(postId) : undefined);

  useEffect(() => {
    let alive = true;
    if (cache.has(postId)) { setPost(cache.get(postId)); return; }
    supabase
      .from('posts')
      .select('type, media_url, cover_url, thumbnail_url, aspect_ratio, profiles!posts_user_id_fkey(username, avatar_url)')
      .eq('id', postId)
      .single()
      .then(({ data }) => {
        const d = data as any;
        const prof = d ? (Array.isArray(d.profiles) ? d.profiles[0] : d.profiles) : null;
        const v: RepostPost | null = d ? { ...d, username: prof?.username ?? null, avatar_url: prof?.avatar_url ?? null } : null;
        cache.set(postId, v);
        if (alive) setPost(v);
      }, () => {});
    return () => { alive = false; };
  }, [postId]);

  const aspect = aspectToNumber(aspectRatio ?? post?.aspect_ratio, 9 / 16);
  const backdrop = post?.thumbnail_url ?? post?.cover_url ?? (post?.type === 'image' ? post?.media_url : null);

  // Fit the card within the screen, minus the story chrome (progress bar up top,
  // reply pill at the bottom), at the post's own aspect.
  const boxW = W - SPACING.md * 2;
  const boxH = H - (insets.top + 72) - (insets.bottom + 104);
  let cardW = boxW;
  let cardH = cardW / aspect;
  if (cardH > boxH) { cardH = boxH; cardW = cardH * aspect; }

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {backdrop ? (
        <ExpoImage source={{ uri: backdrop }} style={StyleSheet.absoluteFill} contentFit="cover" blurRadius={30} cachePolicy="memory-disk" pointerEvents="none" />
      ) : (
        <LinearGradient colors={['#1b1b1d', '#000']} style={StyleSheet.absoluteFill} pointerEvents="none" />
      )}
      <View style={styles.scrim} pointerEvents="none" />
      <View style={styles.center} pointerEvents="box-none">
        <View style={[styles.card, { width: cardW, height: cardH }]} pointerEvents="box-none">
          <View style={StyleSheet.absoluteFill} pointerEvents="none">{children}</View>
          <TouchableOpacity style={styles.chip} activeOpacity={0.85} hitSlop={8} onPress={onOpenPost}>
            {post?.avatar_url ? (
              <ExpoImage source={{ uri: post.avatar_url }} style={styles.chipAvatar} contentFit="cover" cachePolicy="memory-disk" />
            ) : (
              <LinearGradient colors={GRADIENTS.avatar} style={styles.chipAvatar} />
            )}
            <Text style={styles.chipName} numberOfLines={1}>@{post?.username ?? 'laybell'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const makeStyles = (_c: ThemePalette) => StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  card: {
    borderRadius: RADIUS.xl, overflow: 'hidden', backgroundColor: '#000',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 18, shadowOffset: { width: 0, height: 8 },
  },
  chip: {
    position: 'absolute', top: SPACING.sm, left: SPACING.sm,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 999, padding: 4, paddingRight: 10,
  },
  chipAvatar: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#333' },
  chipName: { color: '#fff', fontSize: 13, fontWeight: '700', maxWidth: 160 },
});
