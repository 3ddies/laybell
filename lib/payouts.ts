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
