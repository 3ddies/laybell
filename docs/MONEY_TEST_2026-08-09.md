# The money test — 2026-08-09

Every payment path in Laybell, executed against the **live production database**
for the first time. Written the day it ran; this is the evidence, not a plan.

Two halves: a **device half** (real Apple sandbox purchase on the owner's
iPhone) and a **server half** (every other path driven through the real RPCs
with `request.jwt.claims` set transaction-locally, so `auth.uid()` and every
RLS/security-definer check ran exactly as they do for a signed-in user).

`select public.ledger_verify()` returned **zero rows** after every single step.
32 transactions now exist and the double-entry books balance.

---

## What passed

| # | Path | How | Result |
|---|---|---|---|
| 1 | **Buy credits** | iPhone, Apple sandbox, $4.99 Starter | StoreKit → RevenueCat → webhook → ledger. +499¢ credits / −499¢ platform. First purchase in Laybell's history. |
| 2 | **Tip** | `tip_with_credits`, $6.00 | fee **180¢ (30%)** + creator **420¢** with the 14-day hold stamped |
| 3 | **Shop — sell** | `shop_buy_with_credits('sell')`, $2.99 | instant delivery, fee 90¢, seller 209¢ held, listing → `sold`, `sales_count` 1 |
| 4 | **Shop — lease** | `shop_buy_with_credits('lease')`, $1.99 | delivered, fee 60¢, seller 139¢ held, listing stays active (leases are unlimited) |
| 5 | **Shop — free claim (gated)** | `shop_buy_with_credits('free')` by a follower | delivered at 0¢, no ledger movement |
| 6 | **Offer → decline** | offer $1.99, seller declines | escrow held, then refunded — the refund leg mirrors the hold exactly |
| 7 | **Offer → accept** | offer $3.00, seller delivers | escrow released: platform −300, fee +90, seller **+210 held**. Seller's running total 209+139+210 = **558¢**, exact. |
| 8 | **Spotlight** | `spotlight_buy_with_credits('12h')` | −599¢ credits / +599¢ platform, campaign minted `pending` |
| 9 | **Ad Manager fund** | `ad_campaign_fund_with_credits`, $20.00 | −2000¢ credits / +2000¢ platform, campaign → `active` |
| 10 | **Ad pro-rata refund** | `ad_campaign_end` | returned **2000¢** (spent 0, so all of it); credits restored |
| 11 | **Spotlight cancel refund** | `spotlight_cancel_pending` | 599¢ returned, campaign → `canceled` |
| 12 | **Payout onboarding** | Wallet → Set up payouts | Laybell's half proven: link mints, in-app Safari sheet opens, `laybell.app/payouts` return page live. Stripe's own hosted form deliberately not completed (owner's call). |

## Guards that FIRED CORRECTLY under attack

A money system is proven by what it refuses. Each of these was attempted and
each one held:

| Attempted | Refused with |
|---|---|
| $1.00 tip (below the $6 anti-fraud floor) | `amount_out_of_range` |
| Offer on an already-**sold** listing | `listing_not_available` |
| Offer with an empty balance | `insufficient funds: … would settle at -199 cents` |
| Removing a listing that has purchases — **even as a direct superuser UPDATE** | `has_purchases` |
| Follow-gated freebie claimed by a **non-follower** | `free_follow_required` |
| Claiming the same freebie twice | unique violation on `(listing, buyer, kind)` |
| Second ambient stream for the same song inside 24h | silent no-op (per-user cap) |

Every failure rolled its whole transaction back — including seed rows created in
the same statement. No half-states anywhere.

---

## Schema audit (same day)

Parsed all **131** SQL files for every object they declare — **557 total**
(68 tables, 163 functions, 151 columns, 44 triggers, 131 indexes) — and checked
each against production. Result: **557/557 present**, after fixing three real
gaps the audit surfaced:

1. **`current_account_has_reports()`** — missing. Added to
   `account_deletion_sweep.sql` *after* that file was last run (classic drift).
   Called in three places by the deletion flow, wrapped in `try/catch`, so it
   silently read `false` — meaning **an account with open moderation reports
   could delete immediately** instead of being held. Applied and verified both
   polarities: `false` for a clean account, `true` for a genuinely reported one.
2. **`ambient_streams` + `record_ambient_stream()` + trigger + 2 indexes** —
   `record_ambient_stream_rpc.sql` had never been run. The client calls that RPC
   with errors swallowed, so **ambient song plays were never credited to
   artists**. Applied; verified a call credits exactly one stream and the second
   call inside 24h is correctly ignored.
3. **`posts.repost_count` + `sync_post_repost_count()` + trigger** —
   `reposts.sql` was applied *partially*: the table and policies existed, the
   count half didn't. `lib/feedScorer.ts` reads `repost_count` for ranking, so
   reposts contributed nothing. Applied; verified the trigger increments on
   insert and decrements on delete.

One audit line remains and is a **false positive**: `on_auth_user_created` lives
on `auth.users`, not in `public`, and was confirmed present.

---

## Still untested (and why that's acceptable)

- **Android purchase on a device** — owner has no Android hardware for a while.
  The *server* money code is store-agnostic and is now fully exercised; what
  remains untested is the thin client layer (RevenueCat Play SDK + Play
  Billing). **Gate: run the 15-minute purchase test before Android is promoted
  past internal testing.**
- **Stripe's hosted Express form** — the first real creator exercises Stripe's
  own infrastructure. Laybell's side is proven end to end.
- **The live-tip modal UI** — needs two devices; the RPC beneath it is tested.

## Test artifacts left behind

Deliberately, and harmlessly: three `Money-test beat` listings (one `sold` —
the takedown guard refuses to hide a purchased listing, which is correct), the
donation/stream rows, and 32 ledger transactions. The ledger is append-only by
design. `docs/FRESH_START_RESET.md` clears all of it before launch.
