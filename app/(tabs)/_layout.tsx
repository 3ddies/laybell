import { useEffect, useRef, useState } from 'react';
import { withLayoutContext } from 'expo-router';
import { View, StyleSheet, Keyboard, Animated, Dimensions, Image, Text, PanResponder, Platform } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
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
// One shared duration for the drag `hover` + `dragging` handoff animations. They
// must use the SAME curve so a landed tab's active value never dips (no blink).
const HANDOFF_MS = 200;

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

// A single tab slot. Its look (scale, lift, active/inactive blend) is driven
// CONTINUOUSLY off the pager's `position` so everything glides while you swipe
// between pages instead of snapping at the end — that's what makes the bar feel
// animated rather than just stateful. `r` is the slot's index in the FULL route
// list (so it lines up with `position`, which counts the hidden camera as 0).
function TabSlot({
  route, r, hover, dragging, position, profile, colors, styles, postCircleColor,
}: {
  route: MaterialTopTabBarProps['state']['routes'][number];
  r: number;
  hover: Animated.Value;
  dragging: Animated.Value;
  position: MaterialTopTabBarProps['position'];
  profile: ReturnType<typeof useProfile>['profile'];
  colors: ThemePalette;
  styles: ReturnType<typeof makeStyles>;
  // A disc tone slightly darker than the frosted bar (theme-derived in TabBar).
  postCircleColor: string;
}) {
  // "Active-ness" of this slot, 0→1, from two sources:
  //  • near  — pager proximity (1 when centred on this tab), so it glides while
  //            you swipe between pages instead of snapping at the end;
  //  • hover  — drag feedback: the tab the finger is over during a bar drag.
  // While a bar drag is in progress (`dragging`→1) the pager-driven `near`
  // highlight is suppressed, so the tab you're ON goes dark and ONLY the tab
  // tracking your finger lights up.
  const near = position.interpolate({ inputRange: [r - 1, r, r + 1], outputRange: [0, 1, 0], extrapolate: 'clamp' });
  const active = Animated.add(Animated.multiply(near, Animated.subtract(1, dragging)), hover);
  const scale = active.interpolate({ inputRange: [0, 1], outputRange: [1, 1.16], extrapolate: 'clamp' });
  const lift = active.interpolate({ inputRange: [0, 1], outputRange: [0, -4], extrapolate: 'clamp' });
  const fillOpacity = active.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: 'clamp' });
  const outlineOpacity = active.interpolate({ inputRange: [0, 1], outputRange: [1, 0], extrapolate: 'clamp' });

  // Center create button: a disc slightly darker than the bar at rest. When you're
  // ON the tab it cross-fades to an inverted, high-contrast disc — colors.text fill
  // + a colors.background "+" (white disc/black + in dark & grey, black disc/white +
  // in light). The inversion is ACTIVE-ONLY (driven by fillOpacity), not permanent.
  if (route.name === 'post') {
    return (
      <View style={styles.tabItem}>
        <Animated.View style={[styles.postWrap, { transform: [{ translateY: lift }, { scale }] }]}>
          <View style={styles.postBtnStack}>
            <View style={[styles.postBtn, { backgroundColor: postCircleColor }]}>
              <Ionicons name="add" size={28} color={colors.textSecondary} />
            </View>
            <Animated.View style={[StyleSheet.absoluteFill, styles.postBtn, { backgroundColor: colors.text, opacity: fillOpacity }]}>
              <Ionicons name="add" size={28} color={colors.background} />
            </Animated.View>
          </View>
        </Animated.View>
      </View>
    );
  }

  // Profile: live avatar; the accent ring fades IN as the tab becomes active
  // (cross-faded via opacity so there's no hard border snap).
  if (route.name === 'profile') {
    return (
      <View style={styles.tabItem}>
        <Animated.View style={{ transform: [{ translateY: lift }, { scale }] }}>
          <View style={styles.avatarRing}>
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
          <Animated.View pointerEvents="none" style={[styles.avatarRingActive, { opacity: fillOpacity }]} />
        </Animated.View>
      </View>
    );
  }

  // Icon tabs (Home / Explore / Music): the filled and outline glyphs are stacked
  // and cross-faded by active-ness, so the icon "fills in" smoothly mid-swipe.
  const icon = ICONS[route.name];
  return (
    <View style={styles.tabItem}>
      <Animated.View style={[styles.iconWrap, { transform: [{ translateY: lift }, { scale }] }]}>
        <Animated.View style={{ opacity: outlineOpacity }}>
          <Ionicons name={icon[1]} size={26} color={colors.textTertiary} />
        </Animated.View>
        <Animated.View style={[styles.iconOverlay, { opacity: fillOpacity }]}>
          <Ionicons name={icon[0]} size={26} color={colors.text} />
        </Animated.View>
      </Animated.View>
    </View>
  );
}

function TabBar({ state, navigation, position }: MaterialTopTabBarProps) {
  const insets = useSafeAreaInsets();
  const { profile } = useProfile();
  const { colors, mode } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { listenMode } = useListenMode();

  // True iOS tab-bar look: the native "chrome material" blur — the exact frosted
  // translucency UIKit uses for bars — with NO heavy tint on top, so the material
  // (and whatever shows behind it) reads through like a real iOS bar. On Android
  // (no system materials) we fall back to a regular blur + a subtle tint wash.
  const isLight = mode === 'light';
  // Post disc: a step DARKER than the frosted bar. In dark/grey the page
  // background sits below the bar's surface tone; in light the background is
  // lighter than the bar, so use the border tone for a subtly darker disc.
  const postCircleColor = isLight ? colors.border : colors.background;
  const blurTint = isLight ? 'systemChromeMaterialLight' : 'systemChromeMaterialDark';
  const androidWash = isLight ? 'rgba(234,232,227,0.7)' : mode === 'grey' ? 'rgba(31,30,28,0.7)' : 'rgba(17,17,17,0.7)';

  // The camera lives at route 0 but isn't a button — the visible bar is every
  // other route, kept paired with its real route index so `position` lines up.
  const visible = state.routes
    .map((route, index) => ({ route, index }))
    .filter((v) => v.route.name !== 'story-camera');

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

  // The swipe-land haptic now fires NATIVELY from react-native-pager-view (see
  // patches/react-native-pager-view+*.patch) at the pager's own commit moment —
  // instant and consistent on every swipe, with no JS prediction needed.

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

  // ----- Drag-and-hold to navigate -----------------------------------------
  // A single PanResponder owns the whole bar. It captures every touch on press
  // (deterministic grant→release for taps AND drags — no native gesture state
  // machine to get stuck, so spamming/mixing taps stays reliable), maps the
  // finger's pageX to a slot, lights up the hovered tab as you slide, and on
  // release navigates to whatever tab you lifted off on. A tap is just the
  // zero-distance case. The bar spans the full width from x=0, so pageX maps
  // straight to a slot. Persistent refs keep the handlers' data fresh without
  // ever rebuilding the responder.
  const barWRef = useRef(SCREEN_W);
  const dragSlot = useRef(-1);
  const hoversRef = useRef<Animated.Value[] | null>(null);
  if (!hoversRef.current) hoversRef.current = visible.map(() => new Animated.Value(0));
  const hovers = hoversRef.current;
  // 0 normally, 1 while a bar drag is active — slots multiply their pager-driven
  // highlight by (1 - dragging), so the current tab goes dark during a drag and
  // only the hovered tab (driven by `hovers`) shows.
  const dragging = useRef(new Animated.Value(0)).current;
  // A SINGLE, always-reset timer for the post-release "hold": keep the tapped tab
  // lit until the pager slides onto it, then hand off to `near` (pager position).
  // Every new interaction cancels the pending one, so spamming tabs can never
  // leave a stale hold or a stuck `dragging` — which is what let the highlight
  // desync from the displayed page. When the timer fires it fully resets, so the
  // highlight always falls back to `near` = the page actually on screen.
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHold = () => { if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; } };
  useEffect(() => cancelHold, []); // clear on unmount

  // commit() needs the live route list / focused index / navigation, so it's
  // kept in a ref the render refreshes — the responder below reads it.
  // Returns how many tabs the navigation jumped (0 if it didn't navigate), so
  // the release can hold the dim for as long as the pager takes to slide there.
  const commitRef = useRef<(slot: number) => number>(() => 0);
  commitRef.current = (slot: number) => {
    const target = visible[slot];
    if (!target) return 0;
    const focused = state.index === target.index;
    const event = navigation.emit({ type: 'tabPress', target: target.route.key, canPreventDefault: true });
    if (!focused && !event.defaultPrevented) {
      const jump = Math.abs(target.index - state.index);
      navigation.navigate(target.route.name);
      return jump;
    }
    return 0;
  };

  const panRef = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false, // never yield mid-drag
      onPanResponderGrant: (e) => {
        const slot = slotFromX(e.nativeEvent.pageX);
        dragSlot.current = slot;
        cancelHold(); // a new grab cancels any pending release-hold
        setDragging(1); // dim the current tab; only the hovered one lights up
        setHover(slot);
      },
      onPanResponderMove: (e) => {
        const slot = slotFromX(e.nativeEvent.pageX);
        if (slot !== dragSlot.current) {
          dragSlot.current = slot;
          setHover(slot);
        }
      },
      onPanResponderRelease: (e) => {
        const slot = slotFromX(e.nativeEvent.pageX);
        const jump = commitRef.current(slot);
        dragSlot.current = -1;
        cancelHold(); // supersede any hold still pending from an earlier tap
        if (jump > 0) {
          // Navigated. Keep ONLY the target lit and the current tab dimmed until
          // the pager has actually slid onto the new tab — THEN drop the dim so
          // `near` (pager position) takes over with no flash back to the old tab.
          // The hold scales with the jump distance (a far jump animates longer);
          // holding a touch too long is invisible, dropping early is the glitch.
          // ONE timer only (rescheduled on every tap) — the previous hold is always
          // cancelled above, so `dragging`/`hover` can't get stuck out of sync.
          setHover(slot);
          const holdMs = Math.min(320 + jump * 150, 1000);
          holdTimerRef.current = setTimeout(() => {
            holdTimerRef.current = null;
            setDragging(0);
            clearHover();
          }, holdMs);
        } else {
          // Released on the current tab — restore it immediately (position is
          // already here, so un-dimming is seamless).
          setDragging(0);
          clearHover();
        }
      },
      onPanResponderTerminate: () => {
        dragSlot.current = -1;
        cancelHold();
        setDragging(0);
        clearHover();
      },
    }),
  );

  // Defined after the responder but hoisted (function declarations), so the
  // responder's handlers close over them. All read stable refs.
  function slotFromX(pageX: number) {
    const n = hovers.length;
    const iw = (barWRef.current || SCREEN_W) / n;
    return Math.max(0, Math.min(n - 1, Math.floor(pageX / iw)));
  }
  // `hover`, `clearHover` and `setDragging` MUST share one timing curve. The
  // active value is `near*(1-dragging) + hover`; on the landed tab (near=1) that
  // is `(1-dragging) + hover`, which only stays flat at 1 if dragging and the
  // target's hover move in perfect lockstep. A curve mismatch (the old spring vs
  // timing) made it dip mid-handoff → the icon/disc blinked after landing.
  function setHover(slot: number) {
    hovers.forEach((v, i) =>
      Animated.timing(v, { toValue: i === slot ? 1 : 0, duration: HANDOFF_MS, useNativeDriver: true }).start(),
    );
  }
  function clearHover() {
    hovers.forEach((v) => Animated.timing(v, { toValue: 0, duration: HANDOFF_MS, useNativeDriver: true }).start());
  }
  function setDragging(to: number) {
    Animated.timing(dragging, { toValue: to, duration: HANDOFF_MS, useNativeDriver: true }).start();
  }

  return (
    <Animated.View
      pointerEvents={listenMode ? 'none' : 'auto'}
      style={[styles.bar, styles.barOverlay, { height: 68 + insets.bottom, paddingBottom: insets.bottom, opacity: listenFade, transform: [{ translateX }, { translateY: listenDrift }] }]}
    >
      {/* Native iOS chrome-material blur fills the bar (behind the row). The bar
          stays overflow-visible so the center button can lift above the top edge.
          Android can't render system materials, so it gets a tint wash instead. */}
      <BlurView tint={blurTint} intensity={100} style={styles.blurFill} />
      {Platform.OS === 'android' && (
        <View pointerEvents="none" style={[styles.blurFill, { backgroundColor: androidWash }]} />
      )}
      <Animated.View
        style={styles.row}
        onLayout={(e) => { barWRef.current = e.nativeEvent.layout.width; }}
        {...panRef.current.panHandlers}
      >
        {visible.map(({ route, index }, slot) => (
          <TabSlot
            key={route.key}
            route={route}
            r={index}
            hover={hovers[slot]}
            dragging={dragging}
            position={position}
            profile={profile}
            colors={colors}
            styles={styles}
            postCircleColor={postCircleColor}
          />
        ))}
      </Animated.View>
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
    // Flat, full-width, like a native iOS tab bar: the frosted BlurView child IS
    // the background (transparent here), with just a hairline top separator — no
    // rounded corners, no drop shadow. Stays overflow-visible for the center btn.
    backgroundColor: 'transparent',
    borderTopColor: c.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 6,
    overflow: 'visible',
  },
  barOverlay: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  // The blur fills the whole bar, flush to the screen edges (square corners).
  blurFill: { ...StyleSheet.absoluteFillObject },
  // Holds the slots in a row. onLayout here measures the bar width for slot math.
  row: { flex: 1, flexDirection: 'row', position: 'relative' },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Stacks the outline + filled glyphs so they can be cross-faded in place.
  iconWrap: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  iconOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  // 26px avatar inside a 32px footprint, matching the icon tabs.
  avatarRing: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Accent ring overlaid and faded in as the profile tab becomes active.
  avatarRingActive: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: c.text,
  },
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
  // 58×58 relative box so the active inverted disc can absolute-overlay the base
  // disc exactly (both centered here).
  postBtnStack: { width: 58, height: 58 },
  postBtn: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    ...SHADOWS.sm,
  },
});
