import { View, Text, StyleSheet } from 'react-native';
import { COLORS } from '../../constants/theme';

export default function ProfileScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>Profile</Text>
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
    fontSize: 24,
    fontWeight: 'bold',
  },
});