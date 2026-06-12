import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { supabase } from '../lib/supabase';
import { loadNotifPrefs, getCachedNotifPrefs, isNotifTypeEnabled } from '../lib/notificationPrefs';
import { isListenModeActive } from '../contexts/ListenModeContext';

// How notifications appear when the app is in the foreground. The per-category
// toggles in Settings (cached in notificationPrefs) decide whether to present an
// incoming push: the notification's data.type is matched to its category; an
// untyped notification is shown unless the user turned every category off.
// Listen mode (Music tab focus mode) silences everything outright — the user is
// listening in peace; the push still lands in the OS tray once they leave.
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const type = (notification?.request?.content?.data as any)?.type as string | undefined;
    const prefs = getCachedNotifPrefs();
    const anyOn = prefs.likes || prefs.comments || prefs.follows || prefs.messages;
    const enabled = !isListenModeActive() && (type ? isNotifTypeEnabled(type) : anyOn);
    return {
      shouldShowBanner: enabled,
      shouldShowList: enabled,
      shouldPlaySound: enabled,
      shouldSetBadge: enabled,
    };
  },
});

export function useNotifications() {
  useEffect(() => {
    loadNotifPrefs(); // seed the cache so the handler above honours saved prefs
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
