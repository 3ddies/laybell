import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { supabase } from './supabase';

// Approximate-location capture for "people near you" recommendations. Everything is
// guarded so the app keeps working before the dev client is rebuilt with
// expo-location and before location_recommendations.sql is applied.

export type PermInfo = { granted: boolean; canAskAgain: boolean; status: string };

const STALE_KEY = 'laybell.locationRefreshedAt';
const ONE_DAY = 24 * 60 * 60 * 1000;

// Round to 1 decimal (~11 km) so only a coarse area is ever stored, never a precise
// position. Both the saved coords and matching are intentionally low-resolution.
const coarse = (n: number) => Math.round(n * 10) / 10;

export async function getLocationStatus(): Promise<PermInfo> {
  try {
    const p = await Location.getForegroundPermissionsAsync();
    return { granted: p.granted, canAskAgain: p.canAskAgain, status: p.status };
  } catch {
    return { granted: false, canAskAgain: true, status: 'undetermined' };
  }
}

export type CoarseLocation = { latitude: number; longitude: number; city: string | null };

// Request permission (if needed), read the current position, coarsen it, reverse-
// geocode a city label, and persist to the caller's profile. Returns the saved
// coarse location, or null if permission denied / anything failed.
export async function captureAndSaveLocation(userId: string): Promise<CoarseLocation | null> {
  try {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (!perm.granted) return null;

    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    const latitude = coarse(pos.coords.latitude);
    const longitude = coarse(pos.coords.longitude);

    let city: string | null = null;
    try {
      const places = await Location.reverseGeocodeAsync({ latitude, longitude });
      city = places?.[0]?.city ?? places?.[0]?.region ?? null;
    } catch {}

    await supabase.from('profiles')
      .update({ latitude, longitude, city, location_enabled: true })
      .eq('id', userId);

    try { await AsyncStorage.setItem(STALE_KEY, String(Date.now())); } catch {}
    return { latitude, longitude, city };
  } catch {
    return null;
  }
}

// Clear the stored area and turn the feature off (used by the Permissions toggle).
export async function disableLocation(userId: string): Promise<void> {
  try {
    await supabase.from('profiles')
      .update({ latitude: null, longitude: null, city: null, location_enabled: false })
      .eq('id', userId);
    await AsyncStorage.removeItem(STALE_KEY);
  } catch {}
}

// Refresh quietly if the user has location on and we haven't updated in >1 day.
// Safe to call on screen load; only acts when permission is still granted.
export async function maybeRefreshLocation(userId: string, locationEnabled?: boolean | null): Promise<void> {
  if (!locationEnabled) return;
  try {
    const last = Number((await AsyncStorage.getItem(STALE_KEY)) ?? 0);
    if (Date.now() - last < ONE_DAY) return;
    const perm = await Location.getForegroundPermissionsAsync();
    if (!perm.granted) return;
    await captureAndSaveLocation(userId);
  } catch {}
}
