import { Component, ReactNode } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { COLORS, SPACING } from '../constants/theme';

// Catches render/runtime errors in its subtree and shows the message inline
// instead of letting the whole screen crash.
export default class ErrorBoundary extends Component<
  { children: ReactNode; label?: string },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <ScrollView contentContainerStyle={styles.wrap}>
          <Text style={styles.title}>{this.props.label ?? 'Something went wrong'}</Text>
          <Text style={styles.msg}>{this.state.error.message}</Text>
        </ScrollView>
      );
    }
    return this.props.children as any;
  }
}

const styles = StyleSheet.create({
  wrap: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: SPACING.lg, gap: SPACING.sm },
  title: { color: COLORS.text, fontSize: 15, fontWeight: '700', textAlign: 'center' },
  msg: { color: COLORS.textSecondary, fontSize: 13, textAlign: 'center' },
});
