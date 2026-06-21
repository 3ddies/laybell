import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Stack, useSegments, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View, Platform, Alert } from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { supabase } from '../lib/supabase';
import { Session } from '@supabase/supabase-js';
import { COLORS } from '../constants/theme';
import { AudioProvider } from '../contexts/AudioContext';
import { PostMusicProvider } from '../contexts/PostMusicContext';
import { PostOptionsProvider } from '../contexts/PostOptionsContext';
import { ProfileProvider } from '../contexts/ProfileContext';
import { ThemeProvider, useTheme } from '../contexts/ThemeContext';
import { LanguageProvider } from '../contexts/LanguageContext';
import { ShareProvider } from '../contexts/ShareContext';
import { FollowProvider } from '../contexts/FollowContext';
import { StoriesProvider } from '../contexts/StoriesContext';
import { ListenModeProvider } from '../contexts/ListenModeContext';
import MiniPlayer from '../components/MiniPlayer';
import NowPlaying from '../components/NowPlaying';
import BadgeUpgradeToast from '../components/BadgeUpgradeToast';
import WelcomeTour, { WELCOME_TOUR_FLAG } from '../components/WelcomeTour';
import { useNotifications } from '../hooks/useNotifications';

function AppContent() {
  useNotifications();
  const { colors } = useTheme();
  const segments = useSegments();
  // Full-screen media viewers stay immersive — no floating mini player there.
  const immersive = segments[0] === 'story' || segments[0] === 'post' || segments[0] === 'reel';
  // On the Create tab the player migrates to a compact top-right card so the
  // song rides along instead of dying when the tab is swiped past; the post
  // DETAILS step then stops it (see post.tsx). On the story camera it docks
  // as a simplified side chip so the viewfinder stays clear.
  const tab = segments[0] === '(tabs)' ? (segments as string[])[1] : undefined;
  const playerVariant = tab === 'post' ? 'compact' as const : tab === 'story-camera' ? 'side' as const : 'bar' as const;
  // The bottom tab bar only exists on the main (tabs) routes. On pushed screens
  // (another user's profile, settings, etc.) the player should sit at the true
  // bottom — so it docks down there, except the DM chat which has its own input
  // bar to clear.
  const onTabs = segments[0] === '(tabs)';
  const inChat = segments[0] === 'messages' && (segments as string[]).length > 1;
  const bottomDock = !onTabs && !inChat;

  // One-time welcome tour: onboarding arms a flag then drops the user onto the
  // tabs, so the live app is already mounted. The first time we land on the tabs
  // with the flag set we read-and-clear it (shown exactly once) and float the
  // tour card over the app — dismiss leaves the user right where they are.
  const [showTour, setShowTour] = useState(false);
  useEffect(() => {
    if (segments[0] !== '(tabs)') return;
    let active = true;
    AsyncStorage.getItem(WELCOME_TOUR_FLAG).then((v) => {
      if (active && v === '1') {
        setShowTour(true);
        AsyncStorage.removeItem(WELCOME_TOUR_FLAG).catch(() => {});
      }
    });
    return () => { active = false; };
  }, [segments]);

  const overlays = (
    <>
      {!immersive && <MiniPlayer variant={playerVariant} bottomDock={bottomDock} />}
      <NowPlaying />
      <BadgeUpgradeToast />
    </>
  );

  return (
    <PostOptionsProvider>
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <Stack
        screenOptions={{
          headerShown: false,
          gestureEnabled: true,
          fullScreenGestureEnabled: true,  // swipe to go back from anywhere, not just the edge
          animation: 'slide_from_right',   // previous screen sits behind during the transition
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        {/* Auth group: the root Stack enables a full-screen back-swipe globally, so
            after logout the login page could be swiped back to the previous (signed-
            out) user's screen still behind it. Disable the gesture for this group so
            the login pages can't be swiped away at all. */}
        <Stack.Screen name="(auth)" options={{ gestureEnabled: false, fullScreenGestureEnabled: false }} />
        {/* The story viewer expands out of the tapped ring (Instagram shared-element
            style): transparent modal so the feed stays visible behind the growing
            post, no native animation/gesture — the in-screen rect animation drives it. */}
        <Stack.Screen
          name="story/[userId]"
          options={{
            presentation: 'transparentModal',
            animation: 'none',
            gestureEnabled: false,
            contentStyle: { backgroundColor: 'transparent' },
          }}
        />
        {/* Posts & reels expand out of the tapped thumbnail too (when opened with a
            `src` rect); transparent modal so the grid/feed shows behind. */}
        <Stack.Screen
          name="post/[id]"
          options={{
            presentation: 'transparentModal',
            animation: 'none',
            gestureEnabled: false,
            contentStyle: { backgroundColor: 'transparent' },
          }}
        />
        <Stack.Screen
          name="reel/[id]"
          options={{
            presentation: 'transparentModal',
            animation: 'none',
            gestureEnabled: false,
            contentStyle: { backgroundColor: 'transparent' },
          }}
        />
        {/* One-motion swipe-back screens: each renders inside a SwipeBackPager,
            so they're transparent modals — the screen you came from stays mounted
            underneath and is revealed live as you drag the page off (same feel as
            the tab pager). The pager drives the slide-in AND the slide-out, so
            the route itself must not animate (iOS ignores slide_from_right on
            modal presentations and would slide up from the bottom instead). The
            stack's own back gesture stays off — the pager owns the swipe. */}
        {['messages/index', 'notifications', 'settings', 'analytics', 'spotlight', 'ad-manager/index', 'ad-manager/create', 'ad-manager/[id]', 'badges', 'permissions', 'playlists', 'playlist/[id]', 'privacy-policy', 'terms-of-service', 'community-guidelines', 'advertiser-terms', 'privacy-center'].map((name) => (
          <Stack.Screen
            key={name}
            name={name}
            options={{
              presentation: 'transparentModal',
              animation: 'none',
              gestureEnabled: false,
              contentStyle: { backgroundColor: 'transparent' },
            }}
          />
        ))}
      </Stack>
        {/* iOS presents our swipe-back screens as NATIVE modals, which sit
            above the RN root view — so the global player chrome must live in
            a FullWindowOverlay to stay on top everywhere (playlist viewer,
            settings, messages, …). Android keeps plain sibling rendering.
            The overlay is its own native window, OUTSIDE the app's gesture-
            handler root — so it needs its own GestureHandlerRootView for the
            NowPlaying drag-to-dismiss to work (box-none keeps empty areas
            touch-transparent to the app underneath). */}
        {Platform.OS === 'ios' ? (
          <FullWindowOverlay>
            <GestureHandlerRootView style={{ flex: 1 }} pointerEvents="box-none">
              {overlays}
            </GestureHandlerRootView>
          </FullWindowOverlay>
        ) : overlays}

        {/* Floats over the live tabs after onboarding (absolute-fill card with
            the app visible around its borders). Rendered last so it paints on
            top of the tab content. */}
        {showTour && <WelcomeTour onDone={() => setShowTour(false)} />}
      </View>
    </PostOptionsProvider>
  );
}

export default function RootLayout() {
  const [session, setSession] = useState<Session | null>(null);
  const [initialized, setInitialized] = useState(false);
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setInitialized(true);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  // Activity heartbeat: stamps last_seen_at once per app open. This is what
  // keeps a hidden-but-active account from being eligible for the 3-month
  // deletion sweep (deletion requires 3 months of NO sign-ins). Fails silently
  // pre-migration (account_hidden.sql adds the column).
  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) return;
    supabase.from('profiles')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', uid)
      .then(undefined, () => {});
  }, [session?.user?.id]);

  useEffect(() => {
    if (!initialized) return;

    const inAuthGroup = segments[0] === '(auth)';
    const inOnboarding = segments[0] === 'onboarding';
    // Legal docs are reachable without a session and without finishing
    // onboarding, so the sign-up consent links and the minor-consent step can
    // open them without the auth/onboarding guards bouncing the user away.
    const inLegal = segments[0] === 'privacy-policy' || segments[0] === 'terms-of-service';

    if (!session && !inAuthGroup && !inLegal) {
      router.replace('/(auth)/login');
    } else if (session && inAuthGroup) {
      checkOnboarding();
    } else if (session && !inAuthGroup && !inOnboarding && !inLegal) {
      checkOnboarding(true);
    }
  }, [session, initialized, segments]);

  async function checkOnboarding(silent = false) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data: profile } = await supabase
      .from('profiles').select('*').eq('id', user.id).single();

    // A permanently-deleted account ("Delete now" → delete_immediately) is signed
    // out and blocked from entering the app. The auth user itself is removed
    // server-side by the delete-account Edge Function; this is the client backstop
    // so a flagged account can never be used even if that removal is deferred (or
    // the account was preserved under a legal hold). The reversible 3-month "hide"
    // path (delete_immediately false) is intentionally NOT blocked — the user can
    // come back, unhide, and cancel the deletion.
    if (profile && (profile as any).delete_immediately === true) {
      // Reported accounts aren't auto-deleted after 48h (they're handled manually),
      // so only promise the email-reuse timeline to accounts with no reports — else
      // it's misleading. Checked while still signed in (the RPC needs auth.uid()).
      let reported = false;
      try { const { data } = await supabase.rpc('current_account_has_reports'); reported = data === true; } catch {}
      await supabase.auth.signOut();
      Alert.alert('Account deleted', reported
        ? 'This account has been deleted and can no longer be accessed.'
        : 'This account has been deleted and can no longer be accessed. You can use this email to create a new account 48 hours after deletion.');
      return;
    }

    if (profile && profile.onboarded === false) {
      router.replace('/onboarding');
    } else if (!silent) {
      router.replace('/(tabs)');
    }
  }

  if (!initialized) {
    return <View style={{ flex: 1, backgroundColor: COLORS.background }} />;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
    <ThemeProvider>
    {/* Language sits beside Theme — both are DEVICE preferences (persisted locally),
        so they live above the per-user remount and survive account switches. */}
    <LanguageProvider>
    {/* Remount the entire per-user tree (every provider + the screens) whenever the
        signed-in user changes. The providers live ABOVE routing, so on a same-device
        account switch they'd otherwise keep serving the previous user's cached
        profile/stories/now-playing for the moment before the new data loads — the
        "snips of the other user's page" flash. Keying here gives each new session a
        clean slate. It sits BELOW ThemeProvider so the device theme never reloads,
        and the key is the user id (not the whole session) so a token refresh — same
        id — never triggers a remount. */}
    <View style={{ flex: 1 }} key={session?.user?.id ?? 'signed-out'}>
    <AudioProvider>
      <PostMusicProvider>
        <ProfileProvider>
          <FollowProvider>
            <ShareProvider>
              <StatusBar style="light" />
              <StoriesProvider>
                <ListenModeProvider>
                  <AppContent />
                </ListenModeProvider>
              </StoriesProvider>
            </ShareProvider>
          </FollowProvider>
        </ProfileProvider>
      </PostMusicProvider>
    </AudioProvider>
    </View>
    </LanguageProvider>
    </ThemeProvider>
    </GestureHandlerRootView>
  );
}
