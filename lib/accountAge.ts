// An account counts as "new" for its first 30 days, measured from
// profiles.created_at. Surfaced as a "New Account" tag in discovery (suggested /
// people-to-follow / recommended), and used to keep brand-new accounts from being
// mislabelled "Popular on Laybell" (see lib/suggestions).
export const NEW_ACCOUNT_MS = 30 * 24 * 60 * 60 * 1000;

export function isNewAccount(createdAt?: string | null): boolean {
  if (!createdAt) return false;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return false;
  return Date.now() - t < NEW_ACCOUNT_MS;
}
