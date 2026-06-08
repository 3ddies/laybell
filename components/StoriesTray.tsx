import { useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { COLORS, SPACING } from '../constants/theme';
import { useProfile } from '../contexts/ProfileContext';
import { useStories } from '../contexts/StoriesContext';
import StoryAvatar from './StoryAvatar';

// The row of story circles at the top of the Home feed. Your own circle leads
// (with a ＋ to add), then followed users who have an active story — unseen rings
// (gradient) ahead of seen ones. Reads global story state from StoriesContext so
// the rings/ordering match story rings shown elsewhere in the app.
export default function StoriesTray() {
  const { profile } = useProfile();
  const { groups, openCamera, refresh } = useStories();
  const currentUserId = profile?.id ?? null;

  // Keep the tray fresh on every return to Home (e.g. after posting/viewing).
  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  const ownGroup = groups.find((g) => g.user.id === currentUserId) ?? null;
  const others = groups.filter((g) => g.user.id !== currentUserId);

  const ownAvatar = profile?.avatar_url ?? ownGroup?.user.avatar_url ?? null;
  const ownName = profile?.display_name ?? profile?.username ?? '';

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
          showAdd
          onPressAdd={openCamera}
        />
        <Text style={styles.label} numberOfLines={1}>Your story</Text>
      </View>

      {/* Followed users with active stories */}
      {others.map((g) => (
        <View key={g.user.id} style={styles.item}>
          <StoryAvatar
            userId={g.user.id}
            avatarUrl={g.user.avatar_url}
            name={g.user.display_name || g.user.username}
            size={RING}
          />
          <Text style={styles.label} numberOfLines={1}>
            {g.user.username || g.user.display_name}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

const RING = 64;

const styles = StyleSheet.create({
  row: { paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, gap: SPACING.md },
  item: { width: RING + 6, alignItems: 'center', gap: 5 },
  label: { color: COLORS.textSecondary, fontSize: 12, maxWidth: RING + 6, textAlign: 'center' },
});
