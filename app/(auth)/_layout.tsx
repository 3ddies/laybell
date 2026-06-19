import { Stack } from 'expo-router';
import { useTheme } from '../../contexts/ThemeContext';

export default function AuthLayout() {
  const { colors } = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
        animation: 'none',
        // No swipe-back anywhere on the auth screens: after logging out you must
        // not be able to swipe back to the previous (now signed-out) user's pages,
        // and login/signup themselves aren't swipeable either.
        gestureEnabled: false,
        fullScreenGestureEnabled: false,
      }}
    />
  );
}