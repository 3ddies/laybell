import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AppVideo from '../../../components/AppVideo';
import RepostStoryFrame from '../../../components/RepostStoryFrame';
import { supabase } from '../../../lib/supabase';
import { createStoryFromPost } from '../../../lib/stories';
import { useProfile } from '../../../contexts/ProfileContext';
import { useStories } from '../../../contexts/StoriesContext';
import { useAudioControls } from '../../../contexts/AudioContext';
import { useTranslation } from '../../../contexts/LanguageContext';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../../../constants/theme';
import { useThemedStyles } from '../../../contexts/ThemeContext';

// "Post to story" PREVIEW (Instagram-style): before it posts, you see exactly how the
// reshared post will look in your story — its own orientation, and for a video it
// PLAYS with audio — then tap "Share to your story". Uses the SAME RepostStoryFrame
// the viewer draws, so the preview matches the result.
export default function RepostPreviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>(); // the post being reshared
  const router = useRouter();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { profile } = useProfile();
  const { refresh } = useStories();
  const { pause: pauseMusic } = useAudioControls();
  const [post, setPost] = useState<any | null | undefined>(undefined);
  const [sharing, setSharing] = useState(false);

  // Stop the user's music so the reshared video's own audio is what plays here
  // (audio-session-hazard: pause, never stop).
  useEffect(() => { pauseMusic(); }, [pauseMusic]);

  useEffect(() => {
    let alive = true;
    supabase
      .from('posts')
      .select('type, media_url, thumbnail_url, cover_url, aspect_ratio')
      .eq('id', id)
      .single()
      .then(({ data }) => { if (alive) setPost(data ?? null); }, () => { if (alive) setPost(null); });
    return () => { alive = false; };
  }, [id]);

  async function share() {
    if (!profile?.id || sharing) return;
    setSharing(true);
    try {
      await createStoryFromPost(profile.id, id);
      refresh(); // the Home story ring updates to show the new story
      router.back();
    } catch {
      setSharing(false);
      Alert.alert(t('common.error'), t('postOptions.postToStoryFailed'));
    }
  }

  return (
    <View style={styles.container}>
      {post === undefined ? (
        <View style={styles.center}><ActivityIndicator color="#fff" /></View>
      ) : post === null ? (
        <View style={styles.center}><Text style={styles.err}>{t('sharedCard.unavailable')}</Text></View>
      ) : (
        <RepostStoryFrame postId={id} aspectRatio={post.aspect_ratio}>
          {post.type === 'video' ? (
            <AppVideo source={{ uri: post.media_url }} style={StyleSheet.absoluteFill} contentFit="cover" active={isFocused} loop ownsAudio poster={post.thumbnail_url} />
          ) : (
            <ExpoImage source={{ uri: post.cover_url ?? post.thumbnail_url ?? post.media_url }} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory-disk" />
          )}
        </RepostStoryFrame>
      )}

      {/* Close */}
      <TouchableOpacity style={[styles.close, { top: insets.top + SPACING.sm }]} onPress={() => router.back()} hitSlop={12} accessibilityLabel={t('a11y.back')}>
        <Ionicons name="close" size={28} color="#fff" />
      </TouchableOpacity>

      {/* Share to your story */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + SPACING.md }]} pointerEvents="box-none">
        <TouchableOpacity style={styles.shareBtn} onPress={share} disabled={sharing} activeOpacity={0.85}>
          <LinearGradient colors={GRADIENTS.primary} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.shareFill}>
            {sharing ? <ActivityIndicator color="#fff" /> : (
              <>
                <Ionicons name="add-circle" size={20} color="#fff" />
                <Text style={styles.shareText}>{t('repost.shareToStory')}</Text>
              </>
            )}
          </LinearGradient>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  err: { color: 'rgba(255,255,255,0.7)', fontSize: 15 },
  close: {
    position: 'absolute', left: SPACING.md, width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.35)',
  },
  footer: { position: 'absolute', left: SPACING.md, right: SPACING.md, bottom: 0, paddingTop: SPACING.sm },
  shareBtn: { borderRadius: RADIUS.full, overflow: 'hidden' },
  shareFill: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, paddingVertical: SPACING.md },
  shareText: { color: '#fff', fontSize: 16, fontWeight: '800' },
});
