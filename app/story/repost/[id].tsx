import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import StoryEditor, { type StoryEditorPost, type StoryEditorResult } from '../../../components/StoryEditor';
import { supabase } from '../../../lib/supabase';
import { createStoryRepost, uploadStickerPhotos } from '../../../lib/stories';
import { useProfile } from '../../../contexts/ProfileContext';
import { useStories } from '../../../contexts/StoriesContext';
import { useTranslation } from '../../../contexts/LanguageContext';
import { SPACING, type ThemePalette } from '../../../constants/theme';
import { useThemedStyles } from '../../../contexts/ThemeContext';

// "Post to story" — reshare any post to your 24h story. This screen only LOADS the
// reshared post and hands it to the shared <StoryEditor> (the exact same editor the
// live story camera uses); the post rides as the editor's media. On share it writes
// the stories.shared_post_id + stickers jsonb via createStoryRepost.
export default function RepostEditorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>(); // the post being reshared
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { profile } = useProfile();
  const { refresh } = useStories();

  const [post, setPost] = useState<StoryEditorPost | null | undefined>(undefined);
  const [sharing, setSharing] = useState(false);

  useEffect(() => {
    let alive = true;
    supabase
      .from('posts')
      .select('type, media_url, thumbnail_url, cover_url, aspect_ratio, duration_seconds, profiles!posts_user_id_fkey(username, avatar_url)')
      .eq('id', id)
      .single()
      .then(({ data }) => {
        if (!alive) return;
        const d = data as any;
        if (!d) { setPost(null); return; }
        const prof = Array.isArray(d.profiles) ? d.profiles[0] : d.profiles;
        setPost({ ...d, username: prof?.username ?? null, avatar_url: prof?.avatar_url ?? null });
      }, () => { if (alive) setPost(null); });
    return () => { alive = false; };
  }, [id]);

  async function handleShare(result: StoryEditorResult) {
    if (!profile?.id || sharing || !post) return;
    setSharing(true);
    try {
      // Host any local photo-sticker images before the jsonb is written (GIFs, covers,
      // etc. are already remote URLs and pass through untouched).
      const hosted = await uploadStickerPhotos(profile.id, result.stickers);
      await createStoryRepost({
        userId: profile.id,
        postId: id,
        post,
        layers: hosted ?? result.stickers,
        caption: result.caption,
        song: result.song,
        songStartSec: result.songStartSec,
        songClipSec: result.songClipSec,
      });
      refresh();
      router.back();
    } catch {
      setSharing(false);
      Alert.alert(t('common.error'), t('postOptions.postToStoryFailed'));
    }
  }

  if (post === undefined) {
    return <View style={styles.container}><View style={styles.center}><ActivityIndicator color="#fff" /></View></View>;
  }
  if (post === null) {
    return (
      <View style={styles.container}>
        <View style={styles.center}><Text style={styles.err}>{t('sharedCard.unavailable')}</Text></View>
        <TouchableOpacity style={[styles.roundBtn, { position: 'absolute', top: insets.top + 8, left: SPACING.md }]} onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="close" size={26} color="#fff" />
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <StoryEditor
      media={{ kind: 'post', post }}
      onClose={() => router.back()}
      onShare={handleShare}
      sharing={sharing}
    />
  );
}

const makeStyles = (_colors: ThemePalette) => StyleSheet.create({
  container: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  err: { color: 'rgba(255,255,255,0.7)', fontSize: 15 },
  roundBtn: {
    width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.18)',
  },
});
