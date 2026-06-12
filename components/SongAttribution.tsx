import { useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { useAudio } from '../contexts/AudioContext';
import { usePostMusic } from '../contexts/PostMusicContext';
import { usePostOptions } from '../contexts/PostOptionsContext';
import { useProfile } from '../contexts/ProfileContext';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';

// Bottom-right "this post uses <song>" credit on image/video posts and stories.
// Artist (bold) → artist profile · song name → plays the track · ⋮ → the song's
// 3-dot menu. The host (e.g. post/reel/story viewer) can pass onNavigate to
// dismiss itself when the SONG is played (so the full player, which renders
// behind the host, surfaces in front). It is intentionally NOT used when opening
// the artist profile — that just pushes on top. onPauseHost pauses while the menu
// is open.
export default function SongAttribution({
  songId, title, artist, artistId, style, inline = false, onNavigate, onPauseHost,
}: {
  songId: string;
  title?: string | null;
  artist?: string | null;
  artistId?: string | null;
  style?: any;
  // inline = flows in normal layout (left-aligned) instead of floating bottom-right.
  inline?: boolean;
  onNavigate?: () => void;
  onPauseHost?: () => void;
}) {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { play, expand, currentTrack } = useAudio();
  const { stop: stopPostMusic } = usePostMusic();
  const { show } = usePostOptions();
  const { profile } = useProfile();
  const busyRef = useRef(false); // guards against rapid re-taps piling up audio loads

  function openArtist() {
    if (!artistId) return;
    // NOTE: do NOT call onNavigate() here. The profile is a normal screen that
    // pushes on top of the host (post/reel/story) — the host doesn't need to close.
    // onNavigate dismisses the host via an animated router.back() that fires AFTER
    // a delay, so it would pop the profile we just pushed and freeze the app.
    router.push(`/profile/${artistId}`);
  }

  async function playSong() {
    // Already this track? Just resurface the player — never refetch/reload. The
    // reload churn from rapid taps (createAsync/unloadAsync) is what froze the app
    // on screens where the player opens behind the post.
    if (currentTrack?.id === songId) {
      onNavigate?.();
      expand();
      return;
    }
    if (busyRef.current) return; // a previous tap is still loading — ignore
    busyRef.current = true;
    try {
      onNavigate?.(); // close the host (post/reel/story) so the root player shows in front
      stopPostMusic(); // promote from ambient to the main mini-player
      const { data } = await supabase
        .from('posts')
        .select('id, media_url, caption, cover_url, profiles!posts_user_id_fkey(display_name)')
        .eq('id', songId)
        .single();
      if (data) {
        const d: any = data;
        play({ id: d.id, uri: d.media_url, caption: d.caption, artist: d.profiles?.display_name ?? artist ?? '', cover: d.cover_url });
        expand();
      }
    } finally {
      busyRef.current = false;
    }
  }

  function openOptions() {
    onPauseHost?.();
    show({
      postId: songId,
      isOwn: !!artistId && artistId === profile?.id,
      authorId: artistId ?? undefined,
      authorName: artist ?? undefined,
      mediaType: 'audio',
      onNavigate,
    });
  }

  return (
    <View style={[styles.base, inline ? styles.inline : styles.floating, style]}>
      <Ionicons name="musical-notes" size={13} color="#fff" style={styles.note} />
      <View style={[styles.textCol, inline && styles.textColInline]}>
        <TouchableOpacity onPress={openArtist} hitSlop={{ top: 6, bottom: 2, left: 6, right: 6 }} disabled={!artistId}>
          <Text style={styles.artist} numberOfLines={1}>{artist || 'Unknown artist'}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={playSong} hitSlop={{ top: 2, bottom: 6, left: 6, right: 6 }}>
          <Text style={styles.song} numberOfLines={1}>{title || 'Audio track'}</Text>
        </TouchableOpacity>
      </View>
      <TouchableOpacity onPress={openOptions} style={styles.dots} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <Ionicons name="ellipsis-horizontal" size={18} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  base: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(0,0,0,0.32)', borderRadius: RADIUS.full,
    paddingVertical: 5, paddingHorizontal: SPACING.sm,
  },
  floating: { position: 'absolute', right: SPACING.sm, bottom: SPACING.sm, maxWidth: '70%' },
  inline: { alignSelf: 'flex-start', maxWidth: '100%' },
  note: { textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 3 },
  textCol: { flexShrink: 1, alignItems: 'flex-end' },
  textColInline: { alignItems: 'flex-start' },
  artist: { color: '#fff', fontSize: 12, fontWeight: '800', textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 3 },
  song: { color: '#fff', fontSize: 11, fontWeight: '500', textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 3, marginTop: 1 },
  dots: { paddingLeft: 2 },
});
