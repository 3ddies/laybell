import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { supabase } from '../lib/supabase';

// How notifications appear when app is in the foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export function useNotifications() {
  useEffect(() => {
    registerForPushNotifications();
  }, []);
}

async function registerForPushNotifications() {
  // Push tokens only work on physical devices
  if (!Device.isDevice) return;

  const { status: existing } = await Notifications.getPermissionsAsync();
  let finalStatus = existing;

  if (existing !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') return;

  // Requires EAS project ID — set up via `eas init` or manually in app.json extra.eas.projectId
  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ??
    (Constants as any).easConfig?.projectId;

  if (!projectId) {
    console.log('Push notifications require an EAS project ID. Run `eas init` to set one up.');
    return;
  }

  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user || !token) return;

    await supabase.from('push_tokens').upsert({
      user_id: user.id,
      token,
      platform: Device.osName?.toLowerCase() ?? 'unknown',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
  } catch (err) {
    console.log('Push token registration error:', err);
  }
}
