// Hidden accounts (profiles.hidden) keep their CONTENT invisible via RLS, but
// residual public appearances remain — old comments, follower lists, story
// views, notification actors, chat threads. Those rows still render; this
// helper anonymizes the attached profile so the person reads as "Hidden
// account" with the default avatar. The row's user_id is kept, so tapping
// through lands on the profile page's existing "account unavailable" state.
//
// Queries that feed a surface through this helper must SELECT the `hidden`
// column (account_hidden.sql) alongside the usual profile columns.

export const HIDDEN_NAME = 'Hidden account';

// Anonymize a profile row if it's hidden (no-op otherwise). `isSelf` lets the
// owner keep seeing their real identity on their own comments/rows while
// hidden. Username is blanked — not replaced — so "@…" affordances (reply
// prefill, search match, mention tap) naturally skip it.
export function maskHiddenProfile<T extends Record<string, any> | null | undefined>(
  profile: T,
  isSelf = false,
): T {
  if (!profile || !profile.hidden || isSelf) return profile;
  return {
    ...profile,
    username: '',
    display_name: HIDDEN_NAME,
    avatar_url: null,
    badge_tier: null,
    badge_show: false,
    profile_theme: null,
  };
}
