import { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Animated, Easing, AccessibilityInfo,
  TouchableOpacity, useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS, SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import StoryAvatar from './StoryAvatar';
import { titleWithoutTrailingArtist } from '../lib/postSong';

/**
 * The chart, as one big square that cycles — the top songs on Laybell right now,
 * at the head of the Music tab.
 *
 * WHERE THE RANKING COMES FROM. It does not have one. It renders the first few
 * of `tracks`, which the Music tab already fetched for the Top 20 chart
 * (fetchTop20: most-streamed public audio, app-wide, blocked accounts removed).
 * A second query ordered a second way would eventually disagree with the chart
 * sitting further down the same screen, and then one of them would be lying.
 *
 * Cycling is a crossfade, not a slide: the cover is the largest thing on the
 * screen and sliding it drags the eye sideways every few seconds while someone
 * is trying to read the list below. A fade changes what is there without asking
 * for attention.
 */

/** How long each song holds before the next fades in. */
const HOLD_MS = 5200;
const FADE_MS = 620;

/** The play button's diameter. Shared, because the title's right padding is
 *  derived from it — hard-coding both is how they drift apart and collide. */
const PLAY_SIZE = 52;

export type SpotlightTrack = {
  id: string;
  caption?: string | null;
  cover_url?: string | null;
  profiles?: { id?: string; username?: string; display_name?: string; avatar_url?: string | null } | null;
};

type Props = {
  tracks: SpotlightTrack[];
  /** Play the chart starting at this index, so it runs on into the Top 20. */
  onPlay: (index: number) => void;
  onOpenPost: (postId: string) => void;
  onOpenProfile: (userId: string) => void;
  /** How many to cycle through. */
  count?: number;
};

export default function TopSongsSpotlight({
  tracks, onPlay, onOpenPost, onOpenProfile, count = 5,
}: Props) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { width } = useWindowDimensions();

  const top = tracks.slice(0, count);
  const [i, setI] = useState(0);
  const fade = useRef(new Animated.Value(1)).current;
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (on) => setReduceMotion(!!on));
    return () => sub?.remove?.();
  }, []);

  // Reset when the chart itself changes, so a refresh does not leave the index
  // pointing past the end of a shorter list.
  useEffect(() => { setI(0); }, [top.length]);

  useEffect(() => {
    if (top.length < 2) return;      // nothing to cycle between
    let cancelled = false;

    // Reduced motion: still cycle — the content is the point — but cut, do not
    // fade. A hard swap is honest about being a change; a slow fade is the
    // animation someone asked not to see.
    if (reduceMotion) {
      const id = setInterval(() => { if (!cancelled) setI((n) => (n + 1) % top.length); }, HOLD_MS);
      return () => { cancelled = true; clearInterval(id); };
    }

    const id = setInterval(() => {
      Animated.timing(fade, {
        toValue: 0, duration: FADE_MS / 2, easing: Easing.out(Easing.quad), useNativeDriver: true,
      }).start(({ finished }) => {
        if (!finished || cancelled) return;
        setI((n) => (n + 1) % top.length);
        Animated.timing(fade, {
          toValue: 1, duration: FADE_MS / 2, easing: Easing.in(Easing.quad), useNativeDriver: true,
        }).start();
      });
    }, HOLD_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [top.length, reduceMotion, fade]);

  if (top.length === 0) return null;

  const cur = top[Math.min(i, top.length - 1)];
  const who = cur.profiles;
  const name = who?.display_name || who?.username || '';
  // draft.untitledTrack rather than a new key — the app already has this string
  // in ten languages and a second one would only be a second thing to translate.
  //
  // The byline right above already shows the artist, so a title ending in their
  // name says it twice in one glance ("3ddie" over "Laybell Official Song -
  // 3ddie"). Same rule the feed card uses, applied to the half that can give.
  const raw = (cur.caption ?? '').trim();
  const title = titleWithoutTrailingArtist(raw, name) || t('draft.untitledTrack');
  // Square, edge-inset to match the rails below it.
  const size = width - SPACING.md * 2;

  return (
    <View style={styles.wrap}>
      <Text style={styles.heading}>{t('music.topOnLaybell')}</Text>

      <TouchableOpacity
        activeOpacity={0.92}
        onPress={() => onOpenPost(cur.id)}
        style={[styles.card, { width: size, height: size }]}
      >
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: fade }]}>
          {cur.cover_url ? (
            <Image
              source={{ uri: cur.cover_url }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              // The cover changes every few seconds; a transition here on top of
              // the crossfade would be two fades fighting.
              transition={0}
            />
          ) : (
            <View style={[StyleSheet.absoluteFill, styles.noCover]}>
              <Ionicons name="musical-notes" size={56} color={COLORS.textTertiary} />
            </View>
          )}

          {/* Bottom scrim: the title sits on artwork nobody chose, so it needs
              its own contrast rather than hoping the image is dark down there. */}
          <LinearGradient
            colors={['transparent', 'rgba(0,0,0,0.35)', 'rgba(0,0,0,0.88)']}
            locations={[0.45, 0.7, 1]}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />

          <View style={styles.info}>
            <TouchableOpacity
              style={styles.byline}
              activeOpacity={0.8}
              onPress={() => who?.id && onOpenProfile(who.id)}
            >
              <StoryAvatar userId={who?.id} avatarUrl={who?.avatar_url} name={name} size={30} />
              <Text style={styles.artist} numberOfLines={1}>{name}</Text>
            </TouchableOpacity>
            <Text style={styles.title} numberOfLines={2}>{title}</Text>
          </View>
        </Animated.View>

        {/* OUTSIDE the fading layer: rank and play stay put while the artwork
            changes underneath, so the control never blinks out from under a
            thumb that is reaching for it. */}
        <View style={styles.rank}>
          <Text style={styles.rankText}>{`#${Math.min(i, top.length - 1) + 1}`}</Text>
        </View>
        <TouchableOpacity
          style={styles.play}
          activeOpacity={0.85}
          onPress={() => onPlay(Math.min(i, top.length - 1))}
          hitSlop={8}
        >
          <Ionicons name="play" size={24} color="#000" style={{ marginLeft: 3 }} />
        </TouchableOpacity>
      </TouchableOpacity>

      {/* Which of the five, and a way to jump straight to one. */}
      {top.length > 1 && (
        <View style={styles.dots}>
          {top.map((tr, n) => (
            <TouchableOpacity
              key={tr.id}
              onPress={() => { fade.setValue(1); setI(n); }}
              hitSlop={10}
              style={[styles.dot, n === i && styles.dotOn]}
            />
          ))}
        </View>
      )}
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  wrap: { marginBottom: SPACING.md },
  heading: {
    color: colors.text, fontSize: 20, fontWeight: '800',
    marginHorizontal: SPACING.md, marginBottom: SPACING.sm,
  },
  card: {
    alignSelf: 'center', borderRadius: RADIUS.xl, overflow: 'hidden',
    backgroundColor: colors.surfaceLight,
  },
  noCover: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceLight },
  // paddingRight CLEARS THE PLAY BUTTON. The button is 48 wide inset SPACING.md,
  // so it owns the last 64pt of the card; without this the title simply runs
  // underneath it — not clipped, occluded, which is worse because the text looks
  // truncated at a place no line-break would choose.
  info: {
    position: 'absolute', left: SPACING.md, right: SPACING.md, bottom: SPACING.md,
    paddingRight: PLAY_SIZE + SPACING.md,
  },
  byline: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, marginBottom: 6 },
  // Fixed white, not the theme's text colour: this sits on a photographic scrim
  // in both themes, where the light theme's near-black would vanish.
  artist: { color: 'rgba(255,255,255,0.92)', fontSize: 13, fontWeight: '600', flexShrink: 1 },
  title: {
    color: '#FFFFFF', fontSize: 23, fontWeight: '800', letterSpacing: -0.4, lineHeight: 27,
    // The scrim does most of the work, but a cover can be pale exactly where the
    // title lands. This costs nothing and stops that one bad photo.
    textShadowColor: 'rgba(0,0,0,0.45)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4,
  },
  rank: {
    position: 'absolute', top: SPACING.sm, left: SPACING.sm,
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: RADIUS.md,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  rankText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
  play: {
    position: 'absolute', right: SPACING.md, bottom: SPACING.md,
    width: PLAY_SIZE, height: PLAY_SIZE, borderRadius: PLAY_SIZE / 2,
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF',
    // Lifts the button off busy artwork so its edge is always findable.
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 }, elevation: 5,
  },
  dots: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6,
    marginTop: SPACING.sm + 2,
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.border },
  // The theme's ink, not brand orange. Orange is the app's ACTION colour — it is
  // the Listen button and the compose button on this very screen — and spending
  // it on "which of five" says this pip is something to press. It is a position
  // indicator. colors.text rather than a flat white so it survives light mode,
  // where white on the page background would disappear entirely.
  dotOn: { backgroundColor: colors.text, width: 18 },
});
