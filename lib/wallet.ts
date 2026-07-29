import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchDonationEarnings } from './donations';
import { fetchDeliveredShopEarningsCents } from './shop';
import { fetchLedgerBalances, heldCents } from './ledger';

// Wallet — what a user has earned on Laybell, and the (SCAFFOLDED) path to move
// it to their bank.
//
// The balance shown here is deliberately conservative: it counts ONLY money
// Laybell actually collected (see the flags below), which today is nothing. Every
// earning source is currently either simulated or settled directly between users,
// so no transfer can be offered — presenting those figures as a withdrawable
// balance would promise money the company never held.
//
// A payout method is stored locally as a display-only label (never real account
// numbers), and "Transfer" is inert until a processor lands. A real Stripe Connect
// flow swaps in here by flipping the flags and replacing requestPayout.

// ── What may be counted as a BALANCE ─────────────────────────────────────────
// A wallet balance is a promise: "Laybell is holding this money for you and will
// send it to your bank." That promise is only honest for money Laybell actually
// COLLECTED.
//
// These two flags were the interim gate while earnings were derived by summing
// simulated rows. Once supabase/sql/ledger.sql is applied they are SUPERSEDED:
// the ledger can only contain money a processor actually settled, because the
// only way to create a balance is a server-side posted transaction. Keep them as
// the kill switch for the payout RAIL (payoutsAvailable), not as a balance filter.
// Both are false today:
//
//   • Donations are recorded by a client-side insert with no payment processor
//     behind them (lib/donations.ts) — nothing was ever charged. Flip to true only
//     once tips are charged server-side and settle into a Laybell-controlled
//     account.
//   • Shop sales are OFF-PLATFORM by design — the app tells the buyer "Laybell
//     doesn't process payments — you arrange payment with the seller in chat", so
//     the seller was already paid 100% directly. Counting 85% of the same sale as
//     a withdrawable balance would be paying that money a second time. Flip to
//     true only if the shop moves on-platform (escrowed through the processor).
//
// Until then the earnings are still shown — as a LIFETIME record of what the
// creator made — but they are not withdrawable and must never be presented as
// funds awaiting transfer.
export const PLATFORM_COLLECTS_DONATIONS = false;
export const PLATFORM_COLLECTS_SHOP = false;

export type WalletBalance = {
  /** Money Laybell holds and could actually pay out. Drives the Transfer flow. */
  totalCents: number;
  /** Lifetime earnings, collected or not — display only, never withdrawable. */
  lifetimeCents: number;
  /** Earned but still inside its hold window (chargeback protection). */
  heldCents: number;
  donationCents: number;
  shopCents: number;
  /** True while some earnings above were settled outside Laybell (shop-in-DMs). */
  hasUncollected: boolean;
  /** True once the ledger exists and is the source of truth. */
  ledgerReady: boolean;
};

export async function fetchWalletBalance(): Promise<WalletBalance> {
  const [ledger, donations, shopCents] = await Promise.all([
    fetchLedgerBalances(),
    fetchDonationEarnings().catch(() => ({ totalCents: 0, count: 0 })),
    fetchDeliveredShopEarningsCents().catch(() => 0),
  ]);
  const donationCents = donations.totalCents;

  // Once the ledger exists it is AUTHORITATIVE and the derived sums stop being
  // used for money. It structurally guarantees what the flags below only assert
  // by convention: a balance can exist only because a transaction created it, and
  // transactions are only posted server-side after a processor actually settled.
  // The old donation/shop figures stay in the payload purely as a breakdown label.
  if (ledger.ready) {
    return {
      totalCents: ledger.earnings.availableCents,
      lifetimeCents: ledger.earnings.totalCents,
      heldCents: heldCents(ledger.earnings),
      donationCents,
      shopCents,
      hasUncollected: false,
      ledgerReady: true,
    };
  }

  // Pre-ledger fallback: nothing was ever collected, so nothing is withdrawable.
  const totalCents =
    (PLATFORM_COLLECTS_DONATIONS ? donationCents : 0) + (PLATFORM_COLLECTS_SHOP ? shopCents : 0);
  return {
    totalCents,
    lifetimeCents: donationCents + shopCents,
    heldCents: 0,
    donationCents,
    shopCents,
    hasUncollected: totalCents < donationCents + shopCents,
    ledgerReady: false,
  };
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

// ── Transfer ─────────────────────────────────────────────────────────────────
// Inert until a real processor lands. It can only ever be reached with a non-zero
// COLLECTED balance, which the flags above currently make impossible — so this
// records nothing rather than logging a request that will never be honoured.

const LAST_PAYOUT_KEY = 'wallet_last_payout_v1';

export type PayoutRequest = { amountCents: number; at: number };

/** True once Laybell actually collects money it could pay out. */
export function payoutsAvailable(): boolean {
  return PLATFORM_COLLECTS_DONATIONS || PLATFORM_COLLECTS_SHOP;
}

export async function requestPayout(amountCents: number): Promise<{ ok: boolean }> {
  if (amountCents <= 0 || !payoutsAvailable()) return { ok: false };
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
