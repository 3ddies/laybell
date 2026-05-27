import { View, Text, StyleSheet } from 'react-native';
import { COLORS } from '../../constants/theme';

export default function HomeScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>Home</Text>
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