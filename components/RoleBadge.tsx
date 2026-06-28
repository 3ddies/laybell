import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { RADIUS } from '../constants/theme';
import type { CommunityRole } from '../lib/communities';

// The community role colour-code from the notes: owner = Diamond, manager = Gold,
// member = standard. Used as a small inline chip next to a member's name and on
// the current user's role pill in the detail header.
export function roleColor(role: CommunityRole, colors: any): string {
  return role === 'owner' ? colors.diamond : role === 'manager' ? colors.gold : colors.textSecondary;
}

const ROLE_ICON: Record<CommunityRole, keyof typeof Ionicons.glyphMap> = {
  owner: 'diamond',
  manager: 'shield-checkmark',
  member: 'person',
};

type Props = { role: CommunityRole; size?: number; showLabel?: boolean };

export default function RoleBadge({ role, size = 12, showLabel = true }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const color = roleColor(role, colors);
  if (!showLabel) {
    return <Ionicons name={ROLE_ICON[role]} size={size} color={color} />;
  }
  return (
    <View style={[styles.chip, { borderColor: color + '66', backgroundColor: color + '1A' }]}>
      <Ionicons name={ROLE_ICON[role]} size={size} color={color} />
      <Text style={[styles.label, { color, fontSize: size }]}>{t(`communities.role.${role}`)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 7, paddingVertical: 3,
    borderRadius: RADIUS.full, borderWidth: 1,
  },
  label: { fontWeight: '700' },
});
