import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { RADIUS } from '../constants/theme';
import type { CommunityRole } from '../lib/communities';

// The community role colour-code from the notes: owner = Diamond, manager = Gold,
// member = standard. Used as a small inline chip next to a member's name and on
// the current user's role pill in the detail header.
//
// The tier colours (diamond cyan #A5F3FC especially) are tuned for DARK
// backgrounds — on white they wash out to near-invisible. In `light` mode swap
// to readable dark shades of the same hue so the chip stays legible.
export function roleColor(role: CommunityRole, colors: any, light = false): string {
  if (light) {
    return role === 'owner' ? '#0E7490' : role === 'manager' ? '#B45309' : colors.textSecondary;
  }
  return role === 'owner' ? colors.diamond : role === 'manager' ? colors.gold : colors.textSecondary;
}

const ROLE_ICON: Record<CommunityRole, keyof typeof Ionicons.glyphMap> = {
  owner: 'diamond',
  manager: 'shield-checkmark',
  member: 'person',
};

type Props = { role: CommunityRole; size?: number; showLabel?: boolean };

export default function RoleBadge({ role, size = 12, showLabel = true }: Props) {
  const { colors, mode } = useTheme();
  const { t } = useTranslation();
  const light = mode === 'light';
  const color = roleColor(role, colors, light);
  if (!showLabel) {
    return <Ionicons name={ROLE_ICON[role]} size={size} color={color} />;
  }
  // Light mode: a touch more fill + border so the crisper dark chip reads clean.
  return (
    <View style={[styles.chip, { borderColor: color + (light ? '80' : '66'), backgroundColor: color + (light ? '22' : '1A') }]}>
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
