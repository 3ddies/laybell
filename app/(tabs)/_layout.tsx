import { Tabs } from 'expo-router';
import { COLORS } from '../../constants/theme';
import { Text } from 'react-native';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: COLORS.background },
        tabBarStyle: {
          backgroundColor: COLORS.surface,
          borderTopColor: COLORS.border,
          borderTopWidth: 0.5,
          height: 60,
          paddingBottom: 8,
        },
        tabBarActiveTintColor: COLORS.primary,
        tabBarInactiveTintColor: COLORS.textTertiary,
        tabBarShowLabel: false,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          tabBarIcon: ({ color }) => <Text style={{ fontSize: 22, color }}>⌂</Text>,
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          tabBarIcon: ({ color }) => <Text style={{ fontSize: 22, color }}>⌕</Text>,
        }}
      />
      <Tabs.Screen
        name="post"
        options={{
          tabBarIcon: ({ color }) => (
            <Text style={{ fontSize: 28, color: COLORS.text, fontWeight: '300' }}>+</Text>
          ),
        }}
      />
      <Tabs.Screen
        name="music"
        options={{
          tabBarIcon: ({ color }) => <Text style={{ fontSize: 22, color }}>♪</Text>,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          tabBarIcon: ({ color }) => <Text style={{ fontSize: 22, color }}>◯</Text>,
        }}
      />
    </Tabs>
  );
}