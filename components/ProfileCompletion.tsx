import { memo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { profileTasks, profileProgress, type ProfileFacts, type ProfileTaskKey } from '../lib/profileCompletion';
import GuardedRail from './GuardedRail';

// "Complete your profile" on your own profile page (owner, 2026-09-20): the four
// things that turn an empty account into one worth following, and how far along
// you are. Finishing them earns Bronze Profile (lib/badges) — the first badge a
// new account can hold, and the only one that asks for nothing but setting
// yourself up.
//
// The rules live in lib/profileCompletion, which the badge reads too, so the card
// and the badge cannot disagree about what "done" means.
//
// UPRIGHT CARDS in a horizontal row (owner, 2026-09-20) — the "Suggested for
// you" shape, which is what this screen already uses to say "here are a few
// things worth doing". Each is a plain white glyph, the name, and the ask; the
// whole card is the tap target, with no button and no × inside it.
//
// One × on the section instead, next to the count.
//
// A WHOLE CARD IS THE BUTTON, and it carries no button of its own (owner,
// 2026-09-20). Small round controls and a green pill on every card read as
// another platform's UI — the owner's word was "androidy" — and a button inside
// a thing that is already a button says the same instruction twice. So: a plain
// white glyph with nothing drawn around it, the name, the ask, and the card
// itself is the tap target.
//
// The only green left is the progress bar, where it means what green means:
// how much of this is finished. (colors.success, the token the Shop button wears.)
//
// It lives INSIDE the scrolling grid, not above it (see app/(tabs)/profile.tsx):
// anything in the profile's fixed header costs the same pixels on every screen
// forever, and this one was squeezing the grid it is meant to fill.

// FILLED, not outline. Four outline glyphs at this size came out at four
// different weights — a pencil is mostly air, a storefront is mostly line — so
// the row read as unfinished. Solid shapes carry the same ink as each other,
// which is what makes a set of icons look deliberate.
//
// Chosen for similar silhouettes too: each is a single compact mass rather than
// a wide one beside a narrow one.
const ICONS: Record<ProfileTaskKey, string> = {
  avatar: 'person-circle',
  bio: 'create',
  post: 'images',
  shop: 'storefront',
};

function ProfileCompletion({ facts, dismissed, onTask, onDismiss, onGuardStart, onGuardEnd }: {
  facts: ProfileFacts;
  /** Waved away for good — hidden, and never counted as done. */
  dismissed?: boolean;
  /** Send the user where the task gets done. */
  onTask: (key: ProfileTaskKey) => void;
  onDismiss: () => void;
  /**
   * Held while a finger is dragging this row — the host turns off the page
   * swipes that would otherwise read the same gesture as "change tab". Only
   * fired when the row can actually scroll (components/GuardedRail).
   */
  onGuardStart?: () => void;
  onGuardEnd?: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();

  const { done, total, complete } = profileProgress(facts);
  const open = profileTasks(facts).filter((task) => !task.done);
  if (dismissed || complete || open.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>{t('profileDone.title')}</Text>
        <View style={styles.titleRight}>
          <Text style={styles.count}>{t('profileDone.progress', { done, total })}</Text>
          <TouchableOpacity
            onPress={onDismiss}
            style={styles.dismissBtn}
            hitSlop={10}
            activeOpacity={0.6}
            accessibilityRole="button"
            accessibilityLabel={t('a11y.close')}
          >
            <Ionicons name="close" size={16} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      </View>

      {/* How far along, as one bar: four ticks in a row read as a list to audit,
          a bar reads as progress to finish. */}
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${Math.round((done / total) * 100)}%` }]} />
      </View>

      {/* The same guarded rail the album shelf and the sub-tab strip use: while a
          finger is on it, the page's own swipes stand down, so dragging through
          the cards can never be read as "change tab". A row short enough to fit
          guards nothing, and the page keeps its swipes. */}
      <GuardedRail
        contentContainerStyle={styles.row}
        alwaysBounceHorizontal={false}
        onGuardStart={() => onGuardStart?.()}
        onGuardEnd={() => onGuardEnd?.()}
      >
        {open.map((task) => (
          <TouchableOpacity
            key={task.key}
            style={styles.card}
            activeOpacity={0.85}
            onPress={() => onTask(task.key)}
            accessibilityRole="button"
            accessibilityLabel={t(`profileDone.${task.key}`)}
          >
            <Ionicons name={ICONS[task.key] as any} size={30} color={colors.text} />
            <Text style={styles.name} numberOfLines={1}>{t(`profileDone.name.${task.key}`)}</Text>
            <Text style={styles.reason} numberOfLines={2}>{t(`profileDone.${task.key}`)}</Text>
          </TouchableOpacity>
        ))}
      </GuardedRail>
    </View>
  );
}

export default memo(ProfileCompletion);

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  wrap: { paddingTop: SPACING.sm, paddingBottom: SPACING.md, gap: SPACING.sm },
  titleRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.md,
  },
  titleRight: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  title: { color: colors.text, fontSize: 15, fontWeight: '800' },
  count: { color: colors.textSecondary, fontSize: 13, fontWeight: '700' },
  dismissBtn: {
    width: 24, height: 24, borderRadius: RADIUS.full,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceLight,
  },

  track: {
    height: 4, borderRadius: 2, marginHorizontal: SPACING.md,
    backgroundColor: colors.border, overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: 2, backgroundColor: colors.success },

  // alignItems stretch: every card takes the height of the TALLEST one, so a
  // one-line ask and a two-line ask still line up — without a fixed height, which
  // is what left a band of dead space under the short ones.
  row: { gap: SPACING.sm, paddingHorizontal: SPACING.md, paddingTop: 2, alignItems: 'stretch' },
  // UPRIGHT cards, the "Suggested for you" shape — taller than they are wide.
  //
  // The formatting inside them is the part that was off: a fixed height so all
  // four line up whatever their text does, the glyph given room above the words
  // rather than crowding them, and the name and the ask as one block at the
  // bottom instead of three evenly-spaced things floating in a box.
  card: {
    width: 152,
    paddingHorizontal: SPACING.sm + 2, paddingVertical: SPACING.md,
    // Centred in whatever height the row settles on, so the leftover space is
    // split above and below instead of pooling at the bottom.
    alignItems: 'center', justifyContent: 'center', gap: SPACING.sm,
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.md, borderWidth: 1, borderColor: colors.border,
  },
  // The line that has to be readable at a glance — it names the thing, so it is
  // the one that gets the size. Tight tracking keeps two words on one line.
  name: { color: colors.text, fontSize: 15, fontWeight: '800', textAlign: 'center', letterSpacing: -0.2 },
  // Quieter and a size down: it is the sentence you read only if the name did
  // not already tell you. Sits right under it — the gap above belongs to the glyph.
  reason: { color: colors.textSecondary, fontSize: 11.5, lineHeight: 15, textAlign: 'center', marginTop: -4 },
});
