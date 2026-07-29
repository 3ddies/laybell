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
// Premium hosts keep 70%. Mirrors tip_fee_rate() in ledger_spend.sql, which is
// authoritative — this copy only drives the breakdown shown before sending.
//
// The rate is dictated by the store's cut. Credits are bought through Apple and
// Google, who take their commission before Laybell sees anything:
//
//                     Apple 30% (standard)   Apple 15% (Small Business)
//   $10 tip
//   Laybell receives         $7.00                   $8.50
//   Creator owed (70%)       $7.00                   $7.00
//   Laybell nets             $0.00                   $1.50
//
// 30% is BREAK-EVEN while Apple takes 30%. The original 8% (creator keeps 92%)
// lost $2.20 per tip at that commission and $0.70 even at 15%.
//
// ⚠️ REVISIT AFTER SMALL BUSINESS PROGRAM APPROVAL. At Apple 15% this nets 15%,
// and dropping back toward 20% (creator keeps 80%) restores "Earn More" as a
// perk worth subscribing for — at 70% vs the standard 65% it barely is.
export const DONATION_FEE_RATE_PREMIUM = 0.30;
export const DONATION_FEE_RATE_STANDARD = 0.35;  // everyone else keeps 65%
export const DONATION_TAX_RATE = 0.06; // estimate for display; real tax varies by location/provider

// Quick-pick tip amounts (cents).
//
// The $6 floor is set by processing economics, not product taste. A card charge
// costs 2.9% + 30¢, which is a fixed cost Laybell pays on every tip regardless of
// size — so on small tips the processor takes more than the platform does.
// Break-even by tier: 35% standard → $0.93, 8% Premium → $5.88.
//
// Laybell's net at each amount, after Stripe:
//
//     tip   Stripe   net @8% Premium   net @35% standard
//     $5    $0.45         -$0.045            $1.30      ← loses money
//     $6    $0.47         +$0.006            $1.63      ← the floor
//     $10   $0.59         +$0.21             $2.91
//     $25   $1.03         +$0.98             $7.72
//     $50   $1.75         +$2.25            $15.75
//
// $6 is the smallest whole-dollar tip that is profitable on BOTH tiers. The margin
// on a floor-sized Premium tip is ~nil, and that is the Premium "Earn More" perk
// working as intended — the 8% rate exists to give margin back to the creator. It
// turns healthy above $10, where real tipping volume sits.
//
// ⚠️ DONATION_MIN_CENTS is enforced client-side only. The authoritative split is
// computed by the donation_guard trigger in supabase/sql/donations.sql; if this
// floor ever changes, the trigger should grow a matching minimum so a crafted
// request can't mint a $1 tip. See docs/LAUNCH_CHECKLIST.md §6.4.
export const DONATION_PRESETS_CENTS = [600, 1000, 2500, 5000, 10000];
export const DONATION_MIN_CENTS = 600;
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
/**
 * Always 0. Tips are paid in credits, and credits were already taxed when they
 * were bought.
 *
 * This used to return 6% of the tip and the UI showed it as "Est. tax" on top of
 * the amount. The server never charged it — `tip_post_internal` writes
 * `tax_cents = 0` — so the app was displaying a tax line that no one collected
 * and no one remitted. Two separate problems: the arithmetic shown to the donor
 * didn't match what left their balance, and presenting a "tax" you don't remit
 * is not a rounding error.
 *
 * It also would have been wrong to start charging it. Credits are bought through
 * Apple and Google, who are merchant of record and already collect and remit
 * sales tax on that purchase. Adding 6% again at spend time would tax the same
 * money twice.
 *
 * Kept as a function returning 0, rather than deleted, so the breakdown type and
 * every caller stay stable.
 */
export function donationTaxCents(_amountCents: number): number {
  return 0;
}
/** What the donor is charged. Equal to the tip — see donationTaxCents. */
export function donationTotalChargeCents(amountCents: number): number {
  return amountCents;
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
  // 'insufficient' = not enough credits. Distinct from 'unavailable' because it
  // is the one failure the user can actually fix — it should route them to buy
  // credits, not show a generic error.
  | { ok: false; reason: 'not_premium' | 'self' | 'unavailable' | 'signed_out' | 'insufficient' };

/**
 * Shared path for both tip targets. The amount is spent from the CREDITS balance
 * through a server-side RPC that computes the fee and split itself
 * (supabase/sql/ledger_spend.sql).
 *
 * The old path was a bare client INSERT into `donations`, which meant a tip could
 * be conjured without anyone paying for it — two accounts could mint a
 * withdrawable balance at will. The client no longer decides any of the numbers:
 * it names a target and an amount, and even the amount is bounds-checked server
 * side.
 *
 * One implementation on purpose. Livestream tips were secured first and studio
 * tips were left on the old path, which is exactly the kind of drift that happens
 * when the same logic is written twice.
 */
async function tipViaRpc(
  fn: 'tip_with_credits' | 'tip_studio_with_credits',
  target: Record<string, string>,
  amountCents: number,
  message: string,
  legacyFallback: () => Promise<DonateResult>,
): Promise<DonateResult> {
  const amount = Math.round(amountCents);
  if (!(amount >= DONATION_MIN_CENTS)) return { ok: false, reason: 'unavailable' };
  try {
    const { data, error } = await supabase.rpc(fn, {
      ...target,
      p_amount_cents: amount,
      p_message: message.trim().slice(0, 200) || null,
    });
    if (!error && data) return { ok: true };

    const msg = `${error?.message ?? ''}`.toLowerCase();
    // The ledger refuses to settle an account below zero, so "not enough credits"
    // arrives as its insufficient-funds error rather than a bespoke check.
    if (msg.includes('insufficient funds')) return { ok: false, reason: 'insufficient' };
    if (msg.includes('cannot_tip_self')) return { ok: false, reason: 'self' };
    if (msg.includes('amount_out_of_range')) return { ok: false, reason: 'unavailable' };
    if (msg.includes('not_signed_in')) return { ok: false, reason: 'signed_out' };
    // Pre-migration (ledger_spend.sql not applied) — fall back so tipping keeps
    // working rather than breaking on a database that hasn't caught up.
    if (msg.includes('could not find') || msg.includes('does not exist')) {
      return legacyFallback();
    }
    return { ok: false, reason: 'unavailable' };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/** Tip the host of a LIVESTREAM, paid from the credits balance. */
export async function donate(streamId: string, amountCents: number, message = ''): Promise<DonateResult> {
  return tipViaRpc('tip_with_credits', { p_stream_id: streamId }, amountCents, message,
    () => donateTo({ stream_id: streamId }, amountCents, message));
}

/** Tip the host of a LIVE STUDIO broadcast. Same ledger path as a livestream tip
    — only the host lookup differs (studio_sessions instead of live_streams). */
export async function donateStudio(sessionId: string, amountCents: number, message = ''): Promise<DonateResult> {
  return tipViaRpc('tip_studio_with_credits', { p_session_id: sessionId }, amountCents, message,
    () => donateTo({ studio_session_id: sessionId }, amountCents, message));
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
