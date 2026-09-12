import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { tg } from './i18n';

// "Your post is live" — a local reminder on the author's phone at the moment a
// scheduled post goes up. Local rather than a push: the author scheduled it on
// this phone, and the server's publish job (supabase/sql/post_scheduling.sql)
// does the part only a server can, telling everyone else.
//
// Never asks for notification permission. A reminder is a nicety, not a reason to
// interrupt someone posting with a system prompt; without permission it is simply
// not scheduled.

const KEY = 'scheduled_post_reminders_v1';
type Reminders = Record<string, string>; // post id → the OS notification id

async function read(): Promise<Reminders> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function write(r: Reminders): Promise<void> {
  try { await AsyncStorage.setItem(KEY, JSON.stringify(r)); } catch { /* the reminder just won't be cancellable */ }
}

/** Schedule (or move) the reminder for a post going live at `at`. */
export async function scheduleLiveReminder(postId: string, at: number): Promise<void> {
  try {
    await cancelLiveReminder(postId);
    if (!(at > Date.now() + 5_000)) return;
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') return;
    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: tg('schedule.liveNotifTitle'),
        body: tg('schedule.liveNotifBody'),
        sound: 'default',
        // Any push carrying a postId opens that post (lib/notificationRoute).
        data: { type: 'post_live', postId },
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(at) },
    });
    const reminders = await read();
    reminders[postId] = id;
    await write(reminders);
  } catch {
    // Never let a reminder fail a schedule.
  }
}

/** Drop a post's reminder — it was posted early, rescheduled or deleted. */
export async function cancelLiveReminder(postId: string): Promise<void> {
  try {
    const reminders = await read();
    const id = reminders[postId];
    if (!id) return;
    delete reminders[postId];
    await write(reminders);
    await Notifications.cancelScheduledNotificationAsync(id);
  } catch {
    // Already fired or already gone.
  }
}
