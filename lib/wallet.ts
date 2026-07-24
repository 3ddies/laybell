import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchDonationEarnings } from './donations';
import { fetchDeliveredShopEarningsCents } from './shop';

// Wallet — the money a user has earned on Laybell and the (SCAFFOLDED) path to
// move it to their bank. Balance is REAL (live-donation payouts + delivered shop
// sales, both after Laybell's fee). Payouts are NOT wired to a real processor
// yet: a payout method is stored locally as a display-only label (never real
// account numbers), and "Transfer" records a simulated request. Mirrors the
// donations/shop "simulated" scaffolding — a real Stripe Connect flow swaps in
// here later without changing the screens.

export type WalletBalance = {
  totalCents: number;
  donationCents: number;
  shopCents: number;
};

/** Real earned balance: live-donation take-home + delivered shop-sale take-home. */
export async function fetchWalletBalance(): Promise<WalletBalance> {
  const [donations, shopCents] = await Promise.all([
    fetchDonationEarnings().catch(() => ({ totalCents: 0, count: 0 })),
    fetchDeliveredShopEarningsCents().catch(() => 0),
  ]);
  const donationCents = donations.totalCents;
  return { totalCents: donationCents + shopCents, donationCents, shopCents };
}

// ── Payout method (local scaffold — NO real bank data) ────────────────────────
// We store only a friendly label the user types (e.g. "Chase checking ••1234")
// so the UI can show "you have a payout method". Real account/routing numbers
// are NEVER collected here — that happens inside the processor's SDK later.

const METHOD_KEY = 'wallet_payout_method_v1';

export type PayoutMethod = {
  kind: 'bank' | 'card';
  label: string;   // user-entered display label
  addedAt: number;
};

// Never store or show a full account/card number here. Cards/accounts are often
// typed with spaces or dashes, so treat any digit run totalling 5+ digits as
// sensitive and reduce it to its last 4 (a bare "last 4" or a year is kept). This
// runs on BOTH save and read, so a number a prior build may have persisted gets
// redacted the next time the method loads.
export function maskPayoutLabel(input: string): string {
  return input.replace(/\d[\d\s-]*\d/g, (seq) => {
    const digits = seq.replace(/\D/g, '');
    return digits.length >= 5 ? '•••• ' + digits.slice(-4) : seq;
  });
}

export async function getPayoutMethod(): Promise<PayoutMethod | null> {
  try {
    const raw = await AsyncStorage.getItem(METHOD_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw) as PayoutMethod;
    const safe = maskPayoutLabel(m.label ?? '');
    if (safe !== m.label) {
      // Scrub a full number a prior build may have persisted, on first read.
      m.label = safe;
      AsyncStorage.setItem(METHOD_KEY, JSON.stringify(m)).catch(() => {});
    }
    return m;
  } catch {
    return null;
  }
}

export async function savePayoutMethod(kind: PayoutMethod['kind'], label: string): Promise<void> {
  // Redact any full number BEFORE it ever touches storage.
  const m: PayoutMethod = { kind, label: maskPayoutLabel(label.trim()).slice(0, 40), addedAt: Date.now() };
  await AsyncStorage.setItem(METHOD_KEY, JSON.stringify(m)).catch(() => {});
}

export async function clearPayoutMethod(): Promise<void> {
  await AsyncStorage.removeItem(METHOD_KEY).catch(() => {});
}

// ── Transfer (simulated) ──────────────────────────────────────────────────────
// Records the request locally so the UI can show "transfer pending". No money
// moves until the real processor lands; the balance is unaffected.

const LAST_PAYOUT_KEY = 'wallet_last_payout_v1';

export type PayoutRequest = { amountCents: number; at: number };

export async function requestPayout(amountCents: number): Promise<{ ok: boolean }> {
  if (amountCents <= 0) return { ok: false };
  const req: PayoutRequest = { amountCents, at: Date.now() };
  await AsyncStorage.setItem(LAST_PAYOUT_KEY, JSON.stringify(req)).catch(() => {});
  return { ok: true };
}

export async function getLastPayout(): Promise<PayoutRequest | null> {
  try {
    const raw = await AsyncStorage.getItem(LAST_PAYOUT_KEY);
    return raw ? (JSON.parse(raw) as PayoutRequest) : null;
  } catch {
    return null;
  }
}
