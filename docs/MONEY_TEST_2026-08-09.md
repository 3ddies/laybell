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

### Second pass — the paths that needed hardware, minus the hardware

| # | Path | Result |
|---|---|---|
| 13 | **Studio tip** (`tip_studio_with_credits`) | $7.00 → fee **245¢ (35%)**, host **455¢**. This is the *standard* fee branch — the livestream tip hit 30% because that host is Premium+. **Both branches of `tip_fee_rate()` are now proven.** |
| 14 | **The Premium+ tip-fee fix, verified live** | `3ddiehall` has ONLY `premium_plus_until` set (no `premium_until`) and still gets 0.30. That is exactly the bug `premium_plus.sql` closed — a Premium+ subscriber paying the standard 35%. Confirmed fixed in production. |
| 15 | **Stripe Express account creation** | A real connected account, **`acct_1U2cMeDkLCwypdLC`**, exists on the owner's profile. The tap that opened the sheet genuinely called Stripe's API, created the Express account, persisted the id, and minted an onboarding link. The Laybell↔Stripe integration is proven end to end; only Stripe's own hosted form is unexercised. |

### More guards, attacked in the second pass

| Attempted | Refused with |
|---|---|
| Payout of $25 with $5.58 earned (all held) | `insufficient_available` |
| Payout below the $25 minimum | `below_minimum` |
| **Minting a live Spotlight for $0** by inserting the campaign row directly (July review exploit #1) | `spotlight_must_use_rpc` |
| **Erasing an advertiser's own spend meter** (July review exploit #2) | `protected_column` |
| **Funding a campaign at a $0.01 CPM bid** (July review exploit #3) | silently clamped to the 1000¢ floor |

Three of the six money-minting exploits from the July adversarial review were
re-attacked here as a live client would, and all three are dead.

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

## Still untested — three things, and each needs a human or hardware

These are not deferrable-by-choice; they are the residue that no amount of
server-side work can reach.

1. **An Android purchase on a real device.** No Android hardware available. The
   server money code is store-agnostic and fully exercised, so what remains
   untested is the thin client layer (RevenueCat Play SDK + Play Billing).
   **Gate: run the 15-minute purchase test before Android is promoted past
   internal testing.**
2. **Stripe's hosted Express form.** Laybell's entire half is proven (account
   created, link minted, sheet opens, return page live). What is untested is a
   human typing an SSN and bank details into Stripe's own page — which is
   Stripe's infrastructure, and not something to automate on the owner's real
   account. The first real creator exercises it.
3. **The live/studio tip modal UI.** Needs two devices in one room. The RPC
   underneath it is now tested on both fee branches (#13), so what is unproven
   is the button, the amount pills, and the broadcast overlay — UI, not money.

Everything else that could be tested, was.

## Test artifacts left behind

Deliberately, and harmlessly: three `Money-test beat` listings (one `sold` —
the takedown guard refuses to hide a purchased listing, which is correct), the
donation/stream rows, and 32 ledger transactions. The ledger is append-only by
design. `docs/FRESH_START_RESET.md` clears all of it before launch.
