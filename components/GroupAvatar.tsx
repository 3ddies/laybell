// Clustered avatar for group chats: the group's own image if set, otherwise up
// to three member avatars fanned into a small pile, else a people glyph.
import { View, Text, Image, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { GRADIENTS, RADIUS } from '../constants/theme';
import { useTheme } from '../contexts/ThemeContext';
import type { GroupProfile } from '../lib/groups';

type Props = {
  avatarUrl?: string | null;
  members: GroupProfile[];   // typically excluding the current user
  size?: number;
};

export default function GroupAvatar({ avatarUrl, members, size = 56 }: Props) {
  const { colors } = useTheme();

  if (avatarUrl) {
    return <Image source={{ uri: avatarUrl }} style={{ width: size, height: size, borderRadius: RADIUS.full }} />;
  }

  const shown = members.slice(0, 3);
  if (shown.length === 0) {
    return (
      <LinearGradient colors={GRADIENTS.avatar} style={[styles.full, { width: size, height: size, borderRadius: RADIUS.full }]}>
        <Ionicons name="people" size={size * 0.5} color="#fff" />
      </LinearGradient>
    );
  }

  // One big avatar with the others tucked behind, bottom-right — a compact pile.
  const chip = size * 0.62;
  return (
    <View style={{ width: size, height: size }}>
      {shown.map((m, i) => {
        // Stack from back to front; last one sits front-most, offset down-right.
        const offset = (size - chip) * (i / Math.max(1, shown.length - 1 || 1));
        return (
          <View
            key={m.id}
            style={[
              styles.chip,
              {
                width: chip, height: chip, borderRadius: RADIUS.full,
                left: offset, top: offset,
                borderColor: colors.background,
                zIndex: i,
              },
            ]}
          >
            {m.avatar_url ? (
              <Image source={{ uri: m.avatar_url }} style={styles.chipImg} />
            ) : (
              <LinearGradient colors={GRADIENTS.avatar} style={styles.chipImg}>
                <Text style={[styles.initial, { fontSize: chip * 0.42 }]}>
                  {(m.display_name || m.username || '?').charAt(0).toUpperCase()}
                </Text>
              </LinearGradient>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  full: { alignItems: 'center', justifyContent: 'center' },
  chip: { position: 'absolute', overflow: 'hidden', borderWidth: 2 },
  chipImg: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
  initial: { color: '#fff', fontWeight: '800' },
});
