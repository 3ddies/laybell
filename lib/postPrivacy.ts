// IG-style engagement privacy — the one place the app resolves what a post hides.
//
// The server (supabase/sql/post_privacy.sql) denormalizes the resolved
// override-else-account-default onto each post row as plain `*_eff` booleans, so
// every READ surface just calls postPrivacy(post) and reads three booleans — no
// profiles join, no resolution logic. Anything missing (older cache, a partial
// column select, a pre-migration row) falls back to "show / comments on", so
// nothing breaks before the migration is applied.

export type PostPrivacy = {
  /** Hide the like COUNT from viewers (the heart/like action still works). */
  hideLikes: boolean;
  /** Hide the comment thread and block new comments + replies. */
  commentsDisabled: boolean;
  /** Hide the save COUNT from viewers (saves are already private either way). */
  hideSaves: boolean;
};

export function postPrivacy(post: any): PostPrivacy {
  return {
    hideLikes: post?.hide_like_count_eff === true,
    commentsDisabled: post?.comments_disabled_eff === true,
    hideSaves: post?.hide_save_count_eff === true,
  };
}

// ── Composer / edit toggle helpers (the SET side) ────────────────────────────
// A per-post override is a tri-state: NULL means "inherit my account default".
// The toggles are plain on/off, so they START at the effective value (the
// override if one is set, else the account default)…
export function overrideInitial(
  override: boolean | null | undefined,
  accountDefault: boolean,
): boolean {
  return override ?? accountDefault;
}

// …and STORE NULL whenever the chosen value matches the current account default
// (so the post keeps following the account-wide setting if it later changes),
// and an explicit boolean only when the user deliberately diverges.
export function overrideToStore(
  value: boolean,
  accountDefault: boolean,
): boolean | null {
  return value === accountDefault ? null : value;
}
