import { useEffect, useState } from 'react';
import { Stack, useSegments, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';
import { supabase } from '../lib/supabase';
import { Session } from '@supabase/supabase-js';
import { COLORS } from '../constants/theme';
import { AudioProvider } from '../contexts/AudioContext';
import { PostMusicProvider } from '../contexts/PostMusicContext';
import { PostOptionsProvider } from '../contexts/PostOptionsContext';
import { ProfileProvider } from '../contexts/ProfileContext';
import { ShareProvider } from '../contexts/ShareContext';
import { FollowProvider } from '../contexts/FollowContext';
import { StoriesProvider } from '../contexts/StoriesContext';
import MiniPlayer from '../components/MiniPlayer';
import NowPlaying from '../components/NowPlaying';
import BadgeUpgradeToast from '../components/BadgeUpgradeToast';
import { useNotifications } from '../hooks/useNotifications';

function AppContent() {
  useNotifications();
  return (
    <PostOptionsProvider>
      <View style={{ flex: 1, backgroundColor: COLORS.background }}>
        <Stack
        screenOptions={{
          headerShown: false,
          gestureEnabled: true,
          fullScreenGestureEnabled: true,  // swipe to go back from anywhere, not just the edge
          animation: 'slide_from_right',   // previous screen sits behind during the transition
          contentStyle: { backgroundColor: COLORS.background },
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
      </Stack>
        <MiniPlayer />
        <NowPlaying />
        <BadgeUpgradeToast />
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
    <AudioProvider>
      <PostMusicProvider>
        <ProfileProvider>
          <FollowProvider>
            <ShareProvider>
              <StatusBar style="light" />
              <StoriesProvider>
                <AppContent />
              </StoriesProvider>
            </ShareProvider>
          </FollowProvider>
        </ProfileProvider>
      </PostMusicProvider>
    </AudioProvider>
  );
}
