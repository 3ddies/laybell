# Web Checkout — Test-Mode Deploy Runbook

Deploys the web beats checkout (buy-now + cart + sales-tax fund) to **PROD Supabase in TEST
mode**. **No real money moves:** `STRIPE_SHOP_SECRET_KEY` is the TEST key, and tax is OFF for
this first pass. Branch: `feature/web-shop-checkout`. Run everything from the repo root.

## 0. Preconditions (verified 2026-11-26)
- CLI `supabase` **3.4.0**, linked to project **wawpaokvtptfmuygjnns** (laybell, production).
- Secrets already set (TEST): `STRIPE_SHOP_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
  `SHOP_TAX_ENABLED` is **UNSET → tax OFF** (correct for this test). `STRIPE_SECRET_KEY` is the
  LIVE payouts key and is **not** touched by the shop checkout.
- The web-payments rail (old `shop_stripe.sql` + `stripe-checkout` + `stripe-webhook`) was
  deployed to prod in TEST mode on 2026-11-06. This runbook **updates** it to the tax+cart+fixes
  version and adds `shop-cart-checkout`.

## 1. Deploy the SQL  (run back-to-back with step 2 — keep test traffic off until both are done)
```
npx supabase db query --linked -f supabase/sql/shop_stripe.sql
npx supabase db query --linked -f supabase/sql/shop_stripe_cart.sql
npx supabase db query --linked -f supabase/sql/shop_web_downloads.sql   # idempotent re-run
```
- `shop_stripe.sql` drops the old 4-arg `shop_deliver_stripe_order` and creates the 9-arg
  tax-aware one, adds the `shop_tax_collected` fund, and guards the refund fn.
- `shop_stripe_cart.sql` adds the carts + cart-intent + tax `cart_id` schema and the cart RPCs.
- Both are idempotent (re-runnable).

## 2. Deploy the edge functions
```
npx supabase functions deploy stripe-checkout
npx supabase functions deploy shop-cart-checkout
npx supabase functions deploy stripe-webhook --no-verify-jwt
```
`stripe-webhook` **must** be `--no-verify-jwt` (Stripe sends no Supabase JWT; `config.toml`
also records this). The checkout functions keep JWT verification ON (buyer must be signed in).

## 3. Stripe TEST webhook — verify, don't recreate
The TEST endpoint from 2026-11-06 already points at the `stripe-webhook` URL with
`STRIPE_WEBHOOK_SECRET`. In the Stripe **dashboard (TEST mode)** → Developers → Webhooks, confirm:
- Endpoint → the `stripe-webhook` function URL.
- Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`.
- Signing secret matches `STRIPE_WEBHOOK_SECRET`.
One webhook serves **both** single-item and cart sessions — no new endpoint needed.

## 4. Put the web UI somewhere to click (the branch is NOT on the live site)
The cart/Buy UI lives on `feature/web-shop-checkout`, not on laybell-web.vercel.app (that tracks
`dev`). Pick one:
- **Vercel preview:** `git push -u origin feature/web-shop-checkout` → Vercel builds a preview
  URL. Safe: the TEST Stripe key only accepts test cards, so real cards fail.
- **Local:** put `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` in
  `web-app/.env.local`, then `npm --prefix web-app run dev`.

## 5. Test purchases — TEST card `4242 4242 4242 4242`, any future expiry/CVC
Sign in on the web as a buyer who is **not** the seller.
1. **Buy-now:** open a beat → "Buy/Lease with card" → pay 4242 → land on `/purchases` → download works.
2. **Cart:** add 2 different beats → `/cart` (live prices + availability show) → Check out → pay
   4242 → `/purchases` shows both → both download → cart is cleared.

## 6. Verify (SQL)
```
-- one ledger tx per Stripe event / per cart item  (expect NO rows):
select source, external_id, count(*) from public.ledger_transactions
 where source='stripe' group by 1,2 having count(*) > 1;
-- every committed payment recorded an outcome  (expect NO rows):
select count(*) from public.shop_stripe_payments where outcome is null;
-- global solvency unchanged  (expect NO rows):
select * from public.ledger_verify();
-- tax fund empty (tax is off)  (expect 0):
select count(*) from public.shop_tax_collected;
```

## 7. Clean up the test data  (OWNER runs — the classifier blocks Claude's prod money writes)
Delete the test orders / intents / payments and reverse the test ledger legs, as in the
2026-11-06 web-payments cleanup. Note the tx ids from step 5 first.

## NOT in this test (later, separate passes)
- **Sales tax:** after an accountant confirms your nexus states, add them in Stripe Tax, set
  `SHOP_TAX_ENABLED=true` + `STRIPE_TAX_CODE=<digital-goods code>`, redeploy the two checkout
  functions, and retest with tax added on top.
- **Go LIVE:** flip `STRIPE_SHOP_SECRET_KEY` to the live key + add a LIVE webhook endpoint, then
  merge `feature/web-shop-checkout` → `dev` (auto-deploys the web app). **Gate: owner's final OK.**
