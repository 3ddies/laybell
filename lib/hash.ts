import * as Crypto from 'expo-crypto';

// Salted SHA-256 hashing for privacy-preserving contact discovery. We never send a
// user's phone/email to the server in plaintext — only these hashes — and contact
// matching compares hashes (see lib/contacts.ts + the match_contacts RPC).
//
// The salt namespaces the hashes to Laybell. Be honest: a static client-side salt
// does NOT make hashes brute-force-proof (phone numbers are low entropy). It's a
// mild deterrent; the real protection is the opaque user_identifiers table + RPC
// (contacts_discovery.sql), which prevents bulk dumping of the hash set.
const SALT = 'laybell:v1:';

// SHA-256 → hex. Returns null if the native crypto module isn't available yet
// (e.g. before the dev client is rebuilt with expo-crypto), so callers no-op.
export async function sha256Hex(input: string): Promise<string | null> {
  try {
    return await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, SALT + input);
  } catch {
    return null;
  }
}

// Lowercase + trim. Returns null for anything that isn't plausibly an email.
export function normalizeEmail(email?: string | null): string | null {
  if (!email) return null;
  const e = email.trim().toLowerCase();
  return e.includes('@') && e.length >= 5 ? e : null;
}

// Digits only; drop a country code heuristically by keeping the last 10 digits
// (US/Canada-centric, but a reasonable default — both the stored number and the
// device-contact number normalize the same way so they still match). Returns null
// if there aren't enough digits to be a real number.
export function normalizePhone(phone?: string | null): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, '');
  if (digits.length > 10) digits = digits.slice(-10);
  return digits.length >= 7 ? digits : null;
}

export async function hashEmail(email?: string | null): Promise<string | null> {
  const n = normalizeEmail(email);
  return n ? sha256Hex(n) : null;
}

export async function hashPhone(phone?: string | null): Promise<string | null> {
  const n = normalizePhone(phone);
  return n ? sha256Hex(n) : null;
}
