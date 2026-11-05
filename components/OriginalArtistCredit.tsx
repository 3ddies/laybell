import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { supabase } from '../lib/supabase';

// Top-right "original artist" credit for a DJ-Booth edit of SOMEONE ELSE'S track.
// Shows the original artist's avatar + @username (+ the track title) on the big audio
// displays — the home square song card and the full Now Playing view. Renders nothing
// unless the post actually credits a different artist via its song_* columns, so it is
// safe to drop onto any audio surface.
//
// Tapping it deep-links to that artist's profile with the Music tab open and the original
// track flagged (`song` param), so it's right there to play — and highlighted inside its
// album when the track belongs to one.
//
// Two ways to feed it, so it works with or without the song_* data already in hand:
//   • artistId (+ songId/songTitle): the caller already knows it's a cross-artist credit
//     (the feed row carries song_artist_id) — skips the first query.
//   • postId: looks up song_artist_id / song_id / song_title / user_id itself (Now Playing
//     only holds the track, not its post row).
export default function OriginalArtistCredit({ postId, artistId: seedArtistId, songId: seedSongId, songTitle: seedTitle, onNavigate, style }: {
  postId?: string;
  artistId?: string | null;
  songId?: string | null;
  songTitle?: string | null;
  /** Host (Now Playing) closes itself before the profile pushes on top. */
  onNavigate?: () => void;
  style?: any;
}) {
  const router = useRouter();
  const [info, setInfo] = useState<{ id: string; username: string; avatar: string | null; title: string; songId: string | null } | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        let artistId: string | null | undefined = seedArtistId;
        let title = seedTitle ?? '';
        let songId = seedSongId ?? null;
        // No seed → resolve the song_* columns from the post row (Now Playing path).
        if (seedArtistId === undefined && postId) {
          const { data } = await supabase.from('posts')
            .select('user_id, song_id, song_artist_id, song_artist, song_title').eq('id', postId).maybeSingle();
          const d = data as any;
          if (!d || !d.song_artist_id || d.song_artist_id === d.user_id) { if (alive) setInfo(null); return; }
          artistId = d.song_artist_id;
          title = d.song_title ?? '';
          songId = d.song_id ?? null;
        }
        if (!artistId) { if (alive) setInfo(null); return; }
        const { data: p } = await supabase.from('profiles')
          .select('username, display_name, avatar_url, hidden').eq('id', artistId).maybeSingle();
        const pr = p as any;
        if (!alive) return;
        if (!pr || pr.hidden) { setInfo(null); return; } // never surface a hidden account
        setInfo({ id: artistId, username: pr.username || pr.display_name || '', avatar: pr.avatar_url ?? null, title, songId });
      } catch { if (alive) setInfo(null); }
    })();
    return () => { alive = false; };
  }, [postId, seedArtistId, seedSongId, seedTitle]);

  if (!info) return null;

  const open = () => {
    onNavigate?.();
    // Land on the artist's profile, Music tab, with the original track flagged so it's
    // ready to play (and highlighted in its album when it belongs to one).
    router.push({
      pathname: '/profile/[id]',
      params: { id: info.id, tab: 'music', ...(info.songId ? { song: info.songId } : {}) },
    });
  };

  return (
    <Pressable style={[styles.wrap, style]} onPress={open} hitSlop={6} accessibilityRole="button" accessibilityLabel={`Original artist @${info.username}`}>
      <Text style={styles.tag}>ORIGINAL</Text>
      {info.avatar ? (
        <ExpoImage source={{ uri: info.avatar }} style={styles.avatar} contentFit="cover" cachePolicy="memory-disk" />
      ) : (
        <View style={[styles.avatar, styles.avatarFallback]}>
          <Text style={styles.avatarInitial}>{(info.username || '?').charAt(0).toUpperCase()}</Text>
        </View>
      )}
      {!!info.username && <Text style={styles.name} numberOfLines={1}>@{info.username}</Text>}
      {!!info.title && <Text style={styles.track} numberOfLines={1}>{info.title}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', maxWidth: 108 },
  tag: {
    color: 'rgba(255,255,255,0.85)', fontSize: 8.5, fontWeight: '800', letterSpacing: 1.2,
    marginBottom: 3, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 3,
  },
  avatar: {
    width: 40, height: 40, borderRadius: 20,
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.9)', backgroundColor: 'rgba(255,255,255,0.14)',
  },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarInitial: { color: '#fff', fontSize: 16, fontWeight: '800' },
  name: {
    color: '#fff', fontSize: 11.5, fontWeight: '800', marginTop: 3, maxWidth: 108, textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 3,
  },
  track: {
    color: 'rgba(255,255,255,0.82)', fontSize: 10, marginTop: 1, maxWidth: 108, textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 3,
  },
});
