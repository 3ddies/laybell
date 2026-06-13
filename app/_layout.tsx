import { useEffect, useState } from 'react';
import { Stack, useSegments, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View, Platform } from 'react-native';
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
import { ShareProvider } from '../contexts/ShareContext';
import { FollowProvider } from '../contexts/FollowContext';
import { StoriesProvider } from '../contexts/StoriesContext';
import { ListenModeProvider } from '../contexts/ListenModeContext';
import MiniPlayer from '../components/MiniPlayer';
import NowPlaying from '../components/NowPlaying';
import BadgeUpgradeToast from '../components/BadgeUpgradeToast';
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

  const overlays = (
    <>
      {!immersive && <MiniPlayer variant={playerVariant} />}
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
        {['messages/index', 'notifications', 'settings', 'analytics', 'spotlight', 'badges', 'permissions', 'playlists', 'playlist/[id]'].map((name) => (
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

    if (!session && !inAuthGroup) {
      router.replace('/(auth)/login');
    } else if (session && inAuthGroup) {
      checkOnboarding();
    } else if (session && !inAuthGroup && !inOnboarding) {
      checkOnboarding(true);
    }
  }, [session, initialized, segments]);

  async function checkOnboarding(silent = false) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data: profile } = await supabase
      .from('profiles').select('onboarded').eq('id', user.id).single();

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
    </ThemeProvider>
    </GestureHandlerRootView>
  );
}
