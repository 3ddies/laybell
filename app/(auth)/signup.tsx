import { View, Text, StyleSheet } from 'react-native';
import { COLORS } from '../../constants/theme';

export default function SignupScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>Sign Up — coming soon</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    color: COLORS.text,
    fontSize: 18,
  },
});