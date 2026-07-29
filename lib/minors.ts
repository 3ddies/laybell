import { supabase } from './supabase';
import { ageFromDob } from './profileOptions';

// Age gating for the teen-safety rules.
//
// The asymmetry here is deliberate and is the whole point of this module:
//
//   isMinor(p)  — we AFFIRMATIVELY KNOW they are under 18. Used to APPLY a
//                 restriction to a specific person.
//   isAdult(p)  — we AFFIRMATIVELY KNOW they are 18 or over. Used to GRANT a
//                 privilege (broadcasting live, targeted ads, location capture).
//
// An unknown age satisfies NEITHER. So a profile with no date of birth doesn't
// get flagged as a child, but it also never unlocks an adults-only capability —
// privileges require positive proof. Getting this backwards is how platforms end
// up serving targeted ads to 14-year-olds whose age they "didn't have".
//
// dob is the source of truth (profile_fields.sql); the denormalized `age` column
// is the fallback for rows written before dob existed.

export const ADULT_AGE = 18;

export type AgeProfile = { age?: number | null; dob?: string | null } | null | undefined;

/** Whole-year age from a profile, or null when we genuinely don't know. */
export function ageOf(p: AgeProfile): number | null {
  if (!p) return null;
  if (p.dob) {
    const d = new Date(p.dob);
    if (!Number.isNaN(d.getTime())) return ageFromDob(d);
  }
  return typeof p.age === 'number' ? p.age : null;
}

/** Known to be under 18. Unknown age is NOT a minor — see isAdult for gating. */
export function isMinor(p: AgeProfile): boolean {
  const a = ageOf(p);
  return a != null && a < ADULT_AGE;
}

/** Known to be 18+. Unknown age is NOT an adult — this is the gate to use for
 *  anything a minor must not reach. */
export function isAdult(p: AgeProfile): boolean {
  const a = ageOf(p);
  return a != null && a >= ADULT_AGE;
}

// The signed-in user's age fields, cached for the session. Called on hot paths
// (every ad fetch), so it must not add a round-trip per call. Cleared on sign-out
// via clearAgeCache so a second account on the same device can't inherit the first
// one's adult status.
let cached: { id: string; profile: AgeProfile } | null = null;

export function clearAgeCache(): void {
  cached = null;
}

export async function fetchMyAgeProfile(): Promise<AgeProfile> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    if (cached?.id === user.id) return cached.profile;
    // Spread-tolerant select: a pre-migration database without dob/age simply
    // returns nothing here, which lands as "unknown" — the safe side.
    const { data } = await supabase
      .from('profiles').select('age, dob').eq('id', user.id).maybeSingle();
    const profile = (data ?? null) as AgeProfile;
    cached = { id: user.id, profile };
    return profile;
  } catch {
    return null;
  }
}

/** Convenience for the common gate: "is the signed-in user a known adult?" */
export async function viewerIsAdult(): Promise<boolean> {
  return isAdult(await fetchMyAgeProfile());
}

/** Convenience for the common gate: "is the signed-in user a known minor?" */
export async function viewerIsMinor(): Promise<boolean> {
  return isMinor(await fetchMyAgeProfile());
}
