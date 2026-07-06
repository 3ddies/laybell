import React, { useEffect, useRef } from 'react';
import { TouchableOpacity, View, Animated, Easing, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { emblemGradient, badgeRim, badgeGlow, displayedTier, type Tier, type ProfileBadgeFields } from '../lib/badges';
import { useProfile } from '../contexts/ProfileContext';

// A specular sheen that sweeps diagonally across the DIAMOND emblem on a loop
// (the "diamond shine" — the one tier that earns a live animation). Clipped to
// the circle by the emblem's overflow:hidden. Native-driven, pauses between
// sweeps so it reads as an occasional glint, not a strobe.
function DiamondShine({ size }: { size: number }) {
  const x = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(x, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.delay(1900),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [x]);
  const translateX = x.interpolate({ inputRange: [0, 1], outputRange: [-size * 1.1, size * 1.1] });
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: size / 2, overflow: 'hidden' }]}>
      <Animated.View style={{ position: 'absolute', top: -size * 0.6, bottom: -size * 0.6, width: size * 0.55, transform: [{ translateX }, { rotate: '22deg' }] }}>
        <LinearGradient
          colors={['rgba(255,255,255,0)', 'rgba(255,255,255,0.9)', 'rgba(255,255,255,0)']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={{ flex: 1 }}
        />
      </Animated.View>
    </View>
  );
}

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

// Dark check reads better on the lighter tiers (silver/gold/diamond fills lead
// with a bright stop); white on bronze's darker fill.
function checkColor(tier: Tier): string {
  return tier === 'bronze' ? '#FFFFFF' : '#0B1A1E';
}

function BadgeEmblem({ profile, tier, ownerId, size = 14, style }: Props) {
  const router = useRouter();
  const { profile: me } = useProfile();
  const t = tier !== undefined ? tier : displayedTier(profile);
  if (!t) return null;

  const node = (
    <LinearGradient
      colors={emblemGradient(t)}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[
        // NO overflow:hidden here — a clipped view can't cast badgeGlow's outer
        // shadow (RN). DiamondShine clips itself, so the glow is preserved.
        { width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center' },
        badgeRim(t),
        badgeGlow(t),
        style,
      ]}
    >
      <Ionicons name="checkmark-sharp" size={Math.round(size * 0.66)} color={checkColor(t)} />
      {t === 'diamond' && <DiamondShine size={size} />}
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
