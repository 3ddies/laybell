import React from 'react';
import { TouchableOpacity, type StyleProp, type ViewStyle } from 'react-native';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { badgeRingColors, badgeGlow, displayedTier, type Tier, type ProfileBadgeFields } from '../lib/badges';
import { useProfile } from '../contexts/ProfileContext';

// The circular badge "emblem" shown next to a username app-wide (Instagram
// verified-check style), tinted by the user's overall badge tier with a subtle
// glow on the shine tiers. Renders NOTHING when the user has no badge or has
// hidden it — so it's always safe to drop in next to a name.
//
// Pass `profile` (reads badge_tier + badge_show, honoring the hide toggle) or an
// explicit `tier` (e.g. the current user's live tier from context).
//
// Tapping YOUR OWN emblem (when it belongs to the signed-in user) opens the
// Badges page; tapping anyone else's does nothing. Ownership is `ownerId` if
// given, else `profile.id` — pass `ownerId` at call sites whose profile join
// omits the id (feed, comments, etc.).

type Props = {
  profile?: ProfileBadgeFields | null;
  tier?: Tier | null;
  ownerId?: string | null;
  size?: number;
  style?: StyleProp<ViewStyle>;
};

// Dark check reads better on the light tiers; white on the darker ones.
function checkColor(tier: Tier): string {
  return tier === 'silver' || tier === 'diamond' ? '#0B1A1E' : '#FFFFFF';
}

function BadgeEmblem({ profile, tier, ownerId, size = 14, style }: Props) {
  const router = useRouter();
  const { profile: me } = useProfile();
  const t = tier !== undefined ? tier : displayedTier(profile);
  if (!t) return null;

  const node = (
    <LinearGradient
      colors={badgeRingColors(t)}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[
        { width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center' },
        badgeGlow(t),
        style,
      ]}
    >
      <Ionicons name="checkmark-sharp" size={Math.round(size * 0.66)} color={checkColor(t)} />
    </LinearGradient>
  );

  // Only the signed-in user's own emblem is interactive (opens their Badges page).
  const owner = ownerId ?? profile?.id ?? null;
  if (owner && me?.id && owner === me.id) {
    return (
      <TouchableOpacity
        onPress={() => router.push('/badges')}
        activeOpacity={0.7}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      >
        {node}
      </TouchableOpacity>
    );
  }
  return node;
}

export default React.memo(BadgeEmblem);
