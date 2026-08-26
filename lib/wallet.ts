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

// ── Transfer ─────────────────────────────────────────────────────────────────
// The real payout rail is lib/payouts.ts → requestPayout(), which goes through
// Stripe Connect.
//
// Two scaffolds used to live here and are gone:
//
// A local "payout method" — a label the user typed, like "Chase ••1234", stored
// in AsyncStorage so the UI could claim they had one. Stripe Connect collects
// the real bank details now, and keeping a parallel fiction that looks like
// banking data is worse than having nothing.
//
// And a fake transfer that wrote an AsyncStorage key and returned { ok: true }.
// Once the ledger made `total` a real non-zero balance the wallet's button went
// live, telling users "this will send your available balance to your connected
// bank account" and then doing nothing at all — no transfer, no error, no
// feedback. Deleted rather than disabled, because that is the worst failure this
// screen can have.

// `payoutsAvailable()` used to live here, and several documents still described it
// as "the kill switch for the payout RAIL". It was DELETED in 1.0.1 because it was
// never wired to anything — and, more to the point, was never needed:
//
//   app/wallet.tsx:146 gates cashing out on `payout.payoutsEnabled`, which comes
//   from Stripe's own `payouts_enabled` on the connected account. That is a real,
//   SERVER-side gate that already knows about verification, restriction and
//   suspension. A client constant could not have improved on it, and with no OTA
//   could not even be flipped in an emergency without shipping a build.
//
// A documented control that does not exist is worse than no control, because it
// gets planned around. If a rail-wide kill switch is ever genuinely wanted, it
// belongs server-side — a flag the app reads, not a constant compiled into it.
