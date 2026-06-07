import { useState } from 'react';
import { withLayoutContext } from 'expo-router';
import { TouchableOpacity, View, StyleSheet, Keyboard } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  createMaterialTopTabNavigator,
  type MaterialTopTabNavigationOptions,
  type MaterialTopTabNavigationEventMap,
  type MaterialTopTabBarProps,
} from '@react-navigation/material-top-tabs';
import type { ParamListBase, TabNavigationState } from '@react-navigation/native';
import { COLORS, GRADIENTS, SHADOWS } from '../../constants/theme';
import { PagerContext } from '../../contexts/PagerContext';

// Wrap the Material Top Tabs navigator so Expo Router drives it with file-based
// routes. Material Top Tabs is backed by the native react-native-pager-view, so
// swiping between tabs shows the adjacent screen sliding in (real preview, not
// black) and gesture arbitration vs. each screen's scroll views is handled natively.
const { Navigator } = createMaterialTopTabNavigator();
const MaterialTopTabs = withLayoutContext<
  MaterialTopTabNavigationOptions,
  typeof Navigator,
  TabNavigationState<ParamListBase>,
  MaterialTopTabNavigationEventMap
>(Navigator);

// Active/inactive Ionicons per route. `post` is rendered as a center gradient button.
const ICONS: Record<string, [keyof typeof Ionicons.glyphMap, keyof typeof Ionicons.glyphMap]> = {
  index: ['home', 'home-outline'],
  explore: ['search', 'search-outline'],
  music: ['musical-notes', 'musical-notes-outline'],
  profile: ['person', 'person-outline'],
};

function TabBar({ state, navigation }: MaterialTopTabBarProps) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.bar, { height: 68 + insets.bottom, paddingBottom: insets.bottom }]}>
      {state.routes.map((route, index) => {
        const focused = state.index === index;

        const onPress = () => {
          const event = navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
          });
          if (!focused && !event.defaultPrevented) {
            navigation.navigate(route.name);
          }
        };

        if (route.name === 'post') {
          return (
            <TouchableOpacity key={route.key} style={styles.postWrap} onPress={onPress} activeOpacity={0.85}>
              <LinearGradient colors={GRADIENTS.primary} style={styles.postBtn}>
                <Ionicons name="add" size={28} color={COLORS.text} />
              </LinearGradient>
            </TouchableOpacity>
          );
        }

        const icon = ICONS[route.name];
        return (
          <TouchableOpacity key={route.key} style={styles.tabItem} onPress={onPress} activeOpacity={0.7}>
            <Ionicons
              name={focused ? icon[0] : icon[1]}
              size={26}
              color={focused ? COLORS.primary : COLORS.textTertiary}
            />
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export default function TabLayout() {
  const [swiping, setSwiping] = useState(false);

  return (
    <PagerContext.Provider value={swiping}>
      <MaterialTopTabs
        tabBarPosition="bottom"
        tabBar={(props) => <TabBar {...props} />}
        screenOptions={{ swipeEnabled: true }}
        screenListeners={{
          // Pause mid-swipe work (video autoplay, caption focus) until the page settles.
          swipeStart: () => { setSwiping(true); Keyboard.dismiss(); },
          swipeEnd: () => setSwiping(false),
        }}
      >
        <MaterialTopTabs.Screen name="index" />
        <MaterialTopTabs.Screen name="explore" />
        {/* Create screen: swipe off so dragging/pinching the cropper never
            swipes to an adjacent tab. */}
        <MaterialTopTabs.Screen name="post" options={{ swipeEnabled: false }} />
        <MaterialTopTabs.Screen name="music" />
        {/* Profile owns its horizontal swipes via its own inner pager (incl. a
            "go to Music" dismiss page), so the outer swipe stays off here. */}
        <MaterialTopTabs.Screen name="profile" options={{ swipeEnabled: false }} />
      </MaterialTopTabs>
    </PagerContext.Provider>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: COLORS.surface,
    borderTopColor: COLORS.border,
    borderTopWidth: 0.5,
    paddingTop: 6,
    overflow: 'visible',
    elevation: 0,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  postWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -12,
  },
  postBtn: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    ...SHADOWS.md,
    shadowColor: COLORS.primary,
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 10,
  },
});
