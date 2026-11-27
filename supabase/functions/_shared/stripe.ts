// Shared Stripe + auth helpers for the web-shop edge functions (stripe-checkout,
// shop-cart-checkout, stripe-webhook). Money-adjacent: keep the origin allowlist, the pinned
// Stripe API version, and the form-encoded Stripe call in ONE place so the three functions
// can't quietly drift apart.

export const STRIPE_VERSION = '2024-06-20';

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// The signed-in buyer's id from the Supabase JWT. The checkout functions sit behind the JWT
// gateway (verify_jwt on), so the token is already verified; this just reads the `sub` claim.
export function userIdFromJwt(req: Request): string | null {
  try {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    let b64 = (token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
    if (!b64) return null;
    while (b64.length % 4) b64 += '=';
    return JSON.parse(atob(b64)).sub ?? null;
  } catch { return null; }
}

// Only return the buyer to a Laybell origin (so the Stripe return can't be used as an open
// redirect). Falls back to the configured default origin.
export function safeOrigin(req: Request, fallback: string): string {
  const o = req.headers.get('Origin') ?? '';
  try {
    const u = new URL(o);
    if (u.protocol === 'https:' && (u.hostname.endsWith('.vercel.app') || u.hostname === 'laybell.app' || u.hostname.endsWith('.laybell.app'))) {
      return u.origin;
    }
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return u.origin;
  } catch { /* fall through */ }
  return fallback;
}

// Form-encoded Stripe API call, pinned to STRIPE_VERSION. `key` is the shop's dedicated
// STRIPE_SHOP_SECRET_KEY (never the live payouts key). Throws on a non-2xx with the message.
export async function stripe(
  key: string, path: string, body?: Record<string, string>, method = 'POST', idempotencyKey?: string,
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Stripe-Version': STRIPE_VERSION,
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method, headers, body: body ? new URLSearchParams(body).toString() : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data?.error?.message ?? 'stripe_error');
    (err as any).code = data?.error?.code ?? null;
    throw err;
  }
  return data;
}
