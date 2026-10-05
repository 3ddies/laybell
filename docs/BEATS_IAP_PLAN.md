# Beats / money: move to direct IAP as the primary rail (PLAN — review before any code)

**Status (2026-10-05):** beats slice BUILT (uncommitted on `dev`), app typecheck clean.
Adversarial money-review **round 1** found one Critical mint vector (duplicate webhook +
price-only intent fallback → a second beat for one payment) plus Highs (swallowed second
charge, exclusivity-trigger drift, refund-match fragility, item-cancellation nulling
Premium) — **all fixed**. **Round 2** confirmed those closed and found two more — a High
(refunded make-whole credits weren't clawed back) and a Medium (lease double-charge on an
IAP/credits race) — **both fixed** (payments row is now the single refund authority: revoke a
delivered beat OR reverse make-whole credits, absorbing if spent; slot-taken always makes
whole). **Round 3** (a tight delta check) stalled on an infra watchdog mid-run at its final
schema fact-check; those facts were confirmed manually against `shop_multi.sql` (the orders
unique index is total, `refunded_at`/status-check support the refund flip, reversals are
event-keyed-idempotent) and the deltas hold. **Round 4** (a fresh full independent pass over the final files)
returned **SHIP — money-safe**: no Critical/High/Medium across all ten attack categories; two
LOW defense-in-depth notes applied (make-whole ledger-leg order to match the credit path's
lock order; an alert on an unrecognized `laybell_item_*`/`laybell_credits_*` product). **Money
review COMPLETE — no open findings.** **NOT deployed, committed, or run.** Spotlight IAP and
the finalize-edge-fn fallback are deferred follow-ups.

The round-1 fixes: idempotency is now the processor event across every branch (new
`shop_iap_payments(source,event_id)` + every ledger leg keyed on the event id); delivery
resolves an intent ONLY by its tag (no price guess) and otherwise makes the buyer whole in
credits; a genuine second charge is credited, not swallowed; a deploy-time guard refuses to
install unless the live precheck/delivery triggers carry `FOR UPDATE`; refunds match
transaction_id OR original_transaction_id scoped per store; item cancellations route to the
refund handler and the subscription branch is guarded against consumables.

⚠️ **Owner release-gate:** each `laybell_item_N` product's price in App Store Connect / Play
MUST be exactly $N/100 — the DB can't see the store price, so a misconfiguration would
deliver tier value for a smaller charge.

Project rule: money code is reviewed before it runs (past reviews found 11 money bugs, 6 could
mint money — this one makes 12 found-before-ship).

Files in the slice: `lib/pricing.ts` (ladder), `supabase/sql/shop_iap.sql` (intents +
begin/deliver/poll/refund RPCs), `supabase/functions/revenuecat-webhook/index.ts` (item
deliver + refund branches), `lib/purchases.ts` (`purchaseItem`), `lib/shop.ts`
(`beginIapOrder`/`pollIapOrder`), `app/shop/new-listing.tsx` (tier picker),
`app/shop/listing/[id].tsx` (Buy + Use-credits), `lib/i18n.ts` (strings).

## Decision
Make **Apple IAP ("A") the primary, one-tap way to pay** wherever it's a clean fixed-price
purchase. **Keep the credits system** as the secondary/"bonus" rail and the funding source
for variable-amount features. **Do NOT build the US web-checkout ("B")** — it would make
Laybell the tax merchant-of-record (multi-state sales tax + marketplace-facilitator + 1099),
which Apple-as-MoR currently shields us from. **Existing credit balances are preserved.**

Per feature:
| Feature | Primary | Secondary | Why |
|---|---|---|---|
| **Beats (Shop)** | **A** — per-beat IAP, tiered price | credits ("use balance") | the impulse buy; one tap |
| **Spotlight** | **A** — IAP per package | credits | its packages are already fixed → map 1:1 to IAP tiers |
| **Tips** (live/studio) | **credits** | A tip-tier buttons (optional) | rapid live tipping + any amount; a payment sheet per tip is bad UX |
| **Ads** | **credits** | — | advertisers set arbitrary budgets ($5…$500) that can't be IAP tiers |

## Why this shape (from the credits/ledger audit)
- Credits are **load-bearing**: all money features move value through one **append-only,
  sums-to-zero ledger** (`supabase/sql/ledger.sql`). Credits = spend-only/non-cashable (a
  deliberate money-transmitter-licensing boundary); Apple-as-MoR avoids sales-tax/1099 duties.
  Don't rip them out.
- Beat prices are **arbitrary ($0–$10k)** (`shop.sql`, `shop_multi.sql`) → **cannot** map 1:1
  to Apple's fixed IAP price tiers → beats must move to a **tier price-picker** for A.
- Removing the credits buffer **raises refund exposure** — see Money-safety.

## How A and credits coexist on a beat
- A listing's sell/lease price becomes one of Apple's **fixed IAP price tiers** (seller picks
  from a list).
- Listing shows a primary **"Buy $X.99"** → native IAP sheet (one tap).
- If the viewer's credit balance ≥ price, also show a secondary **"Use credits"** (the existing
  `CreditConfirmDialog` path, `shop_buy_with_credits`).
- Both deliver the beat and credit the seller **identically through the ledger**. Apple takes
  its cut on the direct IAP OR (already) on the credit pack — never both.

## Data-model changes
- **Pricing:** constrain `shop_listings.sell_price_cents`/`lease_price_cents` to the allowed
  tier cents (shared `PRICE_TIERS` list in lib + a SQL check). One-time migrate existing
  listings to the **nearest** tier (with a one-time "review your price" nudge to sellers).
  **Ladder (decided 2026-10-04):** `$4.99, 9.99, 14.99, 19.99, 24.99, 29.99, 34.99, 39.99,
  49.99, 59.99, 69.99, 79.99, 99.99, 129.99, 149.99, 199.99, 249.99, 299.99, 399.99, 499.99,
  699.99, 999.99` (22 points; floor $4.99, cap $999.99 ≈ the $1k top of what beats sell for).
  Beats priced **above** the ladder → **credits-only** (buyer tops up; direct IAP covers the
  rest). Apple supports price points above $999.99 by request if ever needed.
- **New IAP products:** a ladder of consumable products, one per tier
  (`laybell_item_099`, `_199`, …), mapped **server-side** (explicit map like the existing
  `CREDIT_PRODUCTS`, so a spoofed/mispriced product can't underpay). Spotlight packages become
  their own products.
- **Ledger shape unchanged.** A direct-IAP beat posts: buyer funded by Apple
  (`source=apple_iap|google_play`) → `earnings +payout` (seller) + `platform +fee`, via
  `ledger_post`, idempotent on `(source, external_id=event.id)`. **No credits leg.**

## Purchase / delivery flow (A) — server-authoritative
1. Client taps "Buy $X.99" → RevenueCat purchase of the listing's tier product, carrying
   `listing_id` + `kind` (sell/lease/offer) as metadata.
2. **Webhook** (`supabase/functions/revenuecat-webhook`) on `NON_RENEWING_PURCHASE` of an
   item product: instead of granting credits, it **delivers the beat** — runs the same
   exclusivity-locked order path (`shop_order_precheck` / `shop_order_delivered`,
   `shop_exclusivity_lock.sql`'s `FOR UPDATE` so an exclusive beat can't double-sell) and
   posts the ledger legs. Idempotent on the RC event id.
   - ⚠️ Delivery + payout MUST be driven from the **verified webhook**, never the client, so a
     spoofed client can't claim delivery or set the price.

## Seller UX
- Listing create/edit price field → a **tier picker** (segmented/dropdown of allowed price
  points) instead of a free-form amount.

## Existing credit balances
- **Preserved.** Credits-spend stays as the secondary option on beats; credit packs stay
  buyable (`app/credits.tsx`) for tips/ads/topping up. No refund/migration needed.

## Money-safety — the real risk is REFUNDS (needs an owner decision)
- Today credits buffer refunds (an Apple refund reverses credits; `ledger_post` refuses a
  negative balance). Direct IAP removes that buffer: if Apple refunds a beat **after** the
  seller's payout hold clears and they withdraw, the platform eats the loss.
- Apple's refund window can be **~90 days**; the current payout hold is **14 days**
  (`payouts.sql`). That's a gap.
- **Options (pick one):**
  1. Accept a small refund-loss rate (typical for digital marketplaces; $X.99 chargebacks are low-volume).
  2. Lengthen the payout hold on direct-IAP sales.
  3. Claw back a refund from the seller's balance / future earnings (needs a platform-absorbs-then-recovers path; the ledger currently refuses negative user balances).
  4. Hold a small platform reserve.
- → **CHOSEN (v1, 2026-10-04):** keep the current 14-day hold + **absorb** the rare late refund
  (option 1). No seller clawback yet; revisit if the refund rate ever climbs.
- The refund webhook (already reverses credit refunds) extends to reverse a delivered beat's
  ledger legs + mark the order refunded + (per policy above) claw back or absorb.
- **Preserve:** ledger append-only + sums-to-zero + idempotency; the exclusivity `FOR UPDATE`
  locks.

## Apple compliance
- Everything stays IAP (no external card forms) → compliant. Spending pre-bought credits is
  also Apple (consumables). Offering both IAP + credits on one listing is fine.

## Phasing (NO OTA → each ships in a build)
1. **Beats** → tier pricing + direct IAP primary, credits secondary. (Biggest value.)
2. **Spotlight** → direct IAP (packages already fit).
3. *(optional, later)* tip-tier IAP buttons alongside credits.
- **Ads** unchanged (credits).

## Decided (owner, 2026-10-04) — was "open questions"
1. **Refund policy** → keep the 14-day hold + absorb the rare late refund (no clawback in v1).
2. **Price-tier ladder** → the 22-point ladder above, floor **$4.99**, cap **$999.99**; beats
   above the cap are credits-only.
3. **Migrating existing listings** → round to the **nearest** tier + a one-time seller nudge.

**Next gate:** owner gives the go-ahead → I write the code → money-review before it ships
(no money code until then). Remaining owner setup when we build: create the IAP products
(~22 beat tiers + the Spotlight packages) in App Store Connect **and** Google Play.

## Files/tables (from the audit)
`lib/purchases.ts` (item products + purchase), `lib/shop.ts` (buy path, tiers),
`app/shop/*` (price picker, buy button), `supabase/functions/revenuecat-webhook` (deliver-on-
purchase + refund reverse), `supabase/sql/shop*.sql` (tier check, deliver RPC), `lib/i18n.ts`.
Ledger (`ledger.sql`) shape unchanged. Reconcile schema edits across the `_RUN_*` /
`money_hardening_*` bundle files too.

---

# Build spec — grounded in the current code (2026-10-04)
*For the money-review. **No money code is written yet**; this is the change list.*

## Facts the code audit established (anchors for the changes below)
- The **client never grants value; the webhook is the only money authority** (deliberate anti-mint). Credit grants are already **async**: `purchaseCredits()` (`lib/purchases.ts`) returns `'ok'` when the store charged, then the app waits for the webhook → ledger → re-reads balance. **Beats reuse this async pattern** (a brief "unlocking…" state), so it's not a new UX idea.
- The only server grant map is `CREDIT_PRODUCTS` (id→cents) **inside the webhook**; the client file only lists product ids.
- `ledger_post(p_kind, p_legs, p_source, p_external_id, p_memo, p_metadata, p_currency)` — sources enum already includes `apple_iap`/`google_play`; tx kinds include `purchase`/`refund`; **idempotent on `(source, external_id)`**; **refuses a negative user balance** (platform account may go negative); REVOKEd → SECURITY DEFINER / service-role only.
- Authoritative shop triggers + the **exclusivity `FOR UPDATE` lock** (`shop_order_precheck` / `shop_order_delivered`) live in **`shop_exclusivity_lock.sql`** (redefined in 4 files, latest wins). Edit THAT file or a new later migration — never the earlier copies.
- `shop_orders.status` CHECK = `requested/delivered/declined/cancelled/refunded` (**no `awaiting_payment`**). Prices are free-form `0…1,000,000` cents — **no tier constraint anywhere** today.
- Payout hold = `payout_hold_days()` = **14 days**, stamped as `available_at` on the seller's `earnings` leg at earn time.

## THE hard design question: how does a purchase reach the right listing?
The webhook reads only `event.{app_user_id, type, product_id, id, store}` — it **cannot tell which listing was bought**. Recommended approach (the money-review must bless this):
1. **Pre-create order (server RPC `shop_begin_iap_order(p_listing_id, p_kind)`):** re-reads listing `FOR UPDATE`, validates active + exclusive-not-sold, resolves price from the kind's column, asserts price ∈ tiers, inserts a `shop_orders` row status **`awaiting_payment`** (new status) with the price snapshot + a ~15-min expiry, returns `{order_id, product_id}` (`product_id = laybell_item_<cents>`).
2. **Purchase (client `purchaseItem(productId, orderId)` in `lib/purchases.ts`):** set RC subscriber attribute `$laybellPendingOrder = orderId`, then `Purchases.purchaseProduct(productId)`.
3. **Deliver (webhook = authority):** new branch for `laybell_item_*` — read `event.subscriber_attributes.$laybellPendingOrder` for the order_id (fallback: oldest `awaiting_payment` order for this buyer at that tier), then call definer RPC `shop_deliver_paid_order(p_order_id, p_source, p_external_id=event.id)` that re-locks the listing `FOR UPDATE`, asserts the order is still `awaiting_payment` + price matches the tier, posts the ledger tx (below), flips the order to `delivered`, and runs the same exclusivity side-effects as `shop_order_delivered`. **Idempotent on both** `(source, event.id)` (ledger) **and** the order-state guard (retry = no-op).
4. **Client reflects delivery:** `listing/[id].tsx` shows "unlocking…" and polls `shop_poll_iap_order(order_id)` until `delivered`.
- **Hardening fallback** (use only if a sandbox/device test shows RC does NOT reliably deliver `subscriber_attributes` on a consumable webhook): add a thin edge fn `shop-finalize-iap` the client calls post-purchase; it verifies the transaction via the RC REST API and calls the same `shop_deliver_paid_order` keyed on the store `transaction_id`. Webhook stays as backstop.

## Ledger legs for a direct-IAP beat sale (mirror the credits economics; `source=apple_iap|google_play`)
`ledger_post('purchase', [ {seller earnings +payout, available_at: now()+hold}, {platform +fee}, {platform −price} ], source, 'shop-iap:'||order_id)` — where `fee = round(price*shop_fee_rate())`, `payout = price − fee`. Sums to zero; platform ends **−payout**, exactly like the credits path; **no buyer-credits leg**. The "Use credits" path (`shop_buy_with_credits`) is untouched.

## Price tiers
- New `lib/pricing.ts` exports the `PRICE_TIERS` (cents) ladder; mirrored by a SQL `shop_price_tiers()` immutable fn.
- SQL (new later migration): CHECK on `sell_price_cents`/`lease_price_cents` = `0 OR ∈ tiers`; keep the $10k caps; one-time `update` rounding existing off-tier prices to **nearest** + a flag for the seller nudge.
- `app/shop/new-listing.tsx`: replace the free-form `priceInput` TextInput with a **tier picker**. A beat whose intended price exceeds the top tier → **credits-only** (no IAP button).

## New IAP products (owner creates in ASC **and** Play at build time)
- 22 consumables `laybell_item_499 … laybell_item_99999` (one per tier).
- Spotlight: `laybell_spotlight_12h/_1d/_3d/_7d` (= `spotlight_package()` 599/1099/2499/4999).
- Webhook gains `ITEM_PRODUCTS` (product→cents) + `SPOTLIGHT_PRODUCTS` (product→package_key). Unlisted product → ignored (anti-mint, same rule as credits).

## Buy UI (`app/shop/listing/[id].tsx`)
- Primary **"Buy $X.99"** (IAP: `shop_begin_iap_order` → `purchaseItem` → poll) above the existing **"Use credits"** (shown when balance ≥ price; unchanged `requestToBuy` + `CreditConfirmDialog`).

## Spotlight (`lib/spotlight.ts`, `promo_credits.sql`)
- Add `purchaseCampaignIAP(pkg)` beside the credits `purchaseCampaign`. Webhook delivers via `spotlight_deliver_paid(p_package_key, …)`. Spotlight is **platform-own inventory (no seller)**, so a direct-IAP spotlight has no user balance change → **recommend NOT posting to the ledger at all; just record `ad_payments(provider='apple_iap', status='succeeded')` + activate the campaign** (confirm in review).

## Refunds (v1 = absorb, per the decision above)
- Extend the webhook `REFUND`/`CANCELLATION` branch for `laybell_item_*`: post a reversing `refund` tx `[seller earnings −payout, platform +payout]` + flip the order to `refunded`. If the seller already withdrew (earnings would go negative → `ledger_post` refuses), catch it and post a **platform-absorbs** adjustment so it still reconciles. Return HTTP 200 on absorb (don't make RC retry a legitimately-unrecoverable refund — same convention the credit-refund path already uses).

## Files touched (summary)
- **Client:** `lib/purchases.ts` (+item/spotlight products, `purchaseItem`), `lib/pricing.ts` (new), `lib/shop.ts` (begin/poll + tier validation), `app/shop/new-listing.tsx` (tier picker), `app/shop/listing/[id].tsx` (Buy button + poll), `lib/spotlight.ts` (IAP buy), `lib/i18n.ts` (strings).
- **Edge:** `supabase/functions/revenuecat-webhook/index.ts` (item + spotlight deliver branches, read `subscriber_attributes`, refund reverse/absorb); *(optional)* new `supabase/functions/shop-finalize-iap/`.
- **SQL (one new later migration, not the sealed files):** `shop_price_tiers()`, price CHECK, `awaiting_payment` status, `shop_begin_iap_order`, `shop_deliver_paid_order`, `shop_poll_iap_order`, `spotlight_deliver_paid`, nearest-tier backfill — reusing the `FOR UPDATE` lock + `shop_order_delivered` side-effects.

## Open risks the money-review must sign off
1. **RC `subscriber_attributes` on a consumable webhook** — the linkage in step 3 depends on it; needs a sandbox/device test, else use the finalize-edge-fn + `transaction_id` path.
2. **Order-state idempotency** — the `awaiting_payment → delivered` flip must be a clean no-op on webhook retry (not just the ledger leg).
3. **Spotlight-own-inventory ledger shape** — confirm "record `ad_payments`, don't ledger it."
4. **Webhook auth is a shared bearer secret, not HMAC** — a leaked `REVENUECAT_WEBHOOK_SECRET` would now forge *deliveries*, not just credit grants; consider rotation / tighter verification.
