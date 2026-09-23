import { Linking, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { STORE_URLS } from './appLinks';

// Rating Laybell, and the badge that comes with it (owner, 2026-09-20: a
// permanent Silver for rating the app five stars).
//
// WHY A LINK AND NOT A PROMPT. Apple's in-app review sheet (expo-store-review)
// is a native module, and this app ships no over-the-air updates — adding one
// means a new build for everybody. A link to the store's review page costs
// nothing, works today, and is honest about where it is sending you. If the
// in-app sheet is ever wanted, this is the one place that changes.
//
// WHAT "RATED" MEANS. Neither store tells an app whether somebody left a review
// — Apple's sheet deliberately doesn't, and a link can't. So the signal is the
// only honest one available: the user opened the review page from this button.
// Two things keep that from being worth gaming: the badge is worth the same
// silver points as any other silver, and it can only be earned once.
//
// THE FLAG IS LOCAL, AND THAT IS FINE. It lives on the phone, but the badge it
// earns is PERMANENT (lib/badges), so the user_badges row survives a reinstall,
// a new device and a cleared cache — the flag only has to live long enough for
// the next evaluation to see it.

const KEY_PREFIX = 'app_rated_v1';

function keyFor(userId?: string | null): string {
  return userId ? `${KEY_PREFIX}_${userId}` : KEY_PREFIX;
}

/** The store page where a review is written, for this platform. */
export function ratingUrl(): string {
  // action=write-review opens straight on the review sheet rather than the
  // listing. Play has no equivalent parameter — its listing carries the stars.
  return Platform.OS === 'ios'
    ? `${STORE_URLS.ios}?action=write-review`
    : STORE_URLS.android;
}

export async function hasRatedApp(userId?: string | null): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(keyFor(userId))) === '1';
  } catch {
    return false;
  }
}

export async function markRatedApp(userId?: string | null): Promise<void> {
  try {
    await AsyncStorage.setItem(keyFor(userId), '1');
  } catch {
    // A phone that cannot write this just doesn't earn the badge yet; the
    // button is still there next time.
  }
}

/**
 * Open the store's review page. Resolves true when the store actually opened —
 * only then is it fair to record it and award the badge.
 */
export async function openAppRating(userId?: string | null): Promise<boolean> {
  const url = ratingUrl();
  try {
    await Linking.openURL(url);
  } catch {
    return false;
  }
  await markRatedApp(userId);
  return true;
}
