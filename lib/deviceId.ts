import AsyncStorage from '@react-native-async-storage/async-storage';

// A stable per-install identifier, sent with stream records so the server can
// cap how many streams a single physical device can credit to a post (limits
// one-person-many-accounts farming via the real app). It is not cryptographic
// and a determined attacker can reset it (reinstall / clear data) or spoof it
// with a modified client — it's a friction layer, not a hard guarantee. The
// authoritative limits remain server-side (per-user cap + account-age gate).

const KEY = 'laybell_device_id_v1';
let cached: string | null = null;

function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export async function getDeviceId(): Promise<string> {
  if (cached) return cached;
  try {
    let id = await AsyncStorage.getItem(KEY);
    if (!id) { id = uuidv4(); await AsyncStorage.setItem(KEY, id); }
    cached = id;
  } catch {
    cached = cached || uuidv4(); // ephemeral fallback if storage is unavailable
  }
  return cached;
}
