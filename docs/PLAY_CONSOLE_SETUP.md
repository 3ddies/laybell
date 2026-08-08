# Google Play + RevenueCat setup — Android money path

**Written 2026-08-02.** Everything needed to make purchases work on Android, in the
order that actually works. iOS is already done; this is the other rail.

## RESUME HERE — next session (written 2026-08-03 EOD)

**1. ✅ DONE — `supabase/sql/studio_host_exit.sql` was run 2026-08-03.** Host exit
now stops the broadcast and hands the room to the earliest remaining member.

**2. THE WORKFLOW — owner's order, 2026-08-03. Follow this, don't re-plan it.**

The existing build `e12fec4b` is **abandoned**. It will not be uploaded. There is
exactly ONE upload, and it is the build made after optimizations are finished.

> **① Finish optimizations** — Android UI issues + device-confirm the studio fixes.
> **② Rebuild.**
> **③ Upload that build** to Internal testing.
> **④ Create the 6 products** in Play (reference table below).
> **⑤ Wire RevenueCat** — attach products to the `premium` entitlement / credits offering.
> **⑥ Money test.**

**Do ⓪ BEFORE ② if you possibly can — it is what keeps this to one build.**
`androidApiKey` has no OTA path, so it must be compiled in. Try adding the Android
app in RevenueCat *now*: the Play app exists and the service-account credentials
are past their 36h clock, so the SDK key may well be issuable already, before any
product exists. If RevenueCat hands over a `goog_` key, put it in app.json before
step ② and the whole chain costs one build.

If RevenueCat refuses until products exist, then the key can only be compiled in
after step ④ — which means a second rebuild between ⑤ and ⑥. Unavoidable in that
case; not worth reordering the workflow to dodge.

**3. ✅ Apple — replied to Bella 2026-08-03** (case 20000125265126). WAITING on her
to start the migration. Nothing to do until she answers.
⚠️ iOS builds are FROZEN during migration (Certificates/Identifiers/Profiles goes
offline), so start it while the remaining work is Android-only — which it is.

**4. Android bugs — current state.** Tab-highlight glitch FIXED (highlight now
driven by the settled route, not the pager position stream). Fast-swipe
corruption FIXED (teleport guard). Studio broadcast audio, hand-raise and the
iOS studio keyboard all shipped 2026-08-03 — **none of the studio fixes are
device-confirmed yet**; the audio one in particular is reasoned, not verified.

**5. Deferred by owner:** the fresh-start data reset (docs/FRESH_START_RESET.md —
decisions now settled: `laybellreview` + its posts is the ONLY survivor).

---
## Progress

| Step | State |
|---|---|
| 1. Service account + 36h clock | ✅ **Done 2026-08-02 ~08:30.** Project `laybell`; all 3 APIs enabled; service account `revenuecat-play@laybell.iam.gserviceaccount.com` with Pub/Sub Editor + Monitoring Viewer; JSON key downloaded; invited to Play Console and showing **Active**. ⏳ **Credentials valid for RevenueCat by ~Mon 2026-08-03 evening** — "Active" in Play does NOT mean RevenueCat will accept them yet. |
| 2. Create app in Play Console | ✅ **Done 2026-08-02.** `Laybell`, package `com.laybell.app`, Free, en-US. Play app id `4973635319299378783`. |
| 3. App content declarations | ✅ **ALL DONE 2026-08-03 — 9 of 11 tasks; the remaining two are store-listing, not required for internal testing.** Privacy policy · Ads · Content rating (Teen) · **Target audience 13-15/16-17/18+, not child-directed** (Families policy applies to the teen brackets; minor protections already enforced server-side) · **Data safety** (everything Collected, nothing Shared — service-provider + user-initiated exemptions cover Supabase/Cloudflare/Sentry/RevenueCat; delete-account URL = laybell.app/delete-account.html) · Government apps · Financial features (none) · Health (none) · **Advertising ID (no)** · **Sign in details** (demo account `laybellreview`, seeded Premium + 50000 credits). |
| 3b. Category + tags + contact | ✅ **Done 2026-08-03.** Category **Music & Audio** (deliberately NOT Social — that category is dominated by the ten biggest apps on earth and a new app is invisible there; the differentiated demand lives in music search intent, and the category is changeable later). Tags: Social · Music & audio · Video streaming · Entertainment (+ optionally Meet new people). Contact `support@laybell.app` + laybell.app; phone left blank on purpose — Play publishes it and the LLC address is the owner's home. |
| 4. Build the AAB | ⚠️ **`e12fec4b` built but ABANDONED** (owner's call 2026-08-03) — it predates the Android fixes. Superseded by the post-optimization rebuild. One build, one upload. |
| 5. Upload to internal testing | ⬜ upload the **key-carrying build from step 8** (one upload total — it also satisfies the billing-permission gate for product creation) |
| 6. Create the products | ⬜ 5 credit consumables + `laybell_premium_monthly` + **`laybell_premium_plus_1999` ($19.99/mo — postdates this runbook)** |
| 7. RevenueCat wiring | 🟡 **App + JSON + key DONE 2026-08-07 evening** (Play Store app `com.laybell.app`, credentials accepted, `goog_` key issued). Remaining: attach products to offerings + entitlements (`premium`, NEW `premium_plus`) after step 6 |
| 8. androidApiKey + REBUILD | 🟡 **Key wired (`a1241aa`) + production build QUEUED 2026-08-07** — build ed3a2623 on expo.dev. When it finishes, THAT is the AAB to upload in step 5 |
| 9. License tester | ⬜ |
| 10. Money test | ⬜ Apple rail now UNBLOCKED too (Paid Apps Active 08-05, SBP submitted 08-07) — needs only the iOS sandbox tester + this Android build |

**Gotchas already hit (don't re-discover):**
- The bare `console.cloud.google.com/apis/library/...` URLs dead-end without a project
  in context — always use the `?project=laybell` form.
- The inline role picker surfaces **Pub/Sub _Lite_** roles for the search "pub". Lite is
  a different service; granting it would look done and fail. The word *reservations* in
  a role description is the tell. Clear the search box to browse by service instead.
- `.gitignore` now blocks service-account-shaped JSON (commit a5340a3) — the key can
  read financial data, so don't defeat it.

## The two facts that set the order

1. **Play won't create in-app products until an app bundle is uploaded**, and
   **RevenueCat can't add the Play app until those products exist.** So the chain is
   `AAB → upload → products → RevenueCat`. There is no way around the front of it.
2. **RevenueCat's Play service-account credentials take up to 36 HOURS to become
   valid.** Start Step 1 *today*, before anything else — it runs in the background
   while you do the rest. Leaving it to the end stalls you for a day and a half.

**⚠️ CORRECTION (2026-08-03): a rebuild IS needed — there is no OTA path.**
An earlier version of this doc said `androidApiKey` could ship over the air
because `lib/purchases.ts` reads it from `Constants.expoConfig.extra`. That is
true of the manifest, but **EAS Update is not configured on this project** — no
`updates` block, no `runtimeVersion`, no channels in eas.json. Nothing can be
pushed OTA today. Every JS change reaches a store build only by rebuilding.

**SUPERSEDED — see "THE WORKFLOW" at the top.** This section used to say to upload
`e12fec4b` first as a throwaway to unlock product creation. The owner ruled that
out: optimizations finish first, then ONE rebuild, then ONE upload. Fact 1 above
still holds (products need an uploaded bundle), so product creation simply happens
after that single upload rather than before it.

**Reference values — these must match exactly everywhere:**

| Thing | Value |
|---|---|
| Package name | `com.laybell.app` |
| Entitlement id | `premium` (matches `app.json` → `extra.revenuecat.entitlement`) |
| Credit products (consumable) | `laybell_credits_499` · `_999` · `_1999` · `_4999` · `_9999` |
| Prices | $4.99 · $9.99 · $19.99 · $49.99 · $99.99 |
| Subscription | `laybell_premium_monthly` — $9.99/month |

A product-id typo means **the purchase succeeds and grants nothing** — the webhook
looks up the id in `CREDIT_PRODUCTS` and ignores what it doesn't recognise. Copy-paste
these; don't retype them.

---

## STEP 1 — Service account (DO THIS FIRST — 36h clock)

**1a. Enable three APIs** — all in the SAME project, `laybell` (NOT
`laybell-translations`, which is the separate translation-API project).

⚠️ **Use the ?project= form.** The bare API-library URLs need a project already in
context and render an unusable page without one — verified 2026-08-02.

- Google Play Android Developer API — <https://console.cloud.google.com/apis/library/androidpublisher.googleapis.com?project=laybell>
- Google Play Developer Reporting API — <https://console.cloud.google.com/apis/library/playdeveloperreporting.googleapis.com?project=laybell>
- Pub/Sub API — <https://console.cloud.google.com/apis/library/pubsub.googleapis.com?project=laybell>

**Verify all three landed in `laybell`:**
<https://console.cloud.google.com/apis/dashboard?project=laybell>. Enabling an API
while no project is selected can silently put it in whichever project was last used,
and RevenueCat's credentials then fail with nothing obvious to point at.

**1b. Create the service account** (same project) — <https://console.cloud.google.com/iam-admin/serviceaccounts?project=laybell>
Grant it these roles:
- **Pub/Sub Editor** (or Pub/Sub Admin)
- **Monitoring Viewer**

**1c. Generate the JSON key** — on the service account → Actions → **Manage Keys** →
**Add Key** → **Create new key** → **JSON**. It downloads once. Treat it like a
password: it can read your financial data. Do **not** commit it to this repo.

**1d. Invite it to Play Console** —
<https://play.google.com/console/u/0/developers/users-and-permissions/invite>
Invite the service account's email address with:
- View app information and download bulk reports
- View financial data, orders, and cancellation survey responses
- Manage orders and subscriptions

⏳ **Now leave it alone for up to 36 hours** and carry on with the steps below.

---

## STEP 2 — Create the app in Play Console

<https://play.google.com/console> → **Create app**

- App name: `Laybell`
- **Package name: `com.laybell.app`** ⚠️ **typed here, at creation, and PERMANENT.**
  Play offers no way to change it afterwards. If it doesn't match `android.package`
  in `app.json` exactly, the AAB is rejected at upload and the only remedy is
  deleting the app and starting again. Use **Check availability** before continuing.
- Default language: English (US)
- App or game: **App**
- Free or paid: **Free** (the app is free; in-app purchases are separate and unaffected)
- Leave the "automatic protection" installer check on — default, harmless
- Declarations: developer programme policies + US export laws

---

## STEP 3 — App content declarations

Play gates *every* release behind these, including internal testing. Tedious, no
dependencies, do them while the build runs. **Dashboard → App content:**

- **App access** — you have login-gated content, so provide test credentials
  (the seeded demo account; see `docs/STORE_LISTING.md`)
- **Ads** — yes, the app shows ads
- **Content rating** — questionnaire; UGC app
- **Target audience** — 13+ (matches the 13–17 parental-consent flow already built)
- **Data safety** — the big one; mirrors the Privacy Policy in `lib/legal/`
- **Government apps** — no
- **Financial features** — declare in-app purchases
- **Health** — no

---

## STEP 4 — Build the AAB

```bash
npx eas-cli build -p android --profile production
```

The `production` profile emits an **app bundle** (`.aab`), which is what Play
requires — `preview` emits an APK and will be rejected. ⚠️ Billed build.

The Android UI glitches don't matter here: this bundle exists to unlock product
creation and internal testing, not to be shipped.

---

## STEP 5 — Upload to internal testing

Play Console → **Testing → Internal testing** → **Create new release** → upload the
`.aab` → add yourself to the testers list → roll out.

Internal testing has no review queue; it goes live in minutes.

---

## STEP 6 — Create the products

**Credits** — Play Console → **Monetise → Products → In-app products** → Create.
Five of them, each **consumable** (repurchasable — this is the setting that matters):

| Product ID | Price |
|---|---|
| `laybell_credits_499` | $4.99 |
| `laybell_credits_999` | $9.99 |
| `laybell_credits_1999` | $19.99 |
| `laybell_credits_4999` | $49.99 |
| `laybell_credits_9999` | $99.99 |

**Premium** — **Monetise → Products → Subscriptions** → Create:
- Product ID `laybell_premium_monthly`, one base plan, **monthly auto-renewing**, $9.99

Activate every product — a draft product is invisible to the SDK.

---

## STEP 7 — RevenueCat

<https://app.revenuecat.com> → your existing project (the one already serving iOS).

1. **Add the Android app** — package `com.laybell.app`.
2. **Upload the service-account JSON** from Step 1c
   (<https://app.revenuecat.com/projects/-/apps/> → Google Play app settings).
   If it errors, the 36 hours probably aren't up — wait, don't re-issue the key.
3. **Attach the Play products** to the entitlement/offerings the iOS side already uses,
   so both stores serve the same packages:
   - `laybell_premium_monthly` → entitlement **`premium`**
   - the five credit products → the **credits** offering
4. Confirm the **webhook** still points at `revenuecat-webhook` with the
   `Authorization: Bearer <REVENUECAT_WEBHOOK_SECRET>` header. It already maps
   `PLAY_STORE → google_play`; nothing to change server-side.

---

## STEP 8 — Turn Android on (OTA, no rebuild)

RevenueCat → **Project Settings → API keys** → copy the **public Android SDK key**
(starts `goog_`). Then in `app.json`:

```json
"revenuecat": {
  "iosApiKey": "appl_bmySsLnbZuPipewzsNbsuzMoYYL",
  "androidApiKey": "goog_…",
  "entitlement": "premium"
}
```

Then push it over the air:

```bash
npx eas-cli update --branch <your-branch> --message "enable RevenueCat on Android"
```

Until that key is non-empty, `apiKey()` in `lib/purchases.ts` returns null and the
**entire monetisation stack silently no-ops on Android** — no error, no paywall, no
purchase. This one line is the difference between a working money test and a
mystifying one.

---

## STEP 9 — License tester (so purchases don't charge you)

<https://play.google.com/console> → **Settings → License testing** → add your Google
account. Testers get real purchase flows with no charge, and subscriptions renew on an
accelerated clock.

---

## STEP 10 — The money test

Once Apple's side is also ready, run the same script on both phones (§0.2b items
10–15). The Android-specific checks:

- Credit pack purchase → RevenueCat receives it → webhook posts `funding` → balance
  appears. **Verify `event.store` came through as `PLAY_STORE`** so the ledger records
  `google_play` rather than `apple_iap`.
- Buy the same pack twice — the consumable must be repurchasable.
- Confirm no double-credit: the webhook is idempotent on RevenueCat's event id.
- Finish with `select public.ledger_verify();` → **zero rows**.

---

## Order summary

| When | Step | Blocked by |
|---|---|---|
| **Today, first** | 1. Service account + JSON | nothing — **36h clock** |
| Today | 2. Create app · 3. Declarations | nothing |
| Today | 4. Build AAB | nothing (billed) |
| After 4 | 5. Upload to internal testing | the AAB |
| After 5 | 6. Create products | the upload |
| After 1 + 6 | 7. RevenueCat | 36h + products |
| After 7 | 8. API key → OTA | RevenueCat |
| Any time | 9. License tester | nothing |
| Last | 10. Money test | Apple's rail too |
