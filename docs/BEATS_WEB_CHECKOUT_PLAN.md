# Web Beat Checkout — Scoping Plan

**Status (corrected 2026-11-21): the technical rail IS BUILT + test-passed — this is NOT scope-only.**
The Stripe web-checkout was implemented on branch **`web-payments`** (commits `e7b2f8f` → `4fea49d` → `d51eb0a`, all 2026-11-06), ~1,156 lines:
`supabase/functions/stripe-checkout/` + `stripe-webhook/` (signature-verified, idempotent on the Stripe event id), `supabase/sql/shop_stripe.sql` (498 ln) + `shop_web_downloads.sql`, a **Buy-with-card** button on `/listing` (`web-app/app/listing/[id]/ListingActions.tsx`), and a **`/purchases`** download hub. It was money-reviewed (5 findings fixed in `4fea49d`), DEPLOYED to prod Supabase in **TEST mode**, secrets set to a dedicated `STRIPE_SHOP_SECRET_KEY` (test key, so a test buy can't charge a real card / touch the live payouts key), and an end-to-end **4242 purchase PASSED** (delivered + ledger balanced).
**Go-live is gated on BUSINESS/OWNER steps, not building** — see the new §0.1. The analysis in §3–§10 still stands as the decision framework. Written 2026-11-19; companion to `docs/BEATS_IAP_PLAN.md` (the mobile/IAP rail, already live).

---

## 0.1 What's left to go live (the real plan — resume here)

The code is essentially done + test-passed. Remaining is review, two business decisions, a merge, and a key flip:

1. **Owner's final adversarial money review (HARD GATE).** A code money-review already fixed 5 findings, but the owner's sign-off + a fresh adversarial pass over the final files is the bar before any live key ("always review money code before it runs"). Checklist in §8.
2. **Decision — merchant-of-record / sales tax (§3).** The build uses Stripe directly ⇒ **Path B ⇒ Laybell is the MoR** and must register/remit sales tax where it has nexus. Confirm with an accountant, or switch to Path A (Paddle/LemonSqueezy) — but that re-plumbs payouts. *This is the long pole.*
3. **Decision — fee policy (§10.2).** Keep the shop fee and bank the ~$2+/sale web margin, or cut the fee so sellers earn more? Who absorbs the Stripe fee? (A per-rail `web` commission already makes this config, not code.)
4. **Merge.** `web-payments` is ~1 commit behind `dev`. Merge it to `dev`, AND merge the current web-polish branch (`feature/subject-lift-stickers`) to `dev` — both touch `globals.css`, `listing/[id]/page.tsx`, `login/page.tsx`, `AuthNav.tsx`, so expect small conflicts.
5. **Flip to live.** Set `STRIPE_SHOP_SECRET_KEY` + the webhook secret to the LIVE values at go-live (currently test). Re-run the Stripe-deploy-drift + schema audits near launch.
6. **Verify on prod web.** After deploy, do one real small live purchase on `laybell-web` → confirm Buy → webhook delivers → `/purchases` download → ledger legs balance, then refund it.
7. **Apple anti-steering (§7).** Keep the iOS app from linking to web purchase; web sells independently, no cross-link.
8. **Scope v1 (§10.3).** Confirm: logged-in buyers only (recommended), leases + exclusive sells first, offers/free-claims later.

---

## 0. TL;DR

Selling beats directly on `laybell-web` is **mostly assembly, not new invention** — the hard parts (a Stripe account, Connect payouts, a server-authoritative delivery + ledger pipeline, web login) already exist. The web rail mirrors the proven IAP rail, swapping RevenueCat for Stripe.

The one genuine decision is **who is the merchant of record for sales tax** — which is *why* `BEATS_IAP_PLAN.md` deliberately skipped US web checkout: on IAP, Apple/Google are the MoR and remit tax worldwide. On the web, Laybell (or a MoR platform) takes that on.

The economic upside is large: a web sale skips the 15–30% store cut, taking Laybell from **~$0 net per IAP beat to ~$2+ per web beat** (§5).

---

## 1. Why it was skipped before, and what changed

`BEATS_IAP_PLAN.md` (decided 2026-10-04): *"US web-checkout ('B') SKIPPED — it would make Laybell the tax merchant-of-record; Apple-as-MoR shields us."* Nothing technical blocked it; the tax burden did.

Revisiting now because the margin case is strong and the delivery/ledger machinery is already built and money-reviewed. The tax question is unchanged — it's the pivot of §3.

---

## 2. What already exists (reuse, don't rebuild)

- **Stripe account + Stripe Connect Express** — `supabase/functions/stripe-connect/index.ts`. Sellers already onboard, KYC, connect bank accounts; Laybell transfers from its Stripe balance to the connected account on a 14-day hold. **Buyer payments can use the same Stripe account; payouts need no change.**
- **Server-authoritative delivery + append-only ledger** — `supabase/sql/shop_iap.sql` + `revenuecat-webhook`. Pattern: pre-create an `awaiting_payment` order → a *verified webhook* (never the client) delivers the file and posts balanced ledger legs, idempotent on the event id, under the exclusivity `FOR UPDATE` lock. Survived 5 rounds of money review.
- **Shop order model** — `shop_orders` (kind sell/lease/free/offer), price snapshot at insert, `shop_order_precheck` / `shop_order_delivered` triggers, storage RLS that unlocks the deliverable only for the buyer of a delivered order.
- **Web login (Tier 2)** — the buyer can be authenticated on the web, so the order keys to their real `buyer_id` and the existing storage-RLS download works unchanged.
- **Seller sales surfacing** — `shop_seller_paid_sales` RPC (added 2026-11-19) already counts web + app sales identically.

---

## 3. The open decision — merchant of record / tax

| | **A. MoR platform (Paddle / LemonSqueezy)** | **B. Stripe + Stripe Tax** |
|---|---|---|
| Who is the legal seller | The platform (Paddle/LS) | **Laybell** |
| Tax / VAT worldwide | Platform calculates, collects, **remits, and files** | Stripe calculates; **Laybell registers + remits + files** where it has nexus |
| Fee | ~5–8% all-in | ~2.9% + $0.30 (Stripe) + Stripe Tax ~0.5% |
| Time to launch | Fastest | Medium (tax registration is the long pole) |
| Ongoing burden | Minimal | Real: nexus tracking, filings |
| Control / UX | Platform-hosted checkout, their branding on receipts | Fully your checkout + receipts |
| Connect payouts | Awkward — platform holds funds, so seller payout needs its own path | Clean — reuses existing Connect rails as-is |

**Engineering note:** Path B drops straight onto the existing Connect payout rails (platform collects → ledger → 14-day-hold transfer), so it's *less* new code despite more compliance. Path A offloads tax but means re-plumbing payouts around the MoR holding the money.

**This is a legal/business call — confirm tax specifics with an accountant before committing.** Not personalized tax advice.

---

## 4. Architecture (the build — mirrors the IAP rail, Stripe for RevenueCat)

Assuming **Path B (Stripe)**; Path A swaps the processor but keeps the shape.

1. **Checkout** — new edge fn `shop-web-checkout`: auth'd buyer → pre-create an `awaiting_payment` order (price snapshot, kind) → create a **Stripe Checkout Session** (hosted; PCI handled by Stripe) with metadata `{ order_id, listing_id, buyer_id, kind }` and success/cancel URLs back to the web listing page. Return the session URL; web redirects.
2. **Payment** — Stripe hosts the card form. Nothing sensitive touches Laybell.
3. **Webhook** — new edge fn `stripe-shop-webhook`, **verifying Stripe's HMAC signature** (`stripe-signature` header — stronger than the RC bearer secret). On `checkout.session.completed` (or `payment_intent.succeeded`): re-derive price from the order (never trust client), deliver via the existing delivery RPC, post ledger legs **with NO store commission**, idempotent on the **Stripe event id**. On `charge.refunded`: reverse per the "absorb the rare refund" policy.
4. **Delivery** — order → `delivered`; the web shows a signed download URL via the same storage-RLS gate the app uses.
5. **Payout** — unchanged: seller earnings post to the ledger (payout on the 14-day hold) and move through the existing Connect transfer.

**Key invariants carried over from the IAP review:** webhook is the SOLE money authority (client never grants); idempotency keyed on the processor event id (anti double-delivery); price snapshot at insert (anti price-swap); exclusivity `FOR UPDATE` lock (anti double-sell of an exclusive); every new SECURITY DEFINER fn `revoke execute ... from public, anon, authenticated` **by name** + a C2 preflight (the anon-grant gotcha bit the IAP path — see `BEATS_IAP_PLAN.md`).

---

## 5. Economics — net per sale (illustrative, current 30% store cut + 30% shop fee)

For a **$9.99 lease** (ledger today: seller +699, platform +300 fee, platform −999):

| Rail | Buyer pays | Processor/store takes | Seller nets | **Laybell nets** |
|---|---|---|---|---|
| **IAP (today)** | $9.99 | Apple $3.00 (30%) | $6.99 | **~$0.00** (fee just covers Apple) |
| **Web — Stripe (B)** | $9.99 | Stripe ~$0.59 | $6.99 | **~$2.41** |
| **Web — MoR (A)** | $9.99 | ~$0.80 (≈8%) | $6.99 | **~$2.20** |

Web turns a **break-even** IAP beat into **$2+ of margin** — *or* you keep margin flat and **cut the shop fee so sellers earn more** (e.g. 15% web fee → seller nets $8.49 and Laybell still clears ~$0.91 on Stripe). A per-rail commission (`web` vs `apple_iap`/`google_play`) makes this a config, not a rewrite. Same relative gap holds across the ladder ($4.99 → $999.99); the >$400 tiers that are credits-only on Android (Play's $400 cap) could sell for real money on the web.

---

## 6. Delivery · auth · refunds

- **Auth:** buyer must be signed in on the web (Tier 2 supports it); guest/email checkout is possible but complicates keying the order + storage RLS — defer.
- **Download:** reuse the app's signed-URL + storage-RLS-on-delivered-order model; web already mints signed URLs.
- **Refunds:** keep the current policy (14-day payout hold absorbs the rare late refund; no seller clawback yet). The Stripe `charge.refunded` branch must reconcile with any seller-takedown credits — note LOW #8 in `BEATS_IAP_PLAN.md` (double-compensation if both fire); design the `shop_*_payments` row as the single refund authority as the IAP path did.

---

## 7. Policy / App Store

- Selling on **laybell-web is allowed** — App Store rules don't govern your website.
- **Do not** add an in-app "buy on the web" link from the iOS app without checking current anti-steering rules (US injunction / EU DMA have loosened this, but it's region-specific). Safest: app stays IAP, web sells independently, no cross-link.

---

## 8. Money-review checklist (gate before ship — same bar as the IAP rail)

- [ ] Webhook verifies Stripe HMAC signature; rejects unsigned/forged.
- [ ] Idempotent on Stripe event id — a duplicate/replayed event delivers/pays once.
- [ ] Price re-derived server-side from the order snapshot; client amount never trusted.
- [ ] Exclusivity `FOR UPDATE` lock holds — no double-sell of an exclusive; concurrent buyers → one wins, other made whole.
- [ ] Ledger legs sum to 0; double-idempotent (payments row unique + `ledger_post` on (source,event_id)); source tagged `stripe_web`.
- [ ] No store-commission leg on the web rail; per-rail fee config correct.
- [ ] Refund path reverses cleanly and reconciles with seller-takedown credits (LOW #8).
- [ ] Every new SECURITY DEFINER fn: `revoke execute ... from public, anon, authenticated` by name + C2 preflight (has_function_privilege before/after).
- [ ] Rate-limit trigger (`shop_order_rate_limit`) doesn't strand a paid web order (see IAP MEDIUM #2).
- [ ] Untagged/failed delivery → logged + buyer made whole (no silent loss; IAP MEDIUM #3).
- [ ] Independent adversarial pass over the final files across all attack categories.

---

## 9. Concrete build plan (when greenlit)

- `supabase/functions/shop-web-checkout/` — create order + Stripe Checkout Session (auth'd).
- `supabase/functions/stripe-shop-webhook/` — signature-verified delivery/refund; reuse delivery RPC.
- `supabase/sql/shop_web_checkout.sql` — `stripe_shop_payments(source,event_id)` dedup + a `web` rail in the per-rail fee/commission map; reuse precheck/delivered triggers + exclusivity lock; anon/public/authenticated revokes.
- `web-app/app/listing/[id]/page.tsx` + listing UI — a real **Buy** button (replaces "Buy in the app") that hits `shop-web-checkout`; success page → signed download.
- `web-app/lib/shop.ts` — `beginWebCheckout()` / poll or success-redirect handling.
- Config: Stripe keys/webhook secret in edge-fn env; `STORE_COMMISSION_RATE` gains a `web` entry (0 store cut).

---

## 10. Open owner decisions

1. **MoR/tax path** — A (MoR platform) vs B (Stripe + Stripe Tax). Drives everything.
2. **Fee policy on web** — keep the fee and bank the margin, or cut the fee so sellers earn more? Who absorbs the Stripe/MoR processing fee (platform vs seller)?
3. **Scope v1** — leases + exclusive sells only? Offers/free-claims later? Logged-in buyers only (recommended) or guest checkout?
4. **Refund policy** — keep "absorb the rare refund," or add seller clawback now that web volume could be higher?
