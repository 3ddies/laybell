import { useEffect, useState } from 'react';
import { View, StyleSheet, useWindowDimensions } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabase';
import { aspectToNumber } from '../lib/aspectRatio';
import { SPACING, type ThemePalette } from '../constants/theme';
import { useThemedStyles } from '../contexts/ThemeContext';
import RepostCard from './RepostCard';

// The Instagram-style frame for a post reshared to a story WITHOUT the full editor (no saved post
// layer): the post's still sits blurred edge-to-edge behind, and the post itself (the `children` —
// a playing video or a still) fills the SHARED RepostCard (same rounded card + @handle below as the
// editor and the composed viewer, so every reshared post looks the same). Tapping the card opens the
// original; taps outside it still advance/pause the story (the frame is otherwise pointer-transparent).

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

export default function RepostStoryFrame({ postId, aspectRatio, onCardPress, revealed, onViewPost, children }: {
  postId: string;
  // The story already carries the post's aspect, so the card is sized right on the
  // first frame without waiting for the fetch.
  aspectRatio?: string | null;
  onCardPress?: () => void;   // tap the card → reveal / dismiss the "View Post" button
  revealed?: boolean;         // show the "View Post" button
  onViewPost?: () => void;    // tap the button → open the original post
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
        <RepostCard
          cardW={cardW}
          cardH={cardH}
          username={post?.username}
          onPress={onCardPress}
          revealed={revealed}
          onViewPost={onViewPost}
        >
          {children}
        </RepostCard>
      </View>
    </View>
  );
}

const makeStyles = (_c: ThemePalette) => StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
});
