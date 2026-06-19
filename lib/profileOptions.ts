// Shared profile option lists, used by onboarding and Edit Profile.

// Forward-compatible check for a custom profile page layout/"template". The "Page
// Layout" feature (see edit-profile.tsx) is coming soon and has no column yet, so
// this reads a future `page_layout` field and treats anything other than
// null/'default' as an active template. While the feature is unbuilt it returns
// false for everyone — so callers that vary behavior by template (e.g. floating
// spotlighted posts to the top of the profile Posts grid) just apply their default
// for now, and automatically defer to the user's own arrangement once Page Layout
// ships and sets this field.
export function hasProfileTemplate(profile?: any): boolean {
  const layout = profile?.page_layout;
  return !!layout && layout !== 'default';
}

// Gender presets. Collected (required) at onboarding and editable later from
// Edit Profile. Stored privately on the profile — never shown publicly.
export const GENDER_OPTIONS = ['Woman', 'Man', 'Non-binary', 'Other', 'Prefer not to say'];

// Minimum age to use the app (collected, required, at onboarding).
export const MIN_AGE = 13;

// ─── Date of birth ───────────────────────────────────────────────────────────
// Onboarding collects a real date of birth (MM/DD/YYYY) rather than a bare age.

// Parse a year/month/day entry into a Date, or null if it isn't a real calendar
// date (rejects out-of-range values and overflow like Feb 31 → Mar 3).
export function parseDob(year: string, month: string, day: string): Date | null {
  const y = parseInt(year, 10), m = parseInt(month, 10), d = parseInt(day, 10);
  if (isNaN(y) || isNaN(m) || isNaN(d)) return null;
  if (y < 1900 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

// Whole-year age from a date of birth as of today.
export function ageFromDob(dob: Date): number {
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const monthDiff = now.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < dob.getDate())) age--;
  return age;
}

// 'YYYY-MM-DD' for storage in a Postgres date column.
export function dobToISO(dob: Date): string {
  const m = String(dob.getMonth() + 1).padStart(2, '0');
  const d = String(dob.getDate()).padStart(2, '0');
  return `${dob.getFullYear()}-${m}-${d}`;
}

// Normalize a user-entered profile link for opening (ensure an http(s) scheme).
export function normalizeUrl(raw: string | null | undefined): string {
  const t = (raw ?? '').trim();
  if (!t) return '';
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

// Cleaned display form of a link (strip scheme + trailing slash).
export function displayUrl(raw: string | null | undefined): string {
  return (raw ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}
