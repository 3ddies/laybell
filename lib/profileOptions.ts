// Shared profile option lists, used by onboarding and Edit Profile.

// Gender presets. Collected (required) at onboarding and editable later from
// Edit Profile. Stored privately on the profile — never shown publicly.
export const GENDER_OPTIONS = ['Woman', 'Man', 'Non-binary', 'Other', 'Prefer not to say'];

// Minimum age to use the app (collected, required, at onboarding).
export const MIN_AGE = 13;

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
