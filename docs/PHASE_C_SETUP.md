# Phase C — Laybell Premium (RevenueCat) setup

> Status: **code scaffolded & type-checks.** Real billing is OFF until you complete the
> store + RevenueCat setup below and add API keys. Until then the paywall shows a
> "coming soon" state, nothing charges, and the whole app behaves as the free tier.

## What's wired in code

- `lib/entitlements.ts` — module-level `isPremium()` flag + `subscribePremium()`, the
  `effectivePinLimit()` and `adFree()` helpers. Single source of truth, readable
  synchronously from non-React code (ads engine, offline engine).
- `lib/purchases.ts` — RevenueCat wrapper (dynamic import + graceful fallback, like
  NetInfo): `initPurchases`, `getPackages`, `purchase`, `restore`, `logOutPurchases`,
  `purchasesConfigured`. Reads keys from `app.json` → `extra.revenuecat`.
- `contexts/PremiumContext.tsx` (`usePremium`) — wired into the provider tree; exposes
  `isPremium`, `packages`, `configured`, `purchase`, `restore`.
- `app/premium.tsx` — the paywall (route registered); Settings → **Membership** row.
- `components/SupporterBadge.tsx` — the supporter star on profiles.
- `supabase/sql/premium.sql` — `profiles.premium_until` mirror + a trigger that stops
  clients self-granting Premium + an `is_premium(uuid)` helper.
- `supabase/functions/revenuecat-webhook/index.ts` — RevenueCat → `premium_until`.

### Perks: live vs. stub
| Perk | Status |
|---|---|
| **Unlimited offline (byte-capped)** | **Live** — `effectivePinLimit()` drops the per-tier count limit for premium; the 3 GB device byte cap still applies. |
| **Ad-free HOME FEED** | **Live** — `adFree()` short-circuits `fetchFeedAds` in `lib/ads.ts`. Reels + Music are NOT ad-free (see below). |
| **50% fewer ads in Reels + Music** | **Live** — `adSpacingMultiplier()` (×2 for premium) widens the reel weave spacing (`weaveReelAds`) and the audio gate (`firstAudioGateMs` / `nextAudioGateMs`) in `lib/ads.ts`, roughly halving ads there. |
| **3-day badge grace (time-sensitive badges)** | **Live** — `lib/badges.ts` `graceDaysNow()` returns 3 for premium (via `setBadgePremiumGetter` wired from `lib/entitlements`), widening the streak/daily grace window. |
| **Supporter badge on profile** | **Removed** — the premium star badge was pulled from both profile screens per product direction. `components/SupporterBadge.tsx` is now unused. |
| **Earn Money (Live donations)** | **Live (simulated)** — premium hosts receive tips on Laybell Live. `lib/donations.ts` + `components/LiveDonateModal.tsx`; premium lock + 15% fee + est. tax computed server-side by the `donation_guard` trigger. **Run `supabase/sql/donations.sql`.** Swap `provider:'simulated'` for a real processor + payouts later. |
| **Follower insights** | **Live** — Premium-gated `app/follower-insights.tsx` (Settings → Follower insights): "doesn't follow back" (live graph diff) + "who unfollowed you" (`follow_events` log). **Run `supabase/sql/follower_insights.sql`** (unfollows are tracked from when it's applied — no back-fill). |
| **Monthly Spotlight boost** | **Live** — one free 1-day Spotlight/month for Premium. Banner on the Spotlight screen → pick a post → `claim_free_spotlight` RPC. **Run `supabase/sql/spotlight_credit.sql`.** Resets monthly via `profiles.spotlight_credit_used_month`; unused doesn't carry over. |
| **Higher-quality audio** | **Stub** — entitlement ready, but there's a single bitrate today, so nothing to switch yet. Implement when multiple qualities exist. |

## Manual steps you must do

1. **App Store Connect** — create an auto-renewable subscription (e.g. product id
   `laybell_premium_monthly`) under app `com.laybell.app`, set price + localizations,
   and add the required paywall metadata.
2. **Google Play Console** — create the matching subscription product for
   `com.laybell.app`.
3. **RevenueCat** (https://app.revenuecat.com):
   - Create a project; add the iOS and Android apps (bundle/package `com.laybell.app`).
   - Add the store products above.
   - Create an **Entitlement** with identifier **`premium`** (must match
     `extra.revenuecat.entitlement` in app.json) and attach the products to it.
   - Create an **Offering** (e.g. `default`) with a package per product.
4. **API keys** — RevenueCat → Project Settings → API keys. Copy the **public** SDK
   keys and put them in `app.json` → `extra.revenuecat`:
   ```json
   "revenuecat": { "iosApiKey": "appl_…", "androidApiKey": "goog_…", "entitlement": "premium" }
   ```
   (Or inject via EAS secrets / env if you prefer not to commit them.)
5. **Run the SQL + deploy the webhook** (powers the cross-user supporter badge):
   - Run `supabase/sql/premium.sql` in the SQL editor.
   - `supabase functions deploy revenuecat-webhook`
   - `supabase secrets set REVENUECAT_WEBHOOK_SECRET=<a long random string>`
   - In RevenueCat → Integrations → Webhooks: set the URL to the function and the
     Authorization header to `Bearer <that same secret>`.
6. **Native rebuild** — `react-native-purchases` is native, so rebuild the dev client /
   store binary (this is the **same rebuild** already needed for Phase B + the
   expo-audio migration). Nothing premium runs until then.
7. **Test with sandbox** — an App Store sandbox tester and a Play license tester.
   Verify: paywall shows your price → subscribe → `isPremium` flips → ads disappear and
   the offline pin limit goes unlimited; **Restore purchases** works on a reinstall.

## Recommended hardening (optional, later)
- **Server-side enforcement.** The mirror (`profiles.premium_until` + `is_premium()`)
  is built; perks are still gated *client-side* today (matching the app's existing tier
  gating). If you later want hard enforcement, call `is_premium(auth.uid())` inside the
  relevant RLS policies / RPCs.
- Translate the `premium.*` strings (currently English; other languages fall back) —
  the copy is marketing-sensitive, so word it before translating.
- Bump the ToS effective date + re-consent (the IAP terms already exist in Section 13).

## App Store policy note
Digital subscriptions **must** use Apple IAP / Google Play Billing — RevenueCat wraps
both. Do **not** set premium from a web/Stripe charge or a server flag set outside the
stores; that gets the app rejected.
