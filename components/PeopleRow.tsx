import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { useFollow } from '../contexts/FollowContext';
import StoryAvatar from './StoryAvatar';
import FollowButton from './FollowButton';
import {
  fetchSuggestedAccounts, loadContactHashesIfEnabled, reasonLabel, type SuggestedAccount,
} from '../lib/suggestions';

// "People to follow" — one card-rail woven into the home feed a few posts down.
//
// The stories tray already offers accounts, but only at the very top and only
// while the rail is thin. This one meets somebody who is already scrolling, and
// it is where the honest discovery problem lives: a person who has liked a few
// things and now needs somewhere to go next.
//
// Every account carries WHY it is here — from your contacts, followed by people
// you follow, in your area, popular on Laybell — because a bare grid of
// strangers is a list to scroll past, while a reason is a thing to consider.
// lib/suggestions already ranks and labels all four, so this only renders them.

const MAX_CARDS = 10;

export default function PeopleRow({ currentUserId }: { currentUserId: string | null }) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const router = useRouter();
  const { following } = useFollow();
  const [people, setPeople] = useState<SuggestedAccount[]>([]);

  // Fetched once per mount. This row is a single item in a recycled list, so it
  // must not re-query as it scrolls in and out of view.
  useEffect(() => {
    if (!currentUserId) { setPeople([]); return; }
    let alive = true;
    (async () => {
      try {
        const contactHashes = await loadContactHashesIfEnabled(currentUserId);
        // Over-fetch: the filter below drops anyone already followed, and asking
        // for exactly MAX_CARDS would leave fewer than MAX_CARDS.
        const res = await fetchSuggestedAccounts(currentUserId, { contactHashes, max: MAX_CARDS + 8 });
        if (alive) setPeople(res);
      } catch { if (alive) setPeople([]); }
    })();
    return () => { alive = false; };
  }, [currentUserId]);

  // Filtered at RENDER against the live follow set, so following someone from
  // this very row removes their card rather than leaving it offering to
  // introduce you to somebody you now follow.
  const shown = people.filter((p) => p.id !== currentUserId && !following.has(p.id)).slice(0, MAX_CARDS);

  // Nothing worth showing is not a heading with a gap under it.
  if (shown.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <Text style={styles.heading}>{t('people.title')}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {shown.map((p) => (
          <View key={p.id} style={styles.card}>
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => router.push(`/profile/${p.id}`)}
              style={styles.cardTop}
            >
              {/* StoryAvatar, so somebody who is posting RIGHT NOW rings here and
                  opens their story — the same behaviour they get in the tray,
                  with no special-casing. */}
              <StoryAvatar
                userId={p.id}
                avatarUrl={p.avatar_url}
                name={p.display_name || p.username}
                size={64}
                onPressProfile={() => router.push(`/profile/${p.id}`)}
              />
              <Text style={styles.name} numberOfLines={1}>{p.display_name || p.username}</Text>
              <Text style={styles.reason} numberOfLines={2}>{reasonLabel(p.reason)}</Text>
            </TouchableOpacity>
            <FollowButton userId={p.id} style={styles.follow} />
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  // Sits between two posts, so it carries its own top and bottom rule — without
  // them it reads as an attachment to the post above it rather than as its own
  // thing in the feed.
  wrap: {
    paddingVertical: SPACING.md,
    borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.background,
  },
  heading: {
    color: colors.text, fontSize: 15, fontWeight: '800', letterSpacing: -0.2,
    paddingHorizontal: SPACING.md, marginBottom: SPACING.sm + 2,
  },
  row: { paddingHorizontal: SPACING.md, gap: SPACING.sm + 2 },
  card: {
    width: 116, alignItems: 'center', gap: 6,
    paddingVertical: SPACING.sm + 2, paddingHorizontal: SPACING.sm,
    backgroundColor: colors.surfaceLight,
    borderRadius: RADIUS.lg,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  cardTop: { alignItems: 'center', gap: 6, width: '100%' },
  name: { color: colors.text, fontSize: 13, fontWeight: '700', textAlign: 'center', maxWidth: '100%' },
  // Two lines of room, so "Followed by people you follow" is not cut to
  // "Followed by people you…" — the longest reason is also the most persuasive
  // one, and truncating it wastes the whole point of showing a reason.
  reason: {
    color: colors.textSecondary, fontSize: 10.5, lineHeight: 13,
    textAlign: 'center', height: 26,
  },
  follow: { alignSelf: 'stretch' },
});
