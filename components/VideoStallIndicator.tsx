import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import Spinner from './Spinner';

// The "still loading, not frozen" marker shown over a video that has stalled
// mid-playback (see hooks/useVideoStall).
//
// Deliberately quiet: a small disc, centered, faded in over 180ms. It is NOT a
// full-screen scrim and it never blocks touches — the user can still swipe to
// the next reel, scroll the feed, or tap through while it's up. The dark disc
// exists only so a white spinner stays visible over a bright frozen frame.
export default function VideoStallIndicator({ visible, size = 26 }: {
  visible: boolean;
  size?: number;
}) {
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fade, {
      toValue: visible ? 1 : 0,
      duration: visible ? 180 : 120,
      useNativeDriver: true,
    }).start();
  }, [visible, fade]);

  // Keep it mounted through the fade-out, but stop it costing anything once the
  // stall is over: no spinner child means no running rotation loop.
  return (
    <Animated.View
      style={[styles.wrap, { opacity: fade }]}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {visible ? (
        <View style={styles.disc}>
          <Spinner size={size} thickness={2.5} color="#fff" />
        </View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  disc: {
    width: 56, height: 56, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
});
