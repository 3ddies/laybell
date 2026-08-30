import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import MentionText from './MentionText';
import { useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { SPACING, type ThemePalette } from '../constants/theme';

// A film's text on a home-feed card.
//
// A film is the one post type carrying TWO separate pieces of writing — the
// title (posts.film_title) and the description (the ordinary caption) — and a
// feed row has room for roughly one. Stacking both pushes the like/comment row
// down on every film in the feed, so the slot ALTERNATES between them on a slow
// crossfade instead.
//
// Weight carries the distinction rather than colour: the title is 700 and the
// description 400, so a glance at any moment says which of the two you are
// reading without needing a label to announce it.
//
// A description too long for the slot gets an "…" button. Pressing it ENDS the
// rotation and shows title and description stacked — the cycling exists only to
// save vertical space, so once the user has asked for that space the reason for
// it is gone, and continuing to hide half the text behind a timer would be
// actively hostile to someone who just said they wanted to read it.

type Props = {
  title?: string | null;
  /** The description — a film's caption. Already translated by the caller. */
  caption?: string | null;
  /** Community hashtags, rendered on their own line under the text. */
  tags?: ReactNode;
  /**
   * False while the card is off-screen. The rotation is a visual effect with
   * nobody watching it at that point, and a feed holds many cards.
   */
  active?: boolean;
};

const COLLAPSED_LINES = 2;
// The two halves lead differently on purpose. A title is usually ONE line where
// a description is two, so it earns its presence by size rather than by bulk —
// 20 over the description's 14, which is what keeps a single line of it from
// looking stranded in a two-line box. The description stays on 21, the line
// height the ordinary feed caption already uses. The box takes the taller lead of
// the two, so either can still wrap to its full two lines without being clipped.
const TITLE_LINE = 24;
const DESC_LINE = 21;
const BOX_H = Math.max(TITLE_LINE, DESC_LINE) * COLLAPSED_LINES;
// Long enough to read a description without hurrying and to sit with a title
// rather than watch it leave — a rotation that turns faster than the reader does
// is just motion. The trade is deliberate: at this pace someone scrolling
// briskly past sees one half rather than both, which is the right way round,
// since the cost of missing a line is far smaller than the cost of text moving
// out from under someone still reading it.
const HOLD_MS = 8200;
const FADE_MS = 520;

export default function FilmCaption({ title, caption, tags, active = true }: Props) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const [expanded, setExpanded] = useState(false);
  // Real line count of the UNCLAMPED description, from the hidden measuring copy
  // below. 0 until it has been laid out once.
  const [descLines, setDescLines] = useState(0);
  // Which half is currently on top. Only drives pointerEvents — without it the
  // faded-out description still eats taps meant for the title underneath, so a
  // @mention nobody can see would swallow a tap on the card.
  const [showing, setShowing] = useState<0 | 1>(0);
  const fade = useRef(new Animated.Value(0)).current;
  // The end the last fade aimed at, so pausing (card scrolled away) and resuming
  // continues the alternation instead of snapping back to the title.
  const phase = useRef<0 | 1>(0);

  const hasTitle = !!title?.trim();
  const hasCaption = !!caption?.trim();
  const cycles = hasTitle && hasCaption && !expanded;
  // `tags` arrives as a mapped array, and an EMPTY array is truthy — testing it
  // directly buys a stray spacer row on every film with no community.
  const hasTags = Array.isArray(tags) ? tags.length > 0 : !!tags;

  useEffect(() => {
    if (!cycles || !active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      timer = setTimeout(() => {
        if (cancelled) return;
        const to: 0 | 1 = phase.current === 1 ? 0 : 1;
        // Handing over the taps at the START of the fade, not the end: the
        // outgoing half should stop being interactive the moment it begins to
        // leave, and a setState landing on an animation's last frame is a
        // dropped frame on a card that may also be playing video.
        phase.current = to;
        setShowing(to);
        Animated.timing(fade, { toValue: to, duration: FADE_MS, useNativeDriver: true })
          .start(({ finished }) => { if (finished && !cancelled) step(); });
      }, HOLD_MS);
    };
    step();
    // Only the CHAIN is cancelled; an in-flight fade is left to land. Stopping a
    // native-driven animation is a round trip that can resolve after whatever we
    // set next, which is how a layer ends up stuck half-faded.
    return () => { cancelled = true; clearTimeout(timer); };
  }, [cycles, active, fade]);

  const titleOpacity = useMemo(
    () => fade.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
    [fade],
  );

  if (!hasTitle && !hasCaption) return hasTags ? <View style={styles.wrap}>{tags}</View> : null;

  // Expanded, or only one of the two exists — nothing to rotate between.
  if (!cycles) {
    return (
      <View style={styles.wrap}>
        {hasTitle && <Text style={styles.title}>{title}</Text>}
        {hasCaption && (
          <MentionText style={[styles.desc, hasTitle && styles.descUnderTitle]} text={caption} />
        )}
        {hasTags && <View style={styles.row}>{tags}</View>}
      </View>
    );
  }

  const isLong = descLines > COLLAPSED_LINES;

  return (
    <View style={styles.wrap}>
      <View style={styles.box}>
        {/* Measures the description UNCLAMPED, to learn whether it genuinely
            overflows two lines. Estimating that from character count is wrong on
            both sides — a wide phone, one long word, an emoji — and the cost is
            a single extra text layout on the rarest post type there is. First in
            the tree so it sits beneath the two real layers. */}
        <Text
          style={[styles.desc, styles.measure]}
          onTextLayout={(e) => setDescLines(e.nativeEvent.lines.length)}
        >
          {caption}
        </Text>
        <Animated.View style={[styles.layer, { opacity: titleOpacity }]} pointerEvents="none">
          <Text style={styles.title} numberOfLines={COLLAPSED_LINES}>{title}</Text>
        </Animated.View>
        <Animated.View style={[styles.layer, { opacity: fade }]} pointerEvents={showing === 1 ? 'auto' : 'none'}>
          <MentionText style={styles.desc} numberOfLines={COLLAPSED_LINES} text={caption} />
        </Animated.View>
      </View>
      {(isLong || hasTags) && (
        <View style={styles.row}>
          {isLong && (
            <TouchableOpacity
              onPress={() => setExpanded(true)}
              hitSlop={{ top: 12, bottom: 12, left: 14, right: 14 }}
              accessibilityRole="button"
              // Reuses the share sheet's key, which is the bare word "More" in
              // every locale — the right label for a glyph that has none.
              accessibilityLabel={t('share.more')}
            >
              <Text style={styles.moreBtn}>…</Text>
            </TouchableOpacity>
          )}
          {tags}
        </View>
      )}
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  wrap: { paddingHorizontal: SPACING.md, paddingTop: SPACING.sm },
  // Fixed height so the crossfade never resizes the card: a one-line title and a
  // two-line description swap inside the same box, and the feed below stays
  // exactly where it was.
  box: { height: BOX_H, overflow: 'hidden' },
  // TOP-aligned, not centred. Centring put a one-line title halfway down a
  // two-line box while a two-line description started at the top, so the title
  // appeared to drop every time it came round — the swap has to happen on a
  // shared first line or it reads as movement rather than substitution.
  layer: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, justifyContent: 'flex-start' },
  measure: { position: 'absolute', left: 0, right: 0, top: 0, opacity: 0 },
  title: { color: colors.text, fontSize: 20, lineHeight: TITLE_LINE, fontWeight: '700', letterSpacing: -0.5 },
  desc: { color: colors.text, fontSize: 14, lineHeight: DESC_LINE, fontWeight: '400' },
  descUnderTitle: { marginTop: 2 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginTop: 2 },
  moreBtn: {
    color: colors.textTertiary, fontSize: 17, lineHeight: 18, fontWeight: '700',
    paddingRight: SPACING.xs,
    // An ellipsis sits on the BASELINE, near the floor of its line box, so it
    // reads as further from the text above than it measures. Pulled up to close
    // that gap optically; the tags beside it keep their own alignment.
    marginTop: -8,
  },
});
