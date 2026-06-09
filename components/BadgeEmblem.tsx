import React from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { badgeRingColors, badgeGlow, displayedTier, type Tier, type ProfileBadgeFields } from '../lib/badges';

// The circular badge "emblem" shown next to a username app-wide (Instagram
// verified-check style), tinted by the user's overall badge tier with a subtle
// glow on the shine tiers. Renders NOTHING when the user has no badge or has
// hidden it — so it's always safe to drop in next to a name.
//
// Pass `profile` (reads badge_tier + badge_show, honoring the hide toggle) or an
// explicit `tier` (e.g. the current user's live tier from context).

type Props = {
  profile?: ProfileBadgeFields | null;
  tier?: Tier | null;
  size?: number;
  style?: StyleProp<ViewStyle>;
};

// Dark check reads better on the light tiers; white on the darker ones.
function checkColor(tier: Tier): string {
  return tier === 'silver' || tier === 'diamond' ? '#0B1A1E' : '#FFFFFF';
}

function BadgeEmblem({ profile, tier, size = 14, style }: Props) {
  const t = tier !== undefined ? tier : displayedTier(profile);
  if (!t) return null;
  const glow = badgeGlow(t);
  return (
    <LinearGradient
      colors={badgeRingColors(t)}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[
        { width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center' },
        glow,
        style,
      ]}
    >
      <Ionicons name="checkmark-sharp" size={Math.round(size * 0.66)} color={checkColor(t)} />
    </LinearGradient>
  );
}

export default React.memo(BadgeEmblem);
