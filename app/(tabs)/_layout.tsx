import { useEffect, useRef, useState } from 'react';
import { withLayoutContext } from 'expo-router';
import { View, StyleSheet, Keyboard, Animated, Dimensions, Image, Text, PanResponder, Platform, Pressable } from 'react-native';
import { tabTick } from '../../lib/haptics';
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
import { TabSwipeContext, noteTabSwipe, useSearchLocked } from '../../contexts/PagerContext';
import { feedChrome, setFeedChromeHidden } from '../../lib/feedChrome';
import { useListenMode } from '../../contexts/ListenModeContext';

// Land on Home, not the story camera, even though the camera is declared first
// (so it sits to the LEFT of Home in the pager — swipe right from Home to reach it).
export const unstable_settings = { initialRouteName: 'index' };

const SCREEN_W = Dimensions.get('window').width;
// How long the bar's highlight takes to glide from the old tab to the new one.
// A bar press now swaps the page INSTANTLY (screenOptions.animationEnabled:
// false), so this glide is the ONLY thing still animating on a tap — which is
// exactly Instagram's shape: the screen cuts on a single frame while the bar's
// active indicator eases across behind it. 140ms ≈ the 7 frames Instagram's own
// indicator takes in the reference recording; 200 read as a slight drag.
const HANDOFF_MS = 140;
// Margin before the bar hands its highlight back to the pager-driven `near`.
// The `hover` timings run natively (UI thread) while the handoff is a JS
// timeout, so a few ms of skew is normal; waiting them out means `hover` is
// provably at its target when we swap drivers, and the swap stays invisible.
const HANDOFF_SETTLE_MS = HANDOFF_MS + 60;

// Backstop window after the tab tree (re)mounts during which an UNGESTURED
// multi-page jump is treated as the native-pager "login teleport" glitch and
// snapped back. The tree remounts on every login / account switch (app/_layout
// keys it by user id), which is exactly when the freshly re-created pager
// mis-fires. This is now only a SECONDARY guard — the primary signal is
// "has the user actually driven the pager yet?" (hasInteractedRef): a pure
// wall-clock window was the leak, because a slow login could push the spurious
// first settle PAST the window, at which point it was accepted as the real page
// and the user landed on Profile. Kept (and widened) as belt-and-suspenders for
// the rare case where a glitch fires just after the user's first real touch.
const MOUNT_GUARD_MS = 2500;

// The BAR's last programmatic navigation: which route index it targeted and
// when. The teleport guard exempts bar-driven jumps (a tap/flick may
// legitimately move several tabs) — but the 2026-07-21 recording showed the
// corrupted post-login pager OVERSHOOTING a bar flick (low-thumb swipes land
// on the bar band): the bar targeted the ADJACENT tab, the broken pager
// settled on Profile, and the plain "a tabPress happened recently" exemption
// swallowed it. Recording the actual TARGET lets the guard verify a
// bar-driven settle instead of trusting it: land anywhere else → redirect to
// where the bar meant to go.
const lastBarNav = { index: -1, at: 0 };

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
  route, r, hover, dragging, position, focus, profile, colors, styles, postCircleColor, chip, chipBg,
}: {
  route: MaterialTopTabBarProps['state']['routes'][number];
  r: number;
  hover: Animated.Value;
  dragging: Animated.Value;
  position: MaterialTopTabBarProps['position'];
  /** Android only: per-slot 0/1 highlight driven by the settled route index.
   *  When present it REPLACES the pager-position term entirely (see `active`). */
  focus?: Animated.Value;
  profile: ReturnType<typeof useProfile>['profile'];
  colors: ThemePalette;
  styles: ReturnType<typeof makeStyles>;
  // A disc tone slightly darker than the frosted bar (theme-derived in TabBar).
  postCircleColor: string;
  // Reactive chrome (0 = full bar, 1 = condensed): each slot grows a floating
  // circular chip behind its icon as the bar's frosted panel dissolves.
  chip: Animated.AnimatedInterpolation<number>;
  chipBg: string;
}) {
  // "Active-ness" of this slot, 0→1, from two sources:
  //  • near  — pager proximity (1 when centred on this tab), so it glides while
  //            you swipe between pages instead of snapping at the end;
  //  • hover  — bar feedback: the tab the finger is over during a press/drag.
  // `dragging` is a hard 0/1 switch between the two (see beginHighlight): while
  // the bar owns the highlight the pager-driven `near` term is zeroed out, so
  // the tab you're ON goes dark and ONLY the tab tracking your finger lights up
  // — and the page underneath is free to cut to its destination unnoticed.
  const near = position.interpolate({ inputRange: [r - 1, r, r + 1], outputRange: [0, 1, 0], extrapolate: 'clamp' });
  // ANDROID: `focus` replaces the whole pager-driven term. `position` is a
  // CONTINUOUS value, and with animationEnabled:false a tab press calls
  // setPageWithoutAnimation — on which ViewPager2 emits onPageScroll for every
  // intermediate page it passes through. Home→Profile therefore sweeps position
  // across Explore and Music, lighting and scaling each in turn: the flashing,
  // wrong-tab, growing icons. `focus` is a per-slot 0/1 value driven by the
  // SETTLED route index, so it cannot pass through anything.
  const active = focus ?? Animated.add(Animated.multiply(near, Animated.subtract(1, dragging)), hover);
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
          <Animated.View pointerEvents="none" shouldRasterizeIOS style={[styles.chip, { opacity: chip, backgroundColor: chipBg }]} />
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
        <Animated.View pointerEvents="none" shouldRasterizeIOS style={[styles.chip, { opacity: chip, backgroundColor: chipBg }]} />
        <Animated.View style={{ opacity: outlineOpacity }}>
          {/* textSecondary (not tertiary): the airier glass needs icons that
              carry their own contrast instead of borrowing it from the panel. */}
          <Ionicons name={icon[1]} size={26} color={colors.textSecondary} />
        </Animated.View>
        {/* Condensed mode brightens inactive outlines to full text color so
            they pop against the feed (opacity = chip × inactive-ness). */}
        <Animated.View style={[styles.iconOverlay, { opacity: Animated.multiply(chip, outlineOpacity) }]}>
          <Ionicons name={icon[1]} size={26} color={colors.text} />
        </Animated.View>
        <Animated.View style={[styles.iconOverlay, { opacity: fillOpacity }]}>
          <Ionicons name={icon[0]} size={26} color={colors.text} />
        </Animated.View>
      </Animated.View>
    </View>
  );
}

function TabBar({ state, navigation, position, jumpTo }: MaterialTopTabBarProps) {
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
  // The bar's surface is a VERTICAL scrim: solid at the very bottom, melting
  // into transparency toward its top edge — no hard border, the fade IS the
  // edge. (iOS layers it over a soft uniform blur; Android uses the scrim
  // alone, which reads the same.)
  const bgRgb = isLight ? '242,241,237' : mode === 'grey' ? '22,21,20' : '9,9,9';
  // A continuous ease from clear to solid — five stops approximate a smooth
  // curve so there's no visible band where "transparent" meets "solid" (the
  // old 0.92→1.0 jump read as a stationary dark bar under a glass sheet).
  const scrimColors = [
    `rgba(${bgRgb},0)`, `rgba(${bgRgb},0.14)`, `rgba(${bgRgb},0.45)`, `rgba(${bgRgb},0.8)`, `rgba(${bgRgb},0.98)`,
  ] as const;

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

  // Reactive chrome: instead of sliding away, the bar CONDENSES — the frosted
  // panel, wash and top hairline dissolve while a floating circular chip grows
  // behind each icon, leaving five glassy buttons hovering over the feed. A
  // slight downward drift sells the "detach" moment. Everything rides the same
  // gesture-following value, so a slow scroll morphs it gradually and a fling
  // snaps it — and the icons stay exactly where your thumb knows them.
  // The panel is ONE continuous frosted surface that simply fades — a single
  // BlurView so the connected bar is seamless (two halves could never blend
  // into one uniform material). The fade front-loads slightly (done by ~85%
  // of the gesture) so the bar feels present the moment you call it back.
  const panelFade = feedChrome.interpolate({ inputRange: [0, 0.85, 1], outputRange: [1, 0.06, 0], extrapolate: 'clamp' });
  // The panel also SINKS as it fades — the gradient's solid base recedes below
  // the screen edge like a tide going out, so the transition reads as motion,
  // never as a shaped box dissolving in place.
  const panelSink = feedChrome.interpolate({ inputRange: [0, 1], outputRange: [0, 46], extrapolate: 'clamp' });
  const chip = feedChrome.interpolate({ inputRange: [0.25, 1], outputRange: [0, 1], extrapolate: 'clamp' });
  // As the bar condenses, the icon row DROPS toward the bottom edge of the
  // screen (riding the same gesture-following value), so the chips settle low
  // like they've been set down — and float back up as the bar reassembles.
  // iOS sinks the chips into the home-indicator band — a button-less gesture
  // zone, so nothing fights back. Android's inset band is DIFFERENT under
  // edge-to-edge (SDK 54 enforces it): it holds the real system back/home/
  // recents buttons (3-button nav, ~48dp) or the gesture pill, and the system
  // consumes touches there — chips dropped into it collide and go dead. So on
  // Android the condensed state keeps the small fixed drift only, staying
  // fully above insets.bottom.
  const iconDrop = feedChrome.interpolate({
    inputRange: [0, 1],
    outputRange: [0, Platform.OS === 'ios' && insets.bottom > 0 ? insets.bottom - 2 : 12],
  });
  // Chip fill: a near-solid wash of the theme background — content peeks
  // through the GAPS between chips, not through the chips themselves, so the
  // icons pop instead of blending into the feed.
  // Android draws the chips on an OPAQUE bar base (see barBase below), so the
  // near-black iOS chip washes would vanish into it — use clearly elevated
  // tones there instead.
  const chipBg = Platform.OS === 'android'
    ? (isLight ? 'rgba(255,255,255,0.97)' : mode === 'grey' ? 'rgba(46,44,43,0.97)' : 'rgba(30,30,30,0.97)')
    : (isLight ? 'rgba(242,241,237,0.94)' : mode === 'grey' ? 'rgba(22,21,20,0.92)' : 'rgba(9,9,9,0.9)');

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
  // ANDROID highlight source. One 0/1 value per visible slot, animated straight
  // to its target when the FOCUSED ROUTE settles — never interpolated across a
  // range, so a jump from slot 0 to slot 4 cannot light slots 1-3 on the way.
  // This is what the pager's continuous `position` could not give us: with
  // animationEnabled:false, setPageWithoutAnimation makes ViewPager2 emit
  // onPageScroll for every page it passes through.
  const focusRef = useRef<Animated.Value[] | null>(null);
  if (!focusRef.current) {
    focusRef.current = visible.map((v) => new Animated.Value(v.index === state.index ? 1 : 0));
  }
  const focus = focusRef.current;
  const androidHighlight = Platform.OS === 'android';
  useEffect(() => {
    if (!androidHighlight) return;
    focus.forEach((v, i) => {
      const target = visible[i]?.index === state.index ? 1 : 0;
      Animated.timing(v, { toValue: target, duration: 150, useNativeDriver: true }).start();
    });
    // `visible` is derived from the same route list each render; the settled
    // index is the only thing that should retrigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.index, androidHighlight]);
  // True between a press ending and the highlight being handed back to `near`.
  // A fresh grab clears it, which cancels the pending handoff.
  const releasingRef = useRef(false);
  // Which VISIBLE slot the pager is currently on. The responder below is built
  // once, so (like commitRef) it reads this through a ref the render refreshes.
  // -1 when the focused route isn't a bar slot (the hidden story camera).
  const focusedSlotRef = useRef(-1);
  focusedSlotRef.current = visible.findIndex((v) => v.index === state.index);

  // commit() needs the live route list / focused index / navigation, so it's
  // kept in a ref the render refreshes — the responder below reads it.
  // Returns how many tabs it jumped, or 0 if it didn't navigate at all (already
  // focused, or a screen preventDefault'd the press) — the release only needs to
  // know WHETHER to glide the highlight forward or back.
  const commitRef = useRef<(slot: number) => number>(() => 0);
  commitRef.current = (slot: number) => {
    const target = visible[slot];
    if (!target) return 0;
    const focused = state.index === target.index;
    const event = navigation.emit({ type: 'tabPress', target: target.route.key, canPreventDefault: true });
    if (!focused && !event.defaultPrevented) {
      const jump = Math.abs(target.index - state.index);
      // Remember the intended destination so the teleport guard can VERIFY the
      // settle that follows (see lastBarNav above).
      lastBarNav.index = target.index;
      lastBarNav.at = Date.now();
      // jumpTo, NOT navigation.navigate — this is what makes a press feel
      // instant rather than merely un-animated. navigate() puts a full React
      // pass in front of the page swap: dispatch → re-render every tab screen →
      // paint → and only then does the pager's (passive) effect finally call
      // setPageWithoutAnimation. On a busy JS thread that's the lag you feel on
      // every tap. jumpTo runs the pager command FIRST, synchronously in this
      // release handler, and dispatches the identical CommonActions.navigate
      // afterwards — so the page has already cut by the time React starts
      // rendering it, and a slow screen now lands late INSIDE the new tab
      // instead of holding up the switch.
      jumpTo(target.route.key);
      return jump;
    }
    return 0;
  };
  // Maps a pager-direction flick (+1 = next tab, i.e. finger moved left) to the
  // visible slot adjacent to the CURRENT tab; -1 when there's nowhere to go
  // (edge, or the current page isn't a bar slot — e.g. the camera).
  const flickSlotRef = useRef<(dir: 1 | -1) => number>(() => -1);
  flickSlotRef.current = (dir) => {
    const cur = visible.findIndex((v) => v.index === state.index);
    if (cur < 0) return -1;
    const target = cur + dir;
    return target >= 0 && target < visible.length ? target : -1;
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
        releasingRef.current = false; // a new grab cancels any pending handoff
        beginHighlight(slot); // bar takes the highlight; only the hovered tab lights up
      },
      onPanResponderMove: (e) => {
        const slot = slotFromX(e.nativeEvent.pageX);
        if (slot !== dragSlot.current) {
          dragSlot.current = slot;
          setHover(slot);
        }
      },
      onPanResponderRelease: (e, g) => {
        let slot = slotFromX(e.nativeEvent.pageX);
        let jump = commitRef.current(slot);
        // A pager-shaped FLICK that released on the CURRENT tab's slot: the user
        // was page-swiping with a low thumb (the bar captures the whole bottom
        // band), not working the bar — translate it to the adjacent tab in pager
        // direction (finger left = next tab). Slow drag-and-hold releases never
        // qualify (velocity gate), so the bar's designed feel is unchanged.
        if (jump === 0 && Math.abs(g.vx) >= 0.5 && Math.abs(g.dx) >= 24 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5) {
          const target = flickSlotRef.current(g.vx < 0 ? 1 : -1);
          if (target >= 0) {
            const j = commitRef.current(target);
            if (j > 0) { jump = j; slot = target; }
          }
        }
        dragSlot.current = -1;
        // The page has ALREADY cut to its destination (no pager slide to wait
        // out), so all that's left is gliding the highlight there — or back home
        // when nothing navigated (released on the current tab, or a screen
        // preventDefault'd the press). The old jump-scaled hold is gone with the
        // slide it was covering; a far tab press no longer drags the bar behind.
        setHover(jump > 0 ? slot : focusedSlotRef.current);
        endHighlight();
      },
      onPanResponderTerminate: () => {
        dragSlot.current = -1;
        setHover(focusedSlotRef.current); // glide back to where the pager actually is
        endHighlight();
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
  function setHover(slot: number) {
    hovers.forEach((v, i) =>
      Animated.timing(v, { toValue: i === slot ? 1 : 0, duration: HANDOFF_MS, useNativeDriver: true }).start(),
    );
  }

  // ── Highlight ownership: `near` (pager) ⇄ `hover` (bar) ─────────────────────
  // `active` is `near*(1-dragging) + hover`, so `dragging` is really a SWITCH
  // deciding which of the two owns the highlight. Both handoffs have to be
  // value-preserving or the icon/disc visibly blinks — the long-standing bug in
  // this bar. Snapping `dragging` between 0 and 1 (rather than ramping it, as it
  // once did) is what makes that provable instead of a curve-matching gamble:
  // at every instant exactly ONE driver is live, and we only ever flip while the
  // two agree.
  //
  // Take it: seed the focused slot's `hover` to 1 in the SAME tick `dragging`
  // snaps to 1, and every slot's active value is unchanged (focused: 1*0 + 1 = 1;
  // the rest: 0*0 + 0 = 0). From there only `hover` moves — which is precisely
  // what lets the page cut instantly underneath without the bar twitching:
  // `near` is free to jump while it's being multiplied by zero.
  function beginHighlight(slot: number) {
    dragging.setValue(1);
    const focused = focusedSlotRef.current;
    // setValue also stops any in-flight timing on that value, so a rapid
    // re-press lands on clean state instead of fighting the previous glide.
    hovers.forEach((v, i) => v.setValue(i === focused ? 1 : 0));
    setHover(slot);
  }
  // Give it back: let the glide finish, then drop `dragging` and every `hover`
  // in ONE batch. `near` settled on the new page the moment we navigated, so the
  // target reads 1*0 + 1 before the swap and 1*1 + 0 after — flat across it.
  function endHighlight() {
    releasingRef.current = true;
    setTimeout(() => {
      if (!releasingRef.current) return; // a new press already took the highlight
      releasingRef.current = false;
      dragging.setValue(0);
      hovers.forEach((v) => v.setValue(0));
    }, HANDOFF_SETTLE_MS);
  }

  return (
    <Animated.View
      pointerEvents={listenMode ? 'none' : 'auto'}
      style={[styles.bar, styles.barOverlay, { height: 68 + insets.bottom, paddingBottom: insets.bottom, opacity: listenFade, transform: [{ translateX }, { translateY: listenDrift }] }]}
    >
      {/* The bar's surface: a soft uniform blur (iOS) under a bottom-solid →
          top-transparent scrim of the theme background. The panel has no hard
          top border — the gradient dissolving into the feed IS the edge. It
          still fades out as the bar condenses into chips and back on return;
          icons never move with scroll, only the glass breathes. */}
      {/* Android: the chips sit on an OPAQUE bar base instead of the frosted
          reactive panel. Two reasons: (1) the stationary-chips design the owner
          picked wants a calm solid strip, not content sliding beneath; (2) the
          band would otherwise be a window to whatever is behind the current
          scene — and Eddie's Samsung showed OTHER pager scenes compositing
          there as collapsed strips (StoriesTray/profile sub-tabs bleeding
          through). Opaque base makes the bar deterministic regardless. */}
      {Platform.OS === 'android' && (
        <View pointerEvents="none" style={[styles.blurFill, { backgroundColor: colors.background }]} />
      )}
      {/* Android pins the chrome at the condensed state (lib/feedChrome.ts), so
          the panel would be permanently invisible there — skip compositing it. */}
      {Platform.OS !== 'android' && (
        <Animated.View pointerEvents="none" style={[styles.blurFill, { opacity: panelFade, transform: [{ translateY: panelSink }] }]}>
          {Platform.OS === 'ios' && <BlurView tint={blurTint} intensity={40} style={styles.blurFill} />}
          <LinearGradient colors={scrimColors} locations={[0, 0.28, 0.55, 0.8, 1]} style={styles.blurFill} />
        </Animated.View>
      )}
      {/* ANDROID: no whole-bar PanResponder. It claimed EVERY touch in the
          bottom band unconditionally (onStart*ShouldSet → true) and immediately
          ran beginHighlight, which sets `dragging` = 1 — and slots compute
          `active = near*(1-dragging) + hover`, so the page-derived highlight was
          zeroed on every tab and only the slot under the finger lit up. A page
          swipe with a low thumb therefore lit the WRONG icon, mid-glide, until
          the delayed endHighlight put it back: the flashing half-highlighted
          tab. Android's band is ~116dp (48dp nav inset vs iOS's 34pt indicator)
          and its touch routing lets the bar and the pager both see the gesture,
          which is why it shows there and not on iOS.
          Dropping the responder also stops the bar swallowing page swipes in
          that band — the "swipe didn't register" complaint. Taps are handled
          per-slot below, and with `dragging` never set, `near` alone drives the
          highlight: the lit icon is always the page you are on. */}
      <Animated.View
        style={[styles.row, { transform: [{ translateY: iconDrop }] }]}
        onLayout={(e) => { barWRef.current = e.nativeEvent.layout.width; }}
        {...(Platform.OS === 'android' ? {} : panRef.current.panHandlers)}
      >
        {visible.map(({ route, index }, slot) => {
          const slotEl = (
            <TabSlot
              key={route.key}
              route={route}
              r={index}
              hover={hovers[slot]}
              dragging={dragging}
              position={position}
              focus={androidHighlight ? focus[slot] : undefined}
              profile={profile}
              colors={colors}
              styles={styles}
              postCircleColor={postCircleColor}
              chip={chip}
              chipBg={chipBg}
            />
          );
          if (Platform.OS !== 'android') return slotEl;
          return (
            <Pressable
              key={route.key}
              style={styles.tabItem}
              accessibilityRole="button"
              onPress={() => { tabTick(); commitRef.current(slot); }}
            >
              {slotEl}
            </Pressable>
          );
        })}
      </Animated.View>
    </Animated.View>
  );
}

export default function TabLayout() {
  // NOTE: the "is a swipe in progress" flag deliberately does NOT live here as
  // React state — it's a module store in PagerContext (usePagerSwiping). State
  // here re-rendered the whole navigator at every swipe start/end, racing the
  // native pager mid-gesture (dropped fast swipes, hitchy handoffs).
  // Slideshow carousels flip this off while you swipe between slides so the swipe
  // doesn't bubble up and change tabs (re-enabled when the gesture ends).
  const [swipeEnabled, setSwipeEnabled] = useState(true);
  // Listen mode locks the pager to the Music tab — no tab swipes until exit
  // (Music's internal pill swipes are its own PanResponder, unaffected).
  const { listenMode } = useListenMode();
  // A search field is in use somewhere in the tabs — page swipes are accidental
  // while the keyboard is up, so they stand down until it is released.
  // Ref-counted in PagerContext, so several search screens can't clobber
  // each other's lock.
  const searchLocked = useSearchLocked();
  // Ref mirror so the navigator's `state` settle listener (a closure that can
  // capture a stale render) always sees the live flag — used by the airtight
  // lock below to snap any off-Music settle back while the mode is on.
  const listenModeRef = useRef(listenMode);
  listenModeRef.current = listenMode;
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  // ── Swipe teleport guard ────────────────────────────────────────────────────
  // A finger swipe moves the pager EXACTLY one page. Right after a login/account
  // switch (the whole tree remounts, keyed by user id), the freshly re-created
  // native pager sometimes reports a garbage page for the first gesture — the
  // "swipe left on Home, land on Profile" glitch. Track the last settled index
  // and whether a swipe gesture is in flight; if a swipe "commits" a jump of
  // more than one page, redirect to the ADJACENT page in the swiped direction
  // (where the finger was actually headed). Bar drags and tab taps navigate
  // programmatically (no swipeStart), so multi-tab jumps from those stay exempt.
  const swipingRef = useRef(false);
  const lastSwipeEndAt = useRef(0);
  const settledIndexRef = useRef<number | null>(null);
  // Fresh on every (re)mount — so the extra "spurious jump" correction only runs
  // in the brief window right after a login/account-switch remount (the pager
  // glitch window), never during normal use.
  const mountedAt = useRef(Date.now());
  // Last time a tab was reached via the bar (a drag-release or tap). The bar
  // emits `tabPress`; a native-pager teleport does not — so this lets the guard
  // tell an intentional multi-tab bar jump apart from the glitch.
  const lastTabPressAt = useRef(0);
  // True once the user has ACTUALLY driven the pager (a real swipe or a bar
  // press). Until then there has been no input that could produce a legit
  // multi-tab move, so ANY far ungestured jump is the mount glitch — regardless
  // of how long the (slow) login took to settle. Legit programmatic far-jumps
  // only ever come from stack screens the user reached by interacting, so they
  // always land after this flips true and stay exempt.
  const hasInteractedRef = useRef(false);

  // ── Measured-mount gate ─────────────────────────────────────────────────────
  // The native pager must never initialize against unmeasured geometry: the
  // tab tree (re)mounts during the login transition (app/_layout keys it by
  // user id), and a pager created before its container's real layout comes up
  // with corrupted page offsets — the owner-reported "hypersensitive first
  // swipe" that overshoots to Profile, normalizing only after the glitch
  // forces a relayout. Waiting one frame for a real measured width means the
  // pager's first geometry IS its final geometry. (Width changes later — the
  // reels landscape rotation — only re-render; the navigator is not keyed to
  // the value, so nothing remounts.)
  const [measuredW, setMeasuredW] = useState(0);

  return (
     <TabSwipeContext.Provider value={setSwipeEnabled}>
      <View
        style={{ flex: 1 }}
        onLayout={(e) => {
          const w = Math.round(e.nativeEvent.layout.width);
          if (w > 0) setMeasuredW((prev) => (prev === w ? prev : w));
        }}
      >
      {measuredW > 0 && (
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
        // animationEnabled:false makes every PROGRAMMATIC page change a cut
        // instead of a slide (react-native-tab-view swaps setPage for
        // setPageWithoutAnimation) — bar presses, deep links and the guards
        // below all land instantly, the way Instagram's tab bar does. Finger
        // swipes are untouched: they're the native pager's own scroll, so they
        // still track live and still drive `position` continuously.
        screenOptions={{ swipeEnabled: swipeEnabled && !listenMode && !searchLocked, animationEnabled: false, sceneStyle: { paddingBottom: 68 + insets.bottom, backgroundColor: colors.background } }}
        screenListeners={({ navigation }) => ({
          // Pause mid-swipe work (video autoplay, caption focus) until the page
          // settles. noteTabSwipe feeds the guardPress() tap suppressor — taps
          // are filtered at the press handlers, NEVER by blocking touches, so
          // rapid consecutive swipes always reach the pager.
          swipeStart: () => { swipingRef.current = true; hasInteractedRef.current = true; noteTabSwipe(true); Keyboard.dismiss(); setFeedChromeHidden(false); },
          swipeEnd: () => { swipingRef.current = false; lastSwipeEndAt.current = Date.now(); noteTabSwipe(false); },
          // The bar (drag-release AND tap) navigates by emitting tabPress, so mark
          // the moment — a real bar-driven multi-tab jump must stay exempt from the
          // spurious-jump guard below.
          tabPress: () => { lastTabPressAt.current = Date.now(); hasInteractedRef.current = true; },
          state: (e) => {
            // Any tab change brings the reactive chrome back (a hidden bar on
            // Explore/Music would just look broken).
            setFeedChromeHidden(false);
            const navState = (e as { data?: { state?: { index?: number; routeNames?: string[] } } }).data?.state;
            const newIndex = navState?.index;
            const names = navState?.routeNames;
            if (typeof newIndex !== 'number' || !names) return;

            // ── AIRTIGHT LISTEN-MODE LOCK ──────────────────────────────────────
            // Listen mode is a Music-tab session; it must NEVER coexist with any
            // other tab being active. `swipeEnabled: !listenMode` blocks NEW
            // swipes, but a swipe already in flight when the Listen button is
            // pressed ("flick away + tap at the same instant") settles on the next
            // tab before that prop reaches the native pager — the reported gap.
            // The settle is the final arbiter: if it lands off Music while the mode
            // is on, snap straight back. The mode stays on (the user asked for it);
            // only the stray tab move is undone, so the state can't be exploited.
            if (listenModeRef.current) {
              const musicIndex = names.indexOf('music');
              if (musicIndex >= 0 && newIndex !== musicIndex) {
                settledIndexRef.current = musicIndex;
                navigation.navigate('music');
                return;
              }
            }

            const homeIndex = names.indexOf('index');
            const justMounted = Date.now() - mountedAt.current < MOUNT_GUARD_MS;
            const prev = settledIndexRef.current;

            // Was this settle actually driven by the user? A finger swipe emits
            // swipeStart/End; the bar (tap AND drag-release) emits tabPress. A
            // native-pager teleport emits NEITHER — that's what marks it spurious.
            const swipeDriven = swipingRef.current || Date.now() - lastSwipeEndAt.current < 600;
            const barDriven = Date.now() - lastTabPressAt.current < 700;
            // A bar navigation is only TRUSTED when the settle landed on the tab
            // the bar actually targeted — the corrupted post-login pager can
            // overshoot a bar flick to a far tab (the recorded glitch: low-thumb
            // swipes land on the bar band, the bar targets the adjacent tab, the
            // broken pager settles on Profile, and a plain "tabPress happened
            // recently" exemption swallowed it).
            const barTargetFresh = Date.now() - lastBarNav.at < 1500 && lastBarNav.index >= 0;
            const barVerified = barDriven && barTargetFresh && newIndex === lastBarNav.index;
            const barMisfired = barDriven && barTargetFresh && newIndex !== lastBarNav.index;

            // First settle after (re)mount MUST be Home (that's initialRouteName,
            // and a single swipe can only reach an ADJACENT page). So a FAR first
            // settle is the freshly-created native pager mis-firing — and it
            // happens BOTH ungestured (the original "login teleport") AND during
            // the user's first real swipe: the owner's 2026-07-21 screen recording
            // shows a first swipe toward the CAMERA (page 0) previewing the
            // profile screen in the camera's slot and then committing PROFILE
            // (the far end). The pager's first-gesture offset is corrupted, so
            // the committed index — and therefore its DIRECTION — is garbage;
            // redirecting "the way the finger went" would just guess. The old
            // `!swipeDriven` exemption here was the leak that let the recorded
            // glitch through. Only an explicit bar press (tabPress) legitimately
            // lands far on the first settle; EVERYTHING else snaps back to Home.
            // That sets the reference point, the pager recovers, and every later
            // settle is guarded by the delta logic below — worst case is one
            // swipe that visibly returns to Home instead of teleporting.
            if (prev == null) {
              if (homeIndex >= 0 && Math.abs(newIndex - homeIndex) > 1 && !barVerified) {
                // Far first settle that ISN'T a verified bar landing: the mount
                // glitch. Land where the user actually meant to go — the bar's
                // recorded target when this was a mis-flown bar flick, else Home.
                const intended = barMisfired ? lastBarNav.index : homeIndex;
                settledIndexRef.current = intended;
                navigation.navigate(names[intended]);
              } else {
                settledIndexRef.current = newIndex;
              }
              return;
            }

            settledIndexRef.current = newIndex;
            const delta = newIndex - prev;
            if (Math.abs(delta) <= 1) return; // a normal single-page move

            if (barVerified) {
              // Intentional bar navigation CONFIRMED by its landing spot —
              // checked FIRST: a verified tabPress is a stronger intent signal
              // than a ≤600ms-old swipe.
            } else if (barMisfired) {
              // The bar navigated but the pager settled somewhere ELSE — the
              // corrupted-pager overshoot. Go where the bar meant.
              const intended = Math.max(0, Math.min(names.length - 1, lastBarNav.index));
              settledIndexRef.current = intended;
              navigation.navigate(names[intended]);
            } else if (swipeDriven) {
              // A finger swipe moves EXACTLY one page, so an over-committed swipe
              // lands on the ADJACENT page in the swiped direction (where the finger
              // was actually headed) — never a far tab.
              const intended = Math.max(0, Math.min(names.length - 1, prev + Math.sign(delta)));
              settledIndexRef.current = intended;
              navigation.navigate(names[intended]);
            } else if (justMounted || !hasInteractedRef.current) {
              // A multi-page jump with NO gesture and NO bar press — during the
              // mount window OR before the user has touched anything at all — is the
              // spurious native-pager teleport (the login glitch that lands on
              // Profile). Revert to where we actually were (Home). The !hasInteracted
              // half is what makes this survive a slow login: the glitch is caught by
              // intent, not by a stopwatch. Legit programmatic far-jumps only fire
              // AFTER the user has interacted, so they stay untouched.
              settledIndexRef.current = prev;
              navigation.navigate(names[prev]);
            }
          },
        })}
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
      )}
      </View>
     </TabSwipeContext.Provider>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  bar: {
    // Flat, full-width, like a native iOS tab bar: the frosted BlurView child IS
    // the background (transparent here), with just a hairline top separator — no
    // rounded corners, no drop shadow. Stays overflow-visible for the center btn.
    // The hairline lives INSIDE the fading panel wrapper (topHairline) so it
    // dissolves with the frosted glass when the bar condenses into chips.
    backgroundColor: 'transparent',
    paddingTop: 6,
    overflow: 'visible',
  },
  // Condensed-mode chip: a glassy bordered circle that grows behind each icon
  // as the bar panel dissolves (46px around the 32px icon footprint).
  chip: {
    position: 'absolute',
    top: -7, left: -7,
    width: 46, height: 46,
    borderRadius: 23,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    ...SHADOWS.sm,
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
