import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';

// Landing route for Supabase auth links (signup confirmation and password
// recovery). It renders nothing but a spinner ON PURPOSE — the work happens in
// app/_layout.tsx, whose Linking listener turns the inbound URL into a session
// and then routes onward (recovery → set a password; confirmation → the auth
// listener takes over).
//
// This file exists because expo-router resolves the redirect URL as a PATH. With
// no route named auth-callback it rendered "Unmatched route" over the top of a
// flow that was otherwise working — the session was being established behind a
// 404. The route is the fix; the spinner is just what the user sees for the
// moment before the redirect lands.
export default function AuthCallbackScreen() {
  const { colors } = useTheme();
  return (
    <View style={[styles.fill, { backgroundColor: colors.background }]}>
      <ActivityIndicator color={colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
