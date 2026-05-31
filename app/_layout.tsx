import { useEffect, useState } from 'react';
import { Slot, useSegments, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';
import TrackPlayer from 'react-native-track-player';
import { supabase } from '../lib/supabase';
import { Session } from '@supabase/supabase-js';
import { COLORS } from '../constants/theme';
import { AudioProvider } from '../contexts/AudioContext';
import MiniPlayer from '../components/MiniPlayer';
import { useNotifications } from '../hooks/useNotifications';
import { PlaybackService } from '../service';

// Register TrackPlayer background service at module level
TrackPlayer.registerPlaybackService(() => PlaybackService);

function AppContent() {
  useNotifications();
  return (
    <View style={{ flex: 1, backgroundColor: COLORS.background }}>
      <Slot />
      <MiniPlayer />
    </View>
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
      <StatusBar style="light" />
      <AppContent />
    </AudioProvider>
  );
}
