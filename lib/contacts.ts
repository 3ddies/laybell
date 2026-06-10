import * as Contacts from 'expo-contacts';
import { sha256Hex, normalizeEmail, normalizePhone } from './hash';
import type { PermInfo } from './location';

// Reads the device address book and returns SALTED HASHES of contacts' phone numbers
// and emails — never plaintext. Those hashes are matched against Laybell users via
// the match_contacts RPC (see lib/suggestions.ts). Guarded so the app keeps working
// before the dev client is rebuilt with expo-contacts.

const MAX_HASHES = 5000;

export async function getContactsStatus(): Promise<PermInfo> {
  try {
    const p = await Contacts.getPermissionsAsync();
    return { granted: p.granted, canAskAgain: p.canAskAgain, status: p.status };
  } catch {
    return { granted: false, canAskAgain: true, status: 'undetermined' };
  }
}

export async function requestContactsPermission(): Promise<PermInfo> {
  try {
    const p = await Contacts.requestPermissionsAsync();
    return { granted: p.granted, canAskAgain: p.canAskAgain, status: p.status };
  } catch {
    return { granted: false, canAskAgain: false, status: 'denied' };
  }
}

// Request (if needed), read all contacts, normalize + de-dupe their phones/emails,
// and return the hash set. Returns [] if permission denied or anything failed.
export async function readContactHashes(): Promise<string[]> {
  try {
    const perm = await Contacts.requestPermissionsAsync();
    if (!perm.granted) return [];

    const { data } = await Contacts.getContactsAsync({
      fields: [Contacts.Fields.PhoneNumbers, Contacts.Fields.Emails],
    });

    // De-dupe normalized identifiers first so we hash each unique value only once.
    const normalized = new Set<string>();
    for (const c of data ?? []) {
      for (const pn of c.phoneNumbers ?? []) {
        const n = normalizePhone(pn.number);
        if (n) normalized.add(n);
      }
      for (const em of c.emails ?? []) {
        const n = normalizeEmail(em.email);
        if (n) normalized.add(n);
      }
      if (normalized.size >= MAX_HASHES) break;
    }

    const hashes = await Promise.all([...normalized].map((v) => sha256Hex(v)));
    return hashes.filter((h): h is string => !!h);
  } catch {
    return [];
  }
}
