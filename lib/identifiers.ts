import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { hashEmail, hashPhone } from './hash';

// The current user's own identity hashes (email + optional phone) live in the
// opaque `user_identifiers` table so other people's device contacts can be matched
// against them (see contacts_discovery.sql + lib/suggestions.ts). We store only
// hashes server-side; the phone's plaintext is kept on-device so Edit Profile can
// redisplay it.

const PHONE_KEY = 'laybell.ownPhone';

// Device-only plaintext phone (never uploaded). Used to prefill the Edit Profile field.
export async function loadOwnPhone(): Promise<string> {
  try { return (await AsyncStorage.getItem(PHONE_KEY)) ?? ''; } catch { return ''; }
}
export async function saveOwnPhone(phone: string): Promise<void> {
  try {
    if (phone.trim()) await AsyncStorage.setItem(PHONE_KEY, phone.trim());
    else await AsyncStorage.removeItem(PHONE_KEY);
  } catch {}
}

// Hash email (always) + phone (only if provided) and upsert the caller's row.
// Fire-and-forget: no-ops gracefully if expo-crypto isn't linked yet or the table
// hasn't been created (pre-migration). Omitting phone_hash leaves any existing one
// untouched on conflict; pass an empty string to clear it.
export async function upsertOwnIdentifiers(
  userId: string,
  email?: string | null,
  phone?: string | null,
): Promise<void> {
  try {
    const email_hash = await hashEmail(email);
    const row: Record<string, any> = { user_id: userId, updated_at: new Date().toISOString() };
    if (email_hash) row.email_hash = email_hash;

    if (phone !== undefined) {
      // phone provided (possibly empty → clear). undefined means "don't touch".
      row.phone_hash = phone ? await hashPhone(phone) : null;
    }

    if (!row.email_hash && row.phone_hash === undefined) return; // nothing to write
    await supabase.from('user_identifiers').upsert(row, { onConflict: 'user_id' });
  } catch {
    // Table missing pre-migration or crypto unavailable — ignore.
  }
}
