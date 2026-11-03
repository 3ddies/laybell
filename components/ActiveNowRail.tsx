import { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '../lib/supabase';
import { useFollow } from '../contexts/FollowContext';
import { useProfile } from '../contexts/ProfileContext';
import { useActiveNow } from '../lib/onlineStatus';
import StoryAvatar from './StoryAvatar';
import { SPACING, type ThemePalette } from '../constants/theme';
import { useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

type MiniProfile = { id: string; display_name: string | null; username: string | null; avatar_url: string | null };

// Short label under each face — a first name reads cleaner than a full name in a
// 66pt cell; fall back to the @handle if there's no display name.
function shortName(name?: string | null, username?: string | null): string {
  const first = (name || '').trim().split(/\s+/)[0];
  return first || username || '';
}

const RAIL_LIMIT = 5;

// Instagram-style "Active now" rail for the top of Messages: up to 5 people who are
// online right now, as a horizontal strip you tap to open that DM.
//
// The viewer's OWN people come first — friends, then anyone else they follow — and the
// server fills any slots still open with other online Laybell users (most-recently-
// active first). So on a near-empty app the feature still shows faces, but a stranger
// never appears while five of your own people are active. Fully gated by the viewer's
// Active Status: off → the rail is hidden and they stay invisible to others (the server
// enforces that reciprocity; this just keeps the inbox looking normal). See
// lib/onlineStatus (useActiveNow) and supabase/sql/active_status.sql (active_now).
export default function ActiveNowRail() {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const router = useRouter();
  const { friends, following } = useFollow();
  const { profile } = useProfile();

  // Opted in? ON by default once the column exists; off only when explicitly false
  // (same rule as ProfileContext + the Settings switch).
  const enabled = !!profile && (profile as any).active_status_enabled !== false;

  // Personalization: friends first, then everyone else the viewer follows — so the
  // rail recommends the user's own people ahead of the global fill.
  const prefer = useMemo(() => {
    const fr = [...friends];
    const extra = [...following].filter((id) => !friends.has(id));
    return [...fr, ...extra];
  }, [friends, following]);

  const activeIds = useActiveNow(enabled ? prefer : null, RAIL_LIMIT);
  const activeKey = activeIds.join(',');

  // Avatar + name for whoever's active (≤5), fetched when the set changes. Hidden
  // accounts are already excluded server-side; filter defensively here too.
  const [profiles, setProfiles] = useState<Record<string, MiniProfile>>({});
  useEffect(() => {
    if (!activeIds.length) { setProfiles({}); return; }
    let live = true;
    supabase
      .from('profiles')
      .select('id, display_name, username, avatar_url, hidden')
      .in('id', activeIds)
      .then(({ data }) => {
        if (!live) return;
        const map: Record<string, MiniProfile> = {};
        for (const p of (data ?? []) as any[]) {
          if (p.hidden) continue;
          map[p.id] = { id: p.id, display_name: p.display_name, username: p.username, avatar_url: p.avatar_url };
        }
        setProfiles(map);
      });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  // Preserve the server's order (prefer-first, then most-recently-active).
  const list = activeIds.map((id) => profiles[id]).filter(Boolean) as MiniProfile[];

  // Opted out, or nobody active → no rail at all (the inbox reads as normal).
  if (!enabled || !list.length) return null;

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>{t('messages.activeNow')}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {list.map((p) => (
          <TouchableOpacity
            key={p.id}
            style={styles.cell}
            activeOpacity={0.8}
            onPress={() => router.push(`/messages/${p.id}`)}
          >
            <StoryAvatar userId={p.id} avatarUrl={p.avatar_url} name={p.display_name} size={60} showPresence />
            <Text style={styles.name} numberOfLines={1}>{shortName(p.display_name, p.username)}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  wrap: {
    paddingTop: SPACING.sm,
    paddingBottom: SPACING.sm,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
    marginBottom: SPACING.xs,
  },
  title: {
    color: colors.textTertiary, fontSize: 11, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.8,
    paddingHorizontal: SPACING.md, marginBottom: SPACING.sm,
  },
  row: { paddingHorizontal: SPACING.md, gap: SPACING.md },
  cell: { width: 66, alignItems: 'center', gap: 5 },
  name: { color: colors.textSecondary, fontSize: 12, maxWidth: 66, textAlign: 'center' },
});
