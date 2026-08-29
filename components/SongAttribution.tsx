import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, Easing } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { useAudio } from '../contexts/AudioContext';
import { usePostMusicActions } from '../contexts/PostMusicContext';
import { usePostOptions } from '../contexts/PostOptionsContext';
import { useProfile } from '../contexts/ProfileContext';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

// Bottom-right "this post uses <song>" credit on image/video posts and stories.
// Song name (bold, on top) → plays the track · artist (smaller, beneath) → their
// profile · ⋮ → the song's 3-dot menu. The size order follows the action order:
// hearing the song is the point of the card, so it leads.
//
// Music-video posts (posts.song_link_only) render this identically and tap the
// same way. That flag only stops the track auto-playing OVER the post — the
// video already carries it — and is enforced by songPlaysFor() at the read
// sites, never here.
//
// The host (e.g. post/reel/story viewer) can pass onNavigate to
// dismiss itself when the SONG is played (so the full player, which renders
// behind the host, surfaces in front). It is intentionally NOT used when opening
// the artist profile — that just pushes on top. onPauseHost pauses while the menu
// is open.
export default function SongAttribution({
  songId, title, artist, artistId, style, inline = false, onNavigate, onPauseHost, onResumeHost,
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
  // Fired when the song's 3-dot menu closes — a host paused via onPauseHost
  // resumes from where it left off.
  onResumeHost?: () => void;
}) {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { play, expand, currentTrack, isPlaying } = useAudio();
  const { stop: stopPostMusic } = usePostMusicActions();
  const { show } = usePostOptions();
  const { profile } = useProfile();
  const busyRef = useRef(false); // guards against rapid re-taps piling up audio loads

  // ── Artwork mode ────────────────────────────────────────────────────────────
  // While THIS post's song is the one actually playing, the corner blooms from a
  // pill into the real cover art with the title and artist under it, and settles
  // back when it stops. The point is exposure: a song being heard right now gets
  // the artist's artwork on screen instead of six words of truncated text.
  //
  // The cover costs no extra fetch — playSong already puts cover_url on the
  // track, so whenever this song is `currentTrack` the art is in hand. If the
  // track genuinely has no cover there is nothing to bloom into, so it stays a
  // pill rather than showing an empty box.
  //
  // FLOATING ONLY. Reels and stories render this `inline`, inside real layout,
  // where a 72pt card would shove their captions around. The corner variant is
  // absolutely positioned and owns its space, which is what makes the two states
  // safe to cross-fade in place.
  const isThisTrack = currentTrack?.id === songId;

  // Remembered, not read live. Once this post's song has played we keep its cover
  // for the life of the component — see the mount note below for why that
  // matters more than it looks.
  const coverRef = useRef<string | null>(null);
  if (isThisTrack && currentTrack?.cover) coverRef.current = currentTrack.cover;
  const cover = coverRef.current;

  // The bloom waits for the ARTWORK ITSELF to be decoded.
  //
  // "Sometimes the animation starts and then quickly freezes, and then resumes."
  // The opacity is native-driven and cannot stall — what stalls is the picture.
  // The card mounts the instant the song starts, so the fade and the image fetch
  // were racing: the fade opened on an empty box and the artwork popped in
  // partway through, which reads exactly like a freeze in the middle of it.
  //
  // Gating on onLoad means the animation never begins until it can finish
  // smoothly, which is the rule the owner asked for. It costs nothing after the
  // first play: the card no longer unmounts, so the image stays decoded and every
  // later bloom starts already-ready.
  const [artReady, setArtReady] = useState(false);
  const showArt = !inline && isThisTrack && isPlaying && !!cover && artReady;

  // ONCE MOUNTED, NEVER UNMOUNTED. This is the whole fix for the hitch, and it
  // took two goes to get right.
  //
  // v1 unmounted in the fade-out's completion callback. That is a setState —
  // a React re-render plus a view teardown — landing at the exact instant the
  // animation ends. Invisible on a still post; a dropped frame every time on one
  // with a video decoding, which is precisely what the owner saw.
  //
  // v2 keyed the mount on isThisTrack. That fixed PAUSE but not STOP: stopping
  // clears currentTrack, so showArt and the mount both went false in the same
  // commit — the card vanished with no fade at all, and the teardown still landed
  // next to the transition.
  //
  // So the mount is keyed on nothing but "has this song ever played here",
  // remembered in coverRef. The card fades to opacity 0 and simply stays, which
  // means there is no React work anywhere in the transition, at either end, for
  // pause or stop. The fade the owner likes is untouched; only its ending moved.
  //
  // The cost is one <Image> held at opacity 0 — and only on a post whose song has
  // actually been played, which is one post at a time, not one per feed row.
  const mountArt = !inline && !!cover;

  const bloom = useRef(new Animated.Value(0)).current;
  // No reset needed: mountArt no longer flips while a fade is running,
  // so bloom is only ever driven by the animation below and always lands at 0
  // before the card is idle.
  useEffect(() => {
    Animated.timing(bloom, {
      toValue: showArt ? 1 : 0,
      duration: showArt ? 260 : 220,
      easing: showArt ? Easing.out(Easing.cubic) : Easing.in(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [showArt, bloom]);

  // The pill fades out as the card fades in, so the two never both read as solid.
  // Guarded on mountArt: when the track changes away the card unmounts in the
  // same commit, and an un-reset bloom would otherwise leave the pill invisible.
  const pillOpacity = bloom.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  const artScale = bloom.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] });

  function openArtist() {
    if (!artistId) return;
    // NOTE: do NOT call onNavigate() here. The profile is a normal screen that
    // pushes on top of the host (post/reel/story) — the host doesn't need to close.
    // onNavigate dismisses the host via an animated router.back() that fires AFTER
    // a delay, so it would pop the profile we just pushed and freeze the app.
    router.push(`/profile/${artistId}`);
  }

  async function playSong() {
    // Music videos take this SAME path. Link-only governs whether the track
    // plays BY ITSELF over the post — it never should, the video already
    // carries it — but a deliberate tap means "take me to this song", and the
    // answer to that is the real player, exactly as on any other card. The host
    // viewer closes on the way (onNavigate), so the video isn't left playing
    // underneath the track it's a video of.
    //
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
      onDismiss: onResumeHost,
    });
  }

  return (
    <>
      {mountArt && (
        <Animated.View
          style={[styles.artCard, style, { opacity: bloom, transform: [{ scale: artScale }] }]}
          // While the pill is still fading it must not eat taps meant for the
          // card, and vice versa — whichever is arriving owns the touches.
          pointerEvents={showArt ? 'auto' : 'none'}
        >
          <TouchableOpacity onPress={playSong} activeOpacity={0.85}>
            <Image
              source={{ uri: cover! }}
              style={styles.artImage}
              contentFit="cover"
              // transition={0}: expo-image's own cross-fade would run INSIDE the
              // bloom, so the artwork faded while the card was also fading.
              // One fade per element - the bloom owns it.
              transition={0}
              onLoad={() => setArtReady(true)}
            />
          </TouchableOpacity>
          <TouchableOpacity onPress={openOptions} style={styles.artDots} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('a11y.moreOptions')}>
            <Ionicons name="ellipsis-horizontal" size={14} color="#fff" />
          </TouchableOpacity>
          {/* Title then artist, mirroring the pill's order and for the same
              reason: hearing the song is the point, the profile is secondary. */}
          <TouchableOpacity onPress={playSong} hitSlop={{ top: 4, bottom: 2, left: 6, right: 6 }}>
            <Text style={styles.artTitle} numberOfLines={1}>{title || t('songAttr.audioTrack')}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={openArtist} hitSlop={{ top: 2, bottom: 4, left: 6, right: 6 }} disabled={!artistId}>
            <Text style={styles.artArtist} numberOfLines={1}>{artist || t('songAttr.unknownArtist')}</Text>
          </TouchableOpacity>
        </Animated.View>
      )}
      <Animated.View
        style={[
          styles.base, inline ? styles.inline : styles.floating, style,
          !inline && { opacity: mountArt ? pillOpacity : 1 },
        ]}
        pointerEvents={showArt ? 'none' : 'auto'}
      >
      <Ionicons name="musical-notes" size={13} color="#fff" style={styles.note} />
      <View style={[styles.textCol, inline && styles.textColInline]}>
        {/* Song FIRST and larger. Playing the track is what this card is for;
            the artist's profile is the secondary path. With the artist on top in
            heavier type, the eye landed on the smaller, lighter line for the
            primary action. */}
        <TouchableOpacity onPress={playSong} hitSlop={{ top: 6, bottom: 2, left: 6, right: 6 }}>
          <Text style={styles.song} numberOfLines={1}>{title || t('songAttr.audioTrack')}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={openArtist} hitSlop={{ top: 2, bottom: 6, left: 6, right: 6 }} disabled={!artistId}>
          <Text style={styles.artist} numberOfLines={1}>{artist || t('songAttr.unknownArtist')}</Text>
        </TouchableOpacity>
      </View>
      <TouchableOpacity onPress={openOptions} style={styles.dots} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel={t('a11y.moreOptions')}>
        <Ionicons name="ellipsis-horizontal" size={18} color="#fff" />
      </TouchableOpacity>
      </Animated.View>
    </>
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
  // Weight and size now follow the actions: the song leads, the artist recedes.
  song: { color: '#fff', fontSize: 13, fontWeight: '800', letterSpacing: -0.2, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 3 },
  artist: { color: 'rgba(255,255,255,0.82)', fontSize: 11, fontWeight: '600', textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 3, marginTop: 1 },
  dots: { paddingLeft: 2 },

  // ── Artwork card (playing state) ────────────────────────────────────────────
  // Same anchor as the pill it replaces, so the corner does not jump when they
  // swap. Sized to sit under a caption rather than compete with the post: 76pt
  // of art is enough to recognise an album at a glance and no more.
  artCard: {
    position: 'absolute', right: SPACING.sm, bottom: SPACING.sm,
    alignItems: 'flex-end',
    // Its own scrim, a shade stronger than the pill's — text sits directly under
    // artwork here rather than on a single dark bar, so it needs the extra help
    // on a bright cover.
    backgroundColor: 'rgba(0,0,0,0.42)',
    borderRadius: RADIUS.md, padding: 6, gap: 1,
  },
  artImage: { width: 76, height: 76, borderRadius: RADIUS.sm, backgroundColor: 'rgba(255,255,255,0.08)' },
  // Sits ON the art, top-right, so the menu stays reachable without widening the
  // card or pushing the text down.
  artDots: {
    position: 'absolute', top: 8, right: 8,
    width: 24, height: 24, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  artTitle: {
    color: '#fff', fontSize: 12, fontWeight: '800', letterSpacing: -0.2, maxWidth: 76,
    marginTop: 4, textAlign: 'right',
  },
  artArtist: { color: 'rgba(255,255,255,0.82)', fontSize: 10.5, fontWeight: '600', maxWidth: 76, textAlign: 'right' },
});
