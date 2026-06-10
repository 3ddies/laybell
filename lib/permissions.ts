import { Linking } from 'react-native';
import { Camera } from 'expo-camera';
import * as MediaLibrary from 'expo-media-library';
import * as Notifications from 'expo-notifications';
import { getLocationStatus, type PermInfo } from './location';
import { getContactsStatus } from './contacts';

// Unified, guarded permission status/request helpers for the in-app Permissions
// screen (app/permissions.tsx). OS permissions can't be flipped programmatically —
// the screen requests an undetermined permission once, then deep-links to the OS
// Settings app (openAppSettings) for anything already decided.

export type { PermInfo };

const toInfo = (p: { status: string; granted: boolean; canAskAgain: boolean }): PermInfo =>
  ({ granted: p.granted, canAskAgain: p.canAskAgain, status: p.status });

const safe = async (fn: () => Promise<{ status: string; granted: boolean; canAskAgain: boolean }>): Promise<PermInfo> => {
  try { return toInfo(await fn()); }
  catch { return { granted: false, canAskAgain: true, status: 'undetermined' }; }
};

// --- Status getters ---
export const getCameraPermission = () => safe(Camera.getCameraPermissionsAsync);
export const getMicrophonePermission = () => safe(Camera.getMicrophonePermissionsAsync);
export const getPhotosPermission = () => safe(MediaLibrary.getPermissionsAsync);
export const getNotificationsPermission = () => safe(Notifications.getPermissionsAsync);
export { getLocationStatus as getLocationPermission, getContactsStatus as getContactsPermission };

// --- Requests (for first-time / undetermined) ---
export const requestCameraPermission = () => safe(Camera.requestCameraPermissionsAsync);
export const requestMicrophonePermission = () => safe(Camera.requestMicrophonePermissionsAsync);
export const requestPhotosPermission = () => safe(MediaLibrary.requestPermissionsAsync);
export const requestNotificationsPermission = () => safe(Notifications.requestPermissionsAsync);

export async function openAppSettings(): Promise<void> {
  try { await Linking.openSettings(); } catch {}
}
