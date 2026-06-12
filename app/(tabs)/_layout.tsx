import { useEffect, useRef, useState } from 'react';
import { withLayoutContext } from 'expo-router';
import { TouchableOpacity, View, StyleSheet, Keyboard, Animated, Dimensions, Image, Text } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useProfile } from '../../contexts/ProfileContext';
import {
  createMaterialTopTabNavigator,
  type MaterialTopTabNavigationOptions,
  type MaterialTopTabNavigationEventMap,
  type MaterialTopTabBarProps,
} from '@react-navigation/material-top-tabs';
import type { ParamListBase, TabNavigationState } from '@react-navigation/native';
import { GRADIENTS, SHADOWS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { PagerContext, TabSwipeContext, noteTabSwipe } from '../../contexts/PagerContext';
import { useListenMode } from '../../contexts/ListenModeContext';

// Land on Home, not the story camera, even though the camera is declared first
// (so it sits to the LEFT of Home in the pager — swipe right from Home to reach it).
export const unstable_settings = { initialRouteName: 'index' };

const SCREEN_W = Dimensions.get('window').width;

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

function TabBar({ state, navigation, position }: MaterialTopTabBarProps) {
  const insets = useSafeAreaInsets();
  const { profile } = useProfile();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { listenMode } = useListenMode();

  // Listen mode (Music tab): the bar smoothly fades out (with a slight downward
  // drift) and stops catching touches; toggling off fades it right back.
  const listenFade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.timing(listenFade, {
      toValue: listenMode ? 0 : 1,
      duration: 350,
      useNativeDriver: true,
    }).start();
  }, [listenMode, listenFade]);
  const listenDrift = listenFade.interpolate({ inputRange: [0, 1], outputRange: [24, 0] });

  // The bar is an absolute overlay so the pager fills the FULL screen — that's
  // what makes the story camera edge-to-edge with no reserved (gray) slot. While
  // dragging Home(1)→camera(0) it slides off to the right, glued to Home, so the
  // camera never shows it. Other tabs (position >= 1) keep it at rest. Other tabs'
  // content clears it via the navigator's sceneContainerStyle paddingBottom.
  const translateX = position.interpolate({
    inputRange: [0, 1],
    outputRange: [SCREEN_W, 0],
    extrapolate: 'clamp',
  });

  return (
    <Animated.View
      pointerEvents={listenMode ? 'none' : 'auto'}
      style={[styles.bar, styles.barOverlay, { height: 68 + insets.bottom, paddingBottom: insets.bottom, opacity: listenFade, transform: [{ translateX }, { translateY: listenDrift }] }]}
    >
      {state.routes.map((route, index) => {
        if (route.name === 'story-camera') return null;
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
                <Ionicons name="add" size={28} color="#fff" />
              </LinearGradient>
            </TouchableOpacity>
          );
        }

        // Profile tab shows the user's own avatar (live via ProfileContext) instead
        // of a generic icon — ringed in the accent colour when it's the active tab.
        if (route.name === 'profile') {
          return (
            <TouchableOpacity key={route.key} style={styles.tabItem} onPress={onPress} activeOpacity={0.7}>
              <View style={[styles.avatarRing, focused && styles.avatarRingActive]}>
                {profile?.avatar_url ? (
                  <Image source={{ uri: profile.avatar_url }} style={styles.avatarImg} />
                ) : (
                  <LinearGradient colors={GRADIENTS.primary} style={styles.avatarImg}>
                    <Text style={styles.avatarInitial}>
                      {(profile?.display_name || profile?.username || '?').charAt(0).toUpperCase()}
                    </Text>
                  </LinearGradient>
                )}
              </View>
            </TouchableOpacity>
          );
        }

        const icon = ICONS[route.name];
        return (
          <TouchableOpacity key={route.key} style={styles.tabItem} onPress={onPress} activeOpacity={0.7}>
            <Ionicons
              name={focused ? icon[0] : icon[1]}
              size={26}
              color={focused ? colors.primary : colors.textTertiary}
            />
          </TouchableOpacity>
        );
      })}
    </Animated.View>
  );
}

export default function TabLayout() {
  const [swiping, setSwiping] = useState(false);
  // Slideshow carousels flip this off while you swipe between slides so the swipe
  // doesn't bubble up and change tabs (re-enabled when the gesture ends).
  const [swipeEnabled, setSwipeEnabled] = useState(true);
  // Listen mode locks the pager to the Music tab — no tab swipes until exit
  // (Music's internal pill swipes are its own PanResponder, unaffected).
  const { listenMode } = useListenMode();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <PagerContext.Provider value={swiping}>
     <TabSwipeContext.Provider value={setSwipeEnabled}>
      <MaterialTopTabs
        initialRouteName="index"
        tabBarPosition="bottom"
        tabBar={(props) => <TabBar {...props} />}
        // Bar is an overlay (pager is full-screen), so inset each tab's content by
        // the bar height via sceneStyle. The camera screen uses an absolute-fill
        // root, which ignores this padding and stays edge-to-edge.
        // sceneStyle's backgroundColor matters: the bar-height padding strip at the
        // bottom is normally covered by the bar overlay, but when Listen mode fades
        // the bar away the pager's default (white) background would show through.
        screenOptions={{ swipeEnabled: swipeEnabled && !listenMode, sceneStyle: { paddingBottom: 68 + insets.bottom, backgroundColor: colors.background } }}
        screenListeners={{
          // Pause mid-swipe work (video autoplay, caption focus) until the page
          // settles. noteTabSwipe feeds the guardPress() tap suppressor — taps
          // are filtered at the press handlers, NEVER by blocking touches, so
          // rapid consecutive swipes always reach the pager.
          swipeStart: () => { setSwiping(true); noteTabSwipe(true); Keyboard.dismiss(); },
          swipeEnd: () => { setSwiping(false); noteTabSwipe(false); },
        }}
      >
        {/* Live camera, page 0 (LEFT of Home) — swipe right off Home reveals it.
            CameraView stays mounted (active only when focused) so swiping never
            mounts/unmounts it (that froze the app before). */}
        <MaterialTopTabs.Screen name="story-camera" />
        <MaterialTopTabs.Screen name="index" />
        <MaterialTopTabs.Screen name="explore" />
        {/* Create screen: swipe is controlled from within (post.tsx) — on only in
            the image/video picker, and off while touching the camera roll or the
            cropper so those gestures never change tabs. */}
        <MaterialTopTabs.Screen name="post" />
        <MaterialTopTabs.Screen name="music" />
        {/* Profile drives the outer swipe via TabSwipeContext: ON while its
            Posts sub-tab is active (so a rightward drag is the REAL pager
            drag to Music — live finger tracking), OFF on the other sub-tabs
            (their swipes belong to profile's fling stepper). */}
        <MaterialTopTabs.Screen name="profile" />
      </MaterialTopTabs>
     </TabSwipeContext.Provider>
    </PagerContext.Provider>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: c.surface,
    borderTopColor: c.border,
    borderTopWidth: 0.5,
    paddingTop: 6,
    overflow: 'visible',
    elevation: 0,
  },
  barOverlay: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // 26px avatar inside a 32px ring (transparent when inactive so there's no
  // layout shift between states), matching the 26px icon footprint of the others.
  avatarRing: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  avatarRingActive: { borderColor: c.primary },
  avatarImg: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: c.surfaceLight,
  },
  avatarInitial: { color: '#fff', fontSize: 12, fontWeight: '700' },
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
    shadowColor: c.primary,
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 10,
  },
});
