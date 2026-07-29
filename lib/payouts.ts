import { supabase } from './supabase';

// Creator payouts via Stripe Connect.
//
// Laybell never touches a bank account. Stripe Connect Express holds the
// creator's banking details, runs their identity verification, and owns the
// payout rails; this module only asks Stripe for an onboarding link and reads
// back whether that creator can be paid.
//
// That separation is not an implementation preference — routing creator funds
// through a Laybell-controlled bank account would be unlicensed money
// transmission. Stripe holds and moves the money; Laybell instructs it.

export type PayoutStatus = {
  /** A Stripe account exists for this creator (onboarding started). */
  connected: boolean;
  /** Stripe will actually pay them. The ONLY field that means "ready". */
  payoutsEnabled: boolean;
  /** They finished the form — but Stripe may still be verifying. */
  detailsSubmitted: boolean;
};

const NOT_CONNECTED: PayoutStatus = {
  connected: false, payoutsEnabled: false, detailsSubmitted: false,
};

/**
 * Where the creator stands with Stripe. Read live rather than cached: a stored
 * copy goes stale the moment Stripe finishes — or reverses — a verification, and
 * a stale "yes" means offering a payout that fails at the transfer.
 */
export async function fetchPayoutStatus(): Promise<PayoutStatus> {
  try {
    const { data, error } = await supabase.functions.invoke('stripe-connect', {
      body: { action: 'status' },
    });
    if (error || !data) return NOT_CONNECTED;
    return {
      connected: !!data.connected,
      payoutsEnabled: !!data.payoutsEnabled,
      detailsSubmitted: !!data.detailsSubmitted,
    };
  } catch {
    return NOT_CONNECTED;
  }
}

/**
 * Start (or resume) Stripe's hosted onboarding. Returns a URL to open in a
 * browser — never a WebView.
 *
 * Two reasons it must be the system browser: the flow includes identity
 * verification and bank entry, which users are right to want in a browser they
 * recognise; and Stripe's own guidance is that embedded WebViews break parts of
 * the flow. Callers should open it with expo-web-browser or Linking.
 *
 * The same call resumes a half-finished onboarding — Stripe reuses the existing
 * account rather than creating a second one.
 */
export async function startPayoutOnboarding(): Promise<{ url: string } | { error: string }> {
  try {
    const { data, error } = await supabase.functions.invoke('stripe-connect', {
      body: { action: 'onboard' },
    });
    if (error || !data?.url) return { error: data?.error ?? error?.message ?? 'unavailable' };
    return { url: data.url as string };
  } catch (e: any) {
    return { error: e?.message ?? 'unavailable' };
  }
}

/** $25.00. Mirrors payout_min_cents() in supabase/sql/payouts.sql. */
export const PAYOUT_MIN_CENTS = 2500;

/** 14 days. Mirrors payout_hold_days(). Used only to explain the wait. */
export const PAYOUT_HOLD_DAYS = 14;

export type PayoutResult =
  | { ok: true; payoutId: string; transferId: string }
  | { ok: false; error: string };

/**
 * Withdraw cleared earnings to the creator's connected bank account.
 *
 * Everything that matters happens server-side. The Edge Function calls
 * `request_payout` AS THIS USER, so the minimum, the available-balance check and
 * the one-pending-payout constraint are all enforced where they can't be
 * skipped; the ledger is debited BEFORE Stripe is contacted, so a crash
 * mid-transfer leaves a recoverable debit rather than a double payment; and the
 * payout's uuid is Stripe's idempotency key, so a retry returns the original
 * transfer instead of sending the money twice.
 *
 * Error codes worth handling in the UI: `below_minimum`,
 * `insufficient_available`, `payout_already_pending`, `no_connected_account`,
 * `payouts_not_enabled`, `transfer_failed`.
 */
export async function requestPayout(amountCents: number): Promise<PayoutResult> {
  if (!Number.isFinite(amountCents) || amountCents < PAYOUT_MIN_CENTS) {
    return { ok: false, error: 'below_minimum' };
  }
  try {
    const { data, error } = await supabase.functions.invoke('stripe-connect', {
      body: { action: 'payout', amountCents: Math.floor(amountCents) },
    });
    if (error || !data || data.error) {
      // Postgres raises arrive as full exception messages; reduce them to the
      // bare code so callers can match on it.
      const raw = String(data?.error ?? error?.message ?? 'payout_failed');
      const known = [
        'below_minimum', 'insufficient_available', 'payout_already_pending',
        'no_connected_account', 'payouts_not_enabled', 'transfer_failed',
      ].find((c) => raw.includes(c));
      return { ok: false, error: known ?? raw };
    }
    return { ok: true, payoutId: String(data.payoutId), transferId: String(data.transferId) };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'payout_failed' };
  }
}

export type PayoutRow = {
  id: string;
  amount_cents: number;
  status: 'pending' | 'paid' | 'failed' | 'reversed';
  failure_reason: string | null;
  created_at: string;
};

/** Payout history. Readable by its owner only (RLS in payouts.sql). */
export async function fetchPayouts(limit = 20): Promise<PayoutRow[]> {
  try {
    const { data } = await supabase
      .from('payouts')
      .select('id, amount_cents, status, failure_reason, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    return (data ?? []) as PayoutRow[];
  } catch {
    return [];
  }
}
