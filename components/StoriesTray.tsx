import { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { SPACING, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { useProfile } from '../contexts/ProfileContext';
import { useStories } from '../contexts/StoriesContext';
import { useFollow } from '../contexts/FollowContext';
import { chosenTier, badgeRingColors } from '../lib/badges';
import { fetchSuggestedAccounts, loadContactHashesIfEnabled, type SuggestedAccount } from '../lib/suggestions';
import StoryAvatar from './StoryAvatar';

// Below this many stories from people you follow, the rail backfills with
// suggested accounts. A tray holding your own circle and one other reads as
// broken; the point of this row is that there is something in it.
const MIN_STORIES = 3;
const MAX_SUGGESTIONS = 10;

// The row of story circles at the top of the Home feed. Your own circle leads
// (with a ＋ to add), then followed users who have an active story — unseen rings
// (gradient) ahead of seen ones. Reads global story state from StoriesContext so
// the rings/ordering match story rings shown elsewhere in the app.
//
// THE ROW BACKFILLS ITSELF, for every account rather than only new ones.
//
// A new account follows nobody, so this row was their own circle and nothing
// else — the emptiest thing on the busiest screen. But an account is not the
// same as its age: follow twenty people who never post stories and the row is
// just as empty, and that user needs the way out just as much.
//
// So the test is how many of the people YOU FOLLOW have a story right now, and
// nothing else. Below MIN_STORIES the row fills, in two layers that stack:
//   • up to five of the app's most-watched stories from people you do not
//     follow (lib/stories fetchDiscoveryGroups — always appended, for everyone,
//     so there is something to watch even with no follows at all), and
//   • accounts worth following, below the hairline.
// Neither layer counts toward the test that decides whether to show them.
//
// They are NOT dressed up as stories. StoryAvatar draws a ring only when the
// user genuinely has an active story, so a suggestion with nothing to watch
// shows a plain avatar and opens their profile — and one that IS posting right
// now rings and opens the story, because `hasStory` reads the app-wide flag map
// (every active story the viewer can see, per the "anyone can view active
// stories" policy) rather than the self+following tray. Both cases fall out of
// StoryAvatar with no special-casing here, which is why this file passes
// onPressProfile and nothing else.
export default function StoriesTray() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const router = useRouter();
  const { profile } = useProfile();
  const { groups, openCamera, refresh } = useStories();
  const { following } = useFollow();
  const currentUserId = profile?.id ?? null;
  const [suggestions, setSuggestions] = useState<SuggestedAccount[]>([]);

  // Keep the tray fresh on every return to Home (e.g. after posting/viewing).
  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  // Fetched once per mount, NOT per focus: this is several queries behind
  // lib/suggestions, and re-running it every time Home regains focus would put
  // that on the path of every tab switch. Whether the results are SHOWN is
  // decided at render from the live story count, so a stale fetch can only cost
  // a request, never a wrong row.
  useEffect(() => {
    if (!currentUserId) { setSuggestions([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const contactHashes = await loadContactHashesIfEnabled(currentUserId);
        // Over-fetch: the filters below drop anyone already followed or already
        // in the tray, and asking for exactly 10 would leave fewer than 10.
        const res = await fetchSuggestedAccounts(currentUserId, { contactHashes, max: MAX_SUGGESTIONS + 8 });
        if (!cancelled) setSuggestions(res);
      } catch { if (!cancelled) setSuggestions([]); }
    })();
    return () => { cancelled = true; };
  }, [currentUserId]);

  const ownGroup = groups.find((g) => g.user.id === currentUserId) ?? null;
  const others = groups.filter((g) => g.user.id !== currentUserId);

  const ownAvatar = profile?.avatar_url ?? ownGroup?.user.avatar_url ?? null;
  const ownName = profile?.display_name ?? profile?.username ?? '';

  // The ＋ button is themed to the user's badge tier (like the cosmetic ring);
  // no badge → undefined, so it falls back to the default Laybell orange.
  const ownTier = chosenTier(profile);
  const addColors = ownTier ? badgeRingColors(ownTier) : undefined;

  // Counted over the people you actually FOLLOW, not over everything in the rail.
  //
  // This is the whole question of "is your rail thin", and it has nothing to do
  // with how old the account is: somebody who has followed twenty people who
  // never post stories has exactly the same empty row as somebody who signed up
  // this morning, and both should be offered a way out of it.
  //
  // It also has to exclude the discovery stories, which are themselves backfill.
  // Counting them meant five strangers' stories pushed the total past the
  // threshold and switched the suggestions off — backfill suppressing backfill,
  // so the row stopped offering anyone to follow the moment it started working.
  const followedWithStories = others.filter((g) => following.has(g.user.id)).length;

  // Decided at RENDER, from the story count as it stands now — so suggestions
  // withdraw on their own the moment the people you follow start posting, with
  // no second fetch and no state to keep in step.
  //
  // Filtered against `following` as well as the tray, because FollowContext
  // updates the instant you follow someone from their profile: tap a suggestion,
  // follow, come back, and they are gone rather than sitting there offering to
  // introduce you to somebody you now follow.
  const shownSuggestions = followedWithStories < MIN_STORIES
    ? suggestions
        .filter((s) => s.id !== currentUserId
          && !following.has(s.id)
          && !groups.some((g) => g.user.id === s.id))
        .slice(0, MAX_SUGGESTIONS)
    : [];

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
      {/* Your story */}
      <View style={styles.item}>
        <StoryAvatar
          userId={currentUserId}
          avatarUrl={ownAvatar}
          name={ownName}
          size={RING}
          onPressProfile={openCamera} // no active story → tapping opens the camera
          raised
          showAdd
          addColors={addColors}
          onPressAdd={openCamera}
        />
        <Text style={styles.label} numberOfLines={1}>{t('storiesTray.yourStory')}</Text>
      </View>

      {/* Followed users with active stories */}
      {others.map((g) => (
        <View key={g.user.id} style={styles.item}>
          <StoryAvatar
            userId={g.user.id}
            avatarUrl={g.user.avatar_url}
            name={g.user.display_name || g.user.username}
            size={RING}
            raised
          />
          <Text style={styles.label} numberOfLines={1}>
            {g.user.username || g.user.display_name}
          </Text>
        </View>
      ))}

      {/* A hairline, not a heading. The row is 82pt circles with a label under
          each; a title would need its own line and turn a rail into a section.
          The rule plus the missing ring is enough to say these are a different
          kind of thing — and it needs no string, so it cannot go untranslated
          in nine locales. */}
      {shownSuggestions.length > 0 && <View style={styles.divider} />}

      {shownSuggestions.map((s) => (
        <View key={s.id} style={styles.item}>
          {/* onPressProfile is the fallback StoryAvatar uses when there is no
              active story. When there IS one it ignores this and opens the
              story instead — which is what should happen. */}
          <StoryAvatar
            userId={s.id}
            avatarUrl={s.avatar_url}
            name={s.display_name || s.username}
            size={RING}
            onPressProfile={() => router.push(`/profile/${s.id}`)}
          />
          <Text style={styles.label} numberOfLines={1}>
            {s.username || s.display_name}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

const RING = 82;

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  // Tightened from a 16pt gap on a RING+6 item — 22pt between circles, which
  // put barely three and a half on screen and made the rail feel like a longer
  // scroll than it is. Now 12pt, so a fourth circle comes into view and the row
  // reads as a set rather than as separated items. Not tighter than that: the
  // raised circles cast a shadow, and they need room to sit in.
  row: { paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, gap: SPACING.sm },
  item: { width: RING + 4, alignItems: 'center', gap: 5 },
  label: { color: colors.textSecondary, fontSize: 12, maxWidth: RING + 4, textAlign: 'center' },
  // Sized to the circles and centred on them, so it reads as a break in the row
  // rather than a full-height wall — the labels below hang past it on purpose.
  divider: {
    width: StyleSheet.hairlineWidth, height: RING * 0.62,
    alignSelf: 'center', backgroundColor: colors.border,
    marginHorizontal: SPACING.xs,
  },
});
