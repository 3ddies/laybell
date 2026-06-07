import { useEffect, useRef, ReactNode } from 'react';
import { Animated, Easing, StyleSheet, ViewStyle } from 'react-native';

// Instagram-style "zoom open": on mount the content glides from slightly small
// (and faded) up to full size. Pairs with a `fade` screen transition so a tapped
// post appears to grow into place. Runs on the native driver (transform+opacity).
export default function ScaleInView({ children, style }: { children: ReactNode; style?: ViewStyle | ViewStyle[] }) {
  const v = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(v, {
      toValue: 1,
      duration: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [v]);

  const scale = v.interpolate({ inputRange: [0, 1], outputRange: [0.88, 1] });

  return (
    <Animated.View style={[styles.fill, style, { opacity: v, transform: [{ scale }] }]}>
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
