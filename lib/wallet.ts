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

export async function getPayoutMethod(): Promise<PayoutMethod | null> {
  try {
    const raw = await AsyncStorage.getItem(METHOD_KEY);
    return raw ? (JSON.parse(raw) as PayoutMethod) : null;
  } catch {
    return null;
  }
}

export async function savePayoutMethod(kind: PayoutMethod['kind'], label: string): Promise<void> {
  const m: PayoutMethod = { kind, label: label.trim().slice(0, 40), addedAt: Date.now() };
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
