import { supabase } from './supabase';

// Laybell Live donations — viewers tip a live host; PREMIUM hosts get paid. The
// money split + the premium lock are enforced SERVER-SIDE by the donation_guard
// trigger (supabase/sql/donations.sql); the rates here MUST match that trigger.
// Everything degrades gracefully: if the SQL isn't applied (or the host isn't
// Premium) the insert rejects and donate() returns a typed failure — the caller
// shows a message and the live viewer keeps working.

// Laybell takes 15% of every donation. Estimated tax is added ON TOP (the donor's
// cost, Poshmark-style, like the shop) so it never reduces the host's take-home.
export const DONATION_FEE_RATE = 0.15;
export const DONATION_TAX_RATE = 0.06; // estimate for display; real tax varies by location/provider

// Quick-pick tip amounts (cents).
export const DONATION_PRESETS_CENTS = [100, 200, 500, 1000, 2000, 5000];
export const DONATION_MIN_CENTS = 100;
export const DONATION_MAX_CENTS = 50000;

export function donationFeeCents(amountCents: number): number {
  return Math.round(amountCents * DONATION_FEE_RATE);
}
/** What the host keeps after Laybell's 15% fee. */
export function donationPayoutCents(amountCents: number): number {
  return Math.max(0, amountCents - donationFeeCents(amountCents));
}
/** Estimated tax added on top of the tip (the donor's extra cost). */
export function donationTaxCents(amountCents: number): number {
  return Math.round(amountCents * DONATION_TAX_RATE);
}
/** Total the donor is charged: tip + estimated tax. */
export function donationTotalChargeCents(amountCents: number): number {
  return amountCents + donationTaxCents(amountCents);
}

export type DonationBreakdown = {
  amountCents: number;
  feeCents: number;
  taxCents: number;
  payoutCents: number;
  totalChargeCents: number;
};

export function donationBreakdown(amountCents: number): DonationBreakdown {
  return {
    amountCents,
    feeCents: donationFeeCents(amountCents),
    taxCents: donationTaxCents(amountCents),
    payoutCents: donationPayoutCents(amountCents),
    totalChargeCents: donationTotalChargeCents(amountCents),
  };
}

export function fmtCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** True while `premium_until` is in the future — the host can receive donations. */
export function hostCanReceive(premiumUntil?: string | null): boolean {
  return !!premiumUntil && new Date(premiumUntil).getTime() > Date.now();
}

export type DonateResult =
  | { ok: true }
  | { ok: false; reason: 'not_premium' | 'self' | 'unavailable' | 'signed_out' };

/**
 * Record a (simulated) donation. The trigger resolves the host from the stream,
 * enforces the premium lock, and computes the fee/tax/payout — so we only send the
 * donor, stream, and amount. Maps the server's error strings to a typed reason.
 */
export async function donate(streamId: string, amountCents: number): Promise<DonateResult> {
  const amount = Math.round(amountCents);
  if (!(amount >= DONATION_MIN_CENTS)) return { ok: false, reason: 'unavailable' };
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, reason: 'signed_out' };
    // streamer_id is a NOT NULL column but the trigger overrides it from the stream;
    // send the donor's own id as a placeholder to satisfy the insert shape.
    const { error } = await supabase.from('donations').insert({
      donor_id: user.id,
      streamer_id: user.id,
      stream_id: streamId,
      amount_cents: amount,
    });
    if (!error) return { ok: true };
    const msg = `${error.message ?? ''}`.toLowerCase();
    if (msg.includes('streamer_not_premium')) return { ok: false, reason: 'not_premium' };
    if (msg.includes('cannot_donate_to_self')) return { ok: false, reason: 'self' };
    return { ok: false, reason: 'unavailable' };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/** Host earnings rollup (take-home total + count) for the signed-in user. */
export async function fetchDonationEarnings(): Promise<{ totalCents: number; count: number }> {
  try {
    const { data, error } = await supabase.rpc('donation_earnings');
    if (error || !data?.[0]) return { totalCents: 0, count: 0 };
    return { totalCents: Number(data[0].total_cents ?? 0), count: Number(data[0].donation_count ?? 0) };
  } catch {
    return { totalCents: 0, count: 0 };
  }
}
