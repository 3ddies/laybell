import { useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { router, useRootNavigationState } from 'expo-router';
import { supabase } from '../lib/supabase';
import { destForPushData } from '../lib/notificationRoute';
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
  useNotificationTapRouting();
}

/**
 * Take the user where a TAPPED push was about.
 *
 * Until this existed, tapping any Laybell notification just opened the app
 * wherever it happened to be — you tapped "you have earnings waiting" and landed
 * on the feed. That was true of every push the app sends, but it matters most
 * for the re-engagement ones, whose whole purpose is to arrive while the app is
 * closed.
 *
 * `useLastNotificationResponse` covers both cases in one hook: a tap while the
 * app is running, and a COLD START where the tap is what launched it.
 *
 * Two things it needs to be careful about:
 *   • The router is not ready during a cold start. useRootNavigationState is
 *     undefined until the tree is mounted, so navigating before it has a key
 *     silently does nothing — which is precisely the case this hook exists for.
 *   • The hook re-reports the SAME response on re-render, so without the
 *     already-handled check a remount would re-navigate and yank someone off
 *     whatever they had opened since.
 */
function useNotificationTapRouting() {
  const response = Notifications.useLastNotificationResponse();
  const navState = useRootNavigationState();
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!response || !navState?.key) return;
    const id = response.notification.request.identifier;
    if (handled.current === id) return;
    handled.current = id;

    const data = response.notification.request.content.data as any;
    (async () => {
      try {
        // Only 'followers' needs this, so it is fetched rather than held: the
        // alternative is reading auth state on every app start for a case that
        // comes up a few times a year.
        const { data: { user } } = await supabase.auth.getUser();
        const dest = destForPushData(data, user?.id ?? null);
        if (!dest) return;
        // No sheet is in the way here — the app has just opened, or was already
        // on the tabs — so navigate() is right for both kinds of destination.
        // It reuses an already-mounted route rather than stacking a second one,
        // which is what push() would do to a tab href (see app/spotlight.tsx).
        router.navigate(dest.href as any);
      } catch { /* a tap that cannot be resolved leaves the app where it opened */ }
    })();
  }, [response, navState?.key]);
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
