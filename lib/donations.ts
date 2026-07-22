import { supabase } from './supabase';

// Laybell Live donations — viewers tip a live host. EVERY host can receive tips;
// the Premium "Earn More" perk just lowers Laybell's cut. The money split is
// computed SERVER-SIDE by the donation_guard trigger (supabase/sql/donations.sql)
// from the host's plan; the rates here MUST match that trigger. Degrades
// gracefully: if the SQL isn't applied the insert fails and donate() returns a
// typed failure — the caller shows a message and the live viewer keeps working.

// Laybell's cut depends on the host's plan — this IS the Premium "Earn More"
// perk. Estimated tax is added ON TOP (the donor's cost, Poshmark-style, like the
// shop) so it never reduces the host's take-home.
export const DONATION_FEE_RATE_PREMIUM = 0.08;   // Premium hosts keep 92%
export const DONATION_FEE_RATE_STANDARD = 0.35;  // everyone else keeps 65%
export const DONATION_TAX_RATE = 0.06; // estimate for display; real tax varies by location/provider

// Quick-pick tip amounts (cents).
export const DONATION_PRESETS_CENTS = [100, 200, 500, 1000, 2000, 5000];
export const DONATION_MIN_CENTS = 100;
export const DONATION_MAX_CENTS = 50000;

/** True while `premium_until` is in the future. */
export function hostIsPremium(premiumUntil?: string | null): boolean {
  return !!premiumUntil && new Date(premiumUntil).getTime() > Date.now();
}
/** Laybell's fee RATE for a host by plan — 8% Premium, 35% standard. */
export function hostFeeRate(premiumUntil?: string | null): number {
  return hostIsPremium(premiumUntil) ? DONATION_FEE_RATE_PREMIUM : DONATION_FEE_RATE_STANDARD;
}

export function donationFeeCents(amountCents: number, feeRate: number): number {
  return Math.round(amountCents * feeRate);
}
/** What the host keeps after Laybell's fee. */
export function donationPayoutCents(amountCents: number, feeRate: number): number {
  return Math.max(0, amountCents - donationFeeCents(amountCents, feeRate));
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

export function donationBreakdown(amountCents: number, feeRate: number): DonationBreakdown {
  return {
    amountCents,
    feeCents: donationFeeCents(amountCents, feeRate),
    taxCents: donationTaxCents(amountCents),
    payoutCents: donationPayoutCents(amountCents, feeRate),
    totalChargeCents: donationTotalChargeCents(amountCents),
  };
}

export function fmtCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Donations are open to EVERY live host now — Premium only lowers the fee (the
    "Earn More" perk). Kept as a function so the callers that gate on it stay
    unchanged; the fee tier comes from hostFeeRate(). */
export function hostCanReceive(_premiumUntil?: string | null): boolean {
  return true;
}

export type DonateResult =
  | { ok: true }
  | { ok: false; reason: 'not_premium' | 'self' | 'unavailable' | 'signed_out' };

/**
 * Record a (simulated) donation. The trigger resolves the host from the stream,
 * enforces the premium lock, and computes the fee/tax/payout — so we only send the
 * donor, stream, and amount. Maps the server's error strings to a typed reason.
 */
export async function donate(streamId: string, amountCents: number, message = ''): Promise<DonateResult> {
  return donateTo({ stream_id: streamId }, amountCents, message);
}

/** Tip the host of a LIVE STUDIO broadcast (donation_guard v3 resolves the
    host from studio_sessions; requires studio_live.sql). */
export async function donateStudio(sessionId: string, amountCents: number, message = ''): Promise<DonateResult> {
  return donateTo({ studio_session_id: sessionId }, amountCents, message);
}

async function donateTo(
  target: { stream_id?: string; studio_session_id?: string },
  amountCents: number,
  message: string,
): Promise<DonateResult> {
  const amount = Math.round(amountCents);
  if (!(amount >= DONATION_MIN_CENTS)) return { ok: false, reason: 'unavailable' };
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, reason: 'signed_out' };
    // streamer_id is a NOT NULL column but the trigger overrides it from the
    // target; send the donor's own id as a placeholder to satisfy the shape.
    const { error } = await supabase.from('donations').insert({
      donor_id: user.id,
      streamer_id: user.id,
      ...target,
      amount_cents: amount,
      message: message.trim().slice(0, 200) || null,
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

/** This stream's take-home for the host (sum of succeeded donation payouts) —
    powers the post-stream "You Earned $X" screen. RLS lets the host read their
    own donations, so this is scoped to the caller's stream. */
export async function fetchStreamEarnings(streamId: string): Promise<number> {
  try {
    const { data } = await supabase
      .from('donations')
      .select('streamer_payout_cents')
      .eq('stream_id', streamId)
      .eq('status', 'succeeded');
    return (data ?? []).reduce((sum, d: any) => sum + (d.streamer_payout_cents ?? 0), 0);
  } catch {
    return 0;
  }
}

/** A studio broadcast's take-home for the host — the "You Earned $X" moment
    when the broadcast ends (mirror of fetchStreamEarnings). */
export async function fetchStudioEarnings(sessionId: string): Promise<number> {
  try {
    const { data } = await supabase
      .from('donations')
      .select('streamer_payout_cents')
      .eq('studio_session_id', sessionId)
      .eq('status', 'succeeded');
    return (data ?? []).reduce((sum, d: any) => sum + (d.streamer_payout_cents ?? 0), 0);
  } catch {
    return 0;
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
