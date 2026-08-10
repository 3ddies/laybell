# Laybell — launch checklist

Master scope for taking Laybell from "feature-complete" to "live on the App Store and
Play Store." Written 2026-07-28.

Every item is either **[CODE]** (work in this repo), **[OWNER]** (only you can do it —
console access, money, identity), or **[LEGAL]** (needs a professional or a filing).

> ## ⚠️ READ §0.0 AND NOTHING ELSE FIRST
>
> **§0.0 is the only current section.** It is rewritten at the end of every working
> session and supersedes everything below it.
>
> Every other section is HISTORY or REFERENCE, kept because the reasoning in them is
> still worth having — **but items in §0.1–§0.2b may claim to be "next" when they were
> finished days ago.** Never action anything outside §0.0 without checking §0.0 first.
> Sections 5–7 (legal research) remain accurate as reference.

---

## 0.0 ✅ THE CURRENT STATE — updated 2026-08-10 (end of session)

**One-line status: nothing is blocking. Everything left is store paperwork, three
inbox waits, and one test that needs Android hardware.**

### What is DONE and verified — do not re-check these

| Area | State |
|---|---|
| **Money code** | 💰 **THE MONEY TEST IS COMPLETE** (2026-08-09). All 12 payment paths executed against production, 7 guards attacked and held, `ledger_verify()` = 0 rows. **Full evidence: `docs/MONEY_TEST_2026-08-09.md`** — read that instead of re-testing. |
| **Database schema** | **557/557 declared objects present** (audited by parsing all 131 SQL files). Three never-applied migrations found and fixed that day. **No pending SQL. Do not tell the owner to "run X.sql" without re-auditing first.** |
| **Edge functions** | All 23 deployed from reviewed source 2026-08-09, every `verify_jwt` correct. A drift audit that day found the **RevenueCat webhook two days stale — Premium+ buyers would have been granted the $9.99 tier** — plus `parent-consent` never deployed. Both fixed. |
| **Scheduled jobs** | 4 cron jobs, all healthy. The hourly `sweep-video-staging` was failing ~60× (Supabase now forbids direct deletes from `storage.objects`); replaced by the `staging-sweep` Edge Function invoked at app boot. |
| **Apple** | Org conversion COMPLETE (Laybell LLC). **Paid Applications agreement ACTIVE** (Aug 5) — the gate that blocked everything. Bank + W-9 active. All 7 IAPs created with full metadata + review screenshots. Premium+ ranked Level 1 above Premium. Sandbox tester exists. |
| **Google Play** | App live in **internal testing** (build 4 / 1.0.0, carries the RevenueCat key). All 7 products created and active. License testers set. App-signing SHA-256 → `assetlinks.json`; SHA-1 → Google OAuth Android client. |
| **RevenueCat** | Both stores wired. Entitlements `premium` (both stores' monthly) and `premium_plus` (both stores' plus). Credits offering + `plus_monthly` package populated. |
| **Store identifiers** | All three set — `node scripts/set-store-ids.mjs --check` passes clean. |
| **Stripe** | Platform account **activated**, Connect configured (Marketplace/Express), identity verified, **test** key set. A real Express connected account exists on the owner's profile. |

### ⏳ WAITING ON SOMEONE ELSE — no action, just watch the inbox

| What | When | What to do when it lands |
|---|---|---|
| **ASCAP licence PDF** | **due ~2026-08-11** | If not there by Tue: **phone (800) 505-4052. NEVER resubmit** — re-entry is duplicate-blocked and risks a double charge. |
| **Apple Small Business Program approval** | submitted 2026-08-09 | Tell Claude → it flips the three fee rates in §0.3 the same hour. Until then Laybell earns **nothing** on shop sales and Premium tips. |
| **Stripe live-mode review** | 2–3 days from 2026-08-09 | Only matters at launch (live key + funded balance). |

### 📋 WHAT THE OWNER STILL HAS TO DO — in this order

1. ~~**FCM V1 credentials into EAS**~~ ✅ **DONE 2026-08-10.** Firebase was added to the
   EXISTING `laybell` Google Cloud project rather than a second one, so the Play service
   account and FCM now live together. Google Analytics deliberately left OFF: the app
   ships no Firebase SDK, so it would collect nothing — but leaving it on means analytics
   would start silently the day anyone adds one, quietly invalidating the privacy label.
   Blaze plan is inherited from the project's existing billing and costs nothing; FCM is
   free on every tier and it is the only Firebase product this app touches.
2. **Store assets, both stores** (the long one). Screenshots + a seeded demo account;
   listing copy is in `docs/STORE_LISTING.md`, §4 now carries the shot order and the
   caption overlay for each. ✅ **The two REQUIRED Play graphics are already built** —
   `store/play-feature-graphic.png` (1024×500) and `store/play-icon-512.png` (512×512,
   no alpha); regenerate with `scripts/make-store-assets.ps1`. Screenshots are the only
   part left, and they shoot on `laybellreview`, which now holds BOTH subscription tiers
   so no upsell wall or ad appears in frame.
3. **iOS privacy nutrition label** — including **Diagnostics** (Crash Data + Other
   Diagnostic Data, NOT linked to identity, NOT used for tracking, purpose App
   Functionality). ⚠️ Answer from `docs/STORE_PRIVACY_LABELS.md`, **not** from memory:
   that file said "no crash SDK" until 2026-08-10 because it predated Sentry, and
   transcribing it would have filed a label contradicting the app's own Privacy Policy.
4. **Queue the iOS production build** → TestFlight. ⚠️ **Build credits are exhausted — every build is billed.** Verify assets locally before spending.
5. **Submit for review.** Two things that are easy to forget: the IAPs and the subscription group must be **attached to that version's submission**, and reviewers need the `laybellreview` demo credentials.

### 🚧 GATES — conditions that must be met before a specific action

- **Android must NOT be promoted past internal testing** until someone runs a real
  purchase on Android hardware (~15 min). The owner has no Android device as of
  2026-08-09. Server-side money code is store-agnostic and fully tested; what is
  unproven is the RevenueCat Play SDK + Play Billing client layer.
- **Do not automate Stripe's hosted Express form.** It asks for SSN and bank details on
  the owner's real account. Laybell's half is proven; the first real creator exercises
  Stripe's.
- ~~**Watch one encoder / horizontal live end-to-end**~~ ✅ **CLEARED 2026-08-10** — the
  owner confirmed an encoder live plays correctly after the fix. Kept below for the
  reasoning, because the failure mode is worth remembering: it was invisible to daily
  testing. Fixed 2026-08-10 in `0325f3e`: since
  2026-07-28 every RTMP-ingest broadcast — Studio encoder **and** phone-horizontal, i.e.
  everything bound for Laybell TV — was created with Cloudflare recording `off`, and
  Cloudflare serves live HLS *out of* the recording pipeline, so no manifest existed and
  **no viewer could watch**. Vertical WHIP lives never touch HLS, which is why the one
  path tested daily was the one path unaffected. The config is restored to what provably
  worked in July and the recordings are now purged when a broadcast ends, but only a real
  stream proves a viewer can actually watch one.

### 🚀 LAUNCH-DAY SEQUENCE — only when the owner says "we are going live"

0. 💵 **REVERSE THE DEMO WALLET BALANCE — do this first, it is real money.**
   ```bash
   npx supabase db query --linked -f supabase/sql/_DEMO_wallet_balance_REVERSE.sql
   ```
   Applied 2026-08-10 so the App Store wallet screenshot showed a figure instead of
   `$0.00`. It credits `shpwkvr7jg` **$58.00 of AVAILABLE (withdrawable) earnings** —
   the wallet's headline number is the payout-eligible balance, so this is not paint on
   a screen. Once Stripe is live and `payoutsAvailable()` is on, "Transfer to bank"
   would move **fifty-eight real dollars out of Laybell's Stripe balance** against value
   that never existed. The fresh-start reset below does **not** clear it: the ledger is
   append-only by constraint, so the only correct undo is the mirror transaction in that
   file. Confirm `available_cents_should_be_0` comes back `0` and
   `invariant_violations` `0`.

1. **Fresh-start reset** — wipe test accounts/posts, keep `laybellreview`, sweep Storage
   + Cloudflare separately, re-seed. Plan: `docs/FRESH_START_RESET.md`. This also clears
   the money-test artifacts and 11 expired ad campaigns.
2. **Legal rollout** manual steps — `docs/LEGAL_ROLLOUT.md`.
3. **Email**: custom SMTP + SPF/DKIM/DMARC — `docs/EMAIL_SETUP.md`.
4. **Stripe live**: swap `STRIPE_SECRET_KEY` to `sk_live_…`, fund the Stripe balance,
   then flip `payoutsAvailable()`. Credits money arrives in a *bank* account, not
   Stripe, so transfers fail until it is topped up.
5. Re-check universal links on a device once a store build exists.

### 🧭 STANDING RULES for whoever picks this up

- **Audit before believing.** Two audits on 2026-08-09 found **six** real problems that
  no test caught, because everything *looked* fine. Re-run both near launch:
  (a) parse `supabase/sql/*.sql` for declared objects and check them against prod;
  (b) compare `supabase functions list` against the repo, then
  `npx supabase functions deploy` with no args to end drift permanently.
- **Always review money code before it runs.** Two adversarial reviews found 11 money
  bugs, 6 of which could mint money.
- **No OTA on this project** (no `expo-updates`). A production build's JavaScript is
  frozen at build time — every JS fix needs a rebuild.
- **Never rewrite files with PowerShell text cmdlets** — it corrupts UTF-8 into mojibake.
  Use the Edit tool or Node.

---

## 0.1 WHERE THINGS STOOD — 2026-07-29 *(HISTORICAL — superseded by §0.0)*

### Done and verified against the live database

| | |
|---|---|
| **Payments ledger** | Double-entry, append-only, server-authoritative. 24/24 checks pass. |
| **All six money surfaces wired** | Credits (IAP→webhook→ledger), tips, shop, payouts, Spotlight, Ad Manager. Nothing charges $0 any more, and nothing claims to charge what it doesn't. |
| **Three live exploits closed** | A crafted insert could mint a live 365-day Spotlight for $0, or a funded ad campaign at `bid_cpm_cents=1`; an advertiser could reset their own spend meter. 17/17 checks pass, and the verification file *attempts each exploit* rather than just looking for the fix. |
| **Fee arithmetic corrected** | Every rate assumed Apple's 15% Small Business rate. Until that enrolment is approved Apple takes 30%, at which point shop (25%) and Premium tips (20%) **lost money on every transaction**. Both now 30% = break-even. Reverse after approval — see §0.3. |
| **Mississippi geo-blocked** | HB 1126 has no size threshold. Server-enforced, because `profiles` rows are created by three paths that never run app code. |
| **Legal docs corrected** | Terms, Advertiser Terms and Community Guidelines all said payments were simulated. Effective 2026-07-29 — **existing users should be notified.** |
| **laybell.app is live** | Real landing page, all legal pages, `/.well-known/` at the domain root, share links moved onto the domain. Old QR codes still resolve (verified, one hop). |
| **Accessibility** | 118 icon-only buttons labelled via an AST codemod; `a11y.*` had existed only in English, so nine languages were silently falling back. |

### The gate

**Two things, in this order: an Apple agreement, then a build.**

**Apple first.** While Paid Applications is not `Active`, App Store Connect serves NO
in-app-purchase products to StoreKit, so RevenueCat fails at startup and credits cannot be
bought at all. Credits fund tips, shop and offers, so four of the five money tests are gated
on paperwork rather than on code. The Stripe bank-connect test is the exception — it does
not touch credits, so **do that one first.** See §0.2.

**Then a build.** RevenueCat is a native module, so nothing payment-related can be tested in
Expo Go. **Every line of the money code above has been reasoned about carefully and
executed zero times.** Two bugs in it were caught only because Postgres rejected them at
`CREATE` time, and a third — a guard that would have thrown on every ad impression — was
caught by review, not by testing. Assume there are more.

---

## 0.2 NEXT, IN ORDER *(HISTORICAL — every numbered item here is DONE; see §0.0)*

### Done in code, 2026-07-29 (second pass) — needs only the rebuild / a deploy

| | |
|---|---|
| **Camera & mic prompts** | The webrtc plugin is registered after `expo-camera`/`expo-audio`, and an explicit prop always overwrites (`@expo/config-plugins/build/ios/Permissions.js:32`), so **every** camera prompt read *"to broadcast livestreams"* — including taking a story photo. All three plugins now carry one string covering both uses. |
| **Unused location strings** | `NSLocationAlways*` were being written with generic defaults while the app only ever requests when-in-use. Now suppressed with `false`, which deletes the keys. |
| **`expo-image-picker`** | Used in 8+ screens but absent from `plugins`, free-riding on other plugins' Info.plist keys. Now declared. |
| **`webcredentials:laybell.app`** | Declared in the AASA but missing from `associatedDomains`, so AutoFill association was dead. Added. |
| **`send-push` auth hole** | It took `actorId` from the request body and sent with the service role — any signed-in user could push any notification to any user, impersonating anyone. The actor is now the verified caller, and a matching `notifications` row must already exist. |
| **`livekit-token` auth hole** | Deployed `--no-verify-jwt` **and** deriving identity from an unsigned base64 decode, so a forged `sub` could mint a full-publish token as any member of any open session (the membership lookup runs service-role and bypasses RLS). Now verifies against GoTrue. |
| **`parent-consent-verify`** | Would have 401'd every guardian at the gateway — same silent failure as `revenuecat-webhook`. Now recorded as `verify_jwt = false` in `config.toml`; **deploy it with the flag.** |
| **`profiles.name` → `display_name`** | `livekit-token` selected a column that doesn't exist, so every Studio participant showed as "Artist". |
| **Help was a dead end** | Settings → Help alerted "the help center is coming soon". It now opens a `mailto:` to support@ with the build version in the subject, all 10 languages. |
| **Badges copy lied** | The footnote said Community and App Sharing were "coming soon"; no badge has been `locked` for some time. Removed in all 10 languages. |
| **"Payments are simulated"** | Six files of comments sitting directly on code that now debits real credits. Corrected, with the actual RPC names. |

**Owner, unblocked, today — ALL CLEAR as of 2026-07-29 evening.** Every item below was
re-verified against the live project, not just marked off:

0. ~~**Run `supabase/sql/_RUN_PENDING_2026-07-29.sql`**~~ — six missing migrations
   (`stripe_connect`, `access_log`, `copyright_strikes`, `sound_optin`, `live_replay`,
   `stream_hours`). **Done 2026-07-29**, owner confirmed the bundle's own verification
   queries all pass.
0b. ~~**Re-run `wallet_earnings.sql`**~~ so the fee derives from `shop_fee_rate()` instead of
   a hardcoded `* 0.85`. **Done 2026-07-29** — `_VERIFY_MONEY_2026-07-29.sql:30` passes.
1. ~~Tick **Enforce HTTPS** — GitHub repo → Settings → Pages.~~ **Done 2026-07-29.**
   Verified live: `http://laybell.app` and `http://www.laybell.app` both 301 to HTTPS.
2. ~~Confirm `support@` and `dmca@` aliases exist in ImprovMX.~~ **Done 2026-07-29.**
3. ~~Restrict App Store availability to the United States.~~ **Done 2026-07-29.**
4. ~~**Redeploy `revenuecat-webhook` with JWT verification OFF.**~~ **Done 2026-07-29.**
   It authenticates with a shared secret in the Authorization header, so `verify_jwt: true`
   made Supabase's gateway reject RevenueCat with 401 *before the function ran* — users
   would have paid Apple and received no credits, with no logs to find. Verified live via
   `npx supabase functions list`: `revenuecat-webhook`, `parent-consent-verify`,
   `livekit-token` and `share-page` all read `verify_jwt: false`.

**Owner — 2026-07-30. Done.**

5. ~~**Run `supabase/sql/shop_stats.sql`.**~~ **Done 2026-07-30**, verified: the drift check
   returns no rows, and the one listing it first flagged was a false positive in the check
   itself (`count(*)` over a LEFT join counts the null-extended row, and
   `shop_order_kind(NULL, license)` coalesces it into the license-derived kind, so a listing
   that had sold nothing reported a phantom lease — fixed to `count(o.id)`; the backfill
   joins INNER and was never affected). After `shop_multi.sql` and `shop_credits.sql`;
   idempotent, and it backfills the new counters from existing orders. Two reasons, and
   only the first is cosmetic:
   - the listing page can now say *"Sold · 2 leased · 3 claimed"* instead of one
     undifferentiated `sales_count` that meant nothing in particular;
   - **it closes two real holes.** Neither `shop_order_precheck()` nor
     `shop_buy_with_credits()` ever looked at the listing's `status`. So a **paused
     listing could still be bought outright** — pausing was cosmetic, the app hid the
     buttons and the server honoured whatever arrived — and a **sold** listing could
     still be **claimed for free**, because a free claim is inserted straight as
     `delivered` by the precheck and never passes through the delivery trigger that
     refuses everything else. Sell and lease on a sold listing already failed safely
     (the trigger raises `listing_sold` and the whole RPC rolls back, money included).
     Until this runs, the app is the only thing standing in the way of either.

**Owner — added 2026-07-30. Both steps done.**

6. ~~**Run `supabase/sql/offer_messages.sql`**, then **redeploy `send-push`**.~~
   **Done 2026-07-30** — SQL run by the owner, and `send-push` deployed to project
   `wawpaokvtptfmuygjnns` (the Docker warning is expected and harmless; the CLI
   uploads the asset rather than building a local container). `send-push` has no
   entry in `config.toml`, so it keeps the default `verify_jwt: true`, which is
   correct for it — it authenticates the caller itself and the app invokes it with
   a real session token.

   ```
   npx supabase functions deploy send-push
   ```

   Buy-offers now arrive as an offer card in the DM thread with Accept/Decline,
   and carry their own `'offer'` notification type. The SQL widens the
   `notifications` type constraint to admit it; the redeploy teaches `send-push`
   the copy for it.

   **Neither half works alone, and both fail quietly.** Without the SQL the
   notification insert is rejected by the constraint and no push is even
   attempted. Without the redeploy `send-push` rejects the unknown type with a
   400 — the offer still arrives in the thread, the seller just never hears about
   it. Do them together.

   The push copy is `"@buyer sent you an offer."` and names no figure, by
   design: what someone will pay for a beat is between the two of them, and a
   lock screen is read by whoever is holding the phone. Same reasoning governs
   the inbox preview. If you ever want the amount surfaced, it has to be a
   deliberate decision in `supabase/functions/send-push` **and**
   `messages.preview.offer` — not an accident.

**Owner — added 2026-07-30. Done.**

7. ~~**Run `supabase/sql/shop_offers_open.sql`**~~ **Verified applied 2026-08-07** — the
   deployed `shop_order_precheck` no longer contains the `offers_not_available` gate
   (checked against live `pg_proc`, not assumed). This entry had simply never been ticked.

   "Make an offer" now appears on every active listing, not just lease-without-sell:
   grey above "Message seller" when there is a green Buy button, blue under the Free
   button on a free-only listing. The old lease-only arrangement is untouched.

   The server still refuses those offers until this runs — `shop_order_precheck`
   raises `offers_not_available` for anything that isn't lease-without-sell, so the
   new buttons would open the sheet and fail on send. Nothing financial changes:
   offer credits are held and settled by the escrow triggers, which never read the
   listing's deal types.

8. ~~**Run `supabase/sql/offer_expiry.sql`**~~ **Done 2026-07-30**, run as one merged
   script with item 9 (both rebuild the same two functions, so they were applied in
   their final combined state rather than one over the other). Verified: `cron.job`
   has `expire-stale-offers`.

   Buy-offers now expire after 24 hours and read "Offer expired" in the thread.
   This is **not cosmetic**: an offer holds the buyer's credits in escrow from the
   moment it is made, so expiry has to be a real status change that returns them.
   The file adds the `'expired'` status, refunds on it via the existing settle
   trigger, refuses to *deliver* an offer past its deadline (closing the race where
   a seller accepts in the same minute the sweep runs), and schedules
   `expire_stale_offers()` on pg_cron every 10 minutes.

   Until it runs, offers never expire and the escrow is held indefinitely. The app
   will still *draw* "Offer expired" past 24h — that half is client-side — which
   makes this the worst state to sit in: it looks handled and isn't.

9. ~~**Run `supabase/sql/shop_exclusivity_lock.sql`**~~ **Done 2026-07-30.** Verified
   live: both functions carry `for update` (2/2), no listing has ever delivered two
   exclusive orders, and no sold listing has anything still pending.

   **A seventh way to double-spend, found 2026-07-30.** Auto-declining pending
   offers on an exclusive sale already worked; the check in front of it did not.
   Both `shop_order_precheck` and `shop_order_delivered` read the listing's status
   with a plain `SELECT`, and under READ COMMITTED that sees the last *committed*
   row without waiting on a transaction in flight. Two buyers hitting Buy in the
   same instant both read `active`, both move credits, and both deliver — one
   exclusive beat sold twice, both charged, both handed the file, and the listing
   showing a single sale. Auto-declining can't help: at the moment each
   transaction looked, there was nothing pending to decline. The same race lets a
   free claim land on a listing being sold exclusively alongside it.

   The fix is two `for update` clauses, so the second transaction blocks at the
   read and sees `sold` when it wakes. Lock order is listing → ledger accounts in
   every path, so no deadlock.

10. ~~**Run `supabase/sql/shop_offer_retry.sql`**~~ **Done 2026-07-31.** Verified: the
    index carries `WHERE (status = ANY (ARRAY['requested','delivered']))`, and the
    CREATE succeeding is itself proof no live duplicates exist. Three buyer/listing
    pairs were already locked out in test data (one declined, one expired, one
    cancelled) and can offer again. The `expired` one also confirms the pg_cron
    offer sweep is running.

    `shop_orders_listing_buyer_kind_uq` counts DEAD orders, so the first offer a
    buyer makes permanently consumes their only `offer` slot on that listing.
    Declined? They can never offer again. Expired unanswered? Same — and offer
    expiry turned that from an edge case into the normal path. The app shows the
    button, they type a price, and the insert fails on a unique violation.

    The fix scopes the index to `status in ('requested','delivered')`. Nothing
    that was prevented before becomes possible: two pending offers, double
    leasing and re-claiming a freebie are all still blocked by live orders
    holding the slot.

**Crash and error reporting — CODE DONE 2026-07-29, DELIBERATELY INERT.**

Wired but switched off. `@sentry/react-native` (~7.2.0, via `npx expo install`), the config
plugin, `metro.config.js` for Debug IDs, `lib/monitoring.ts`, and `Sentry.wrap` on the root
layout. It no-ops entirely until `EXPO_PUBLIC_SENTRY_DSN` is set — the module is behind a
guarded `require()` (same pattern `_layout.tsx` uses for LiveKit), so without a DSN it is
never even loaded and existing dev clients without the natives are unaffected.

The webhook logging is live NOW and needed no account: `revenuecat-webhook` emitted **no
logs at all** on failure, so a user could pay Apple, the ledger call could fail, and the 500
would vanish. It now writes one `[money-failure]` JSON line per failure — credit grant,
refund reversal, premium update, unhandled — with responses byte-identical. Deployed,
`verify_jwt` still `false`.

✅ **DONE 2026-07-30 — and it was a legal-doc change, not a config one.** The published
policy promised the opposite in 4 passages plus 1 in the Terms and named Sentry outright.
All corrected, plus a new Privacy Policy **§3.16 Crash and Error Reports (Diagnostics)**
stating what is sent, what is not, that no identity is attached and session replay is off,
the legitimate-interests basis, at-most-90-day retention, and that it is never used for
advertising or profiling. Effective date moved to **July 30, 2026**, the five web pages
regenerated, and `laybell.app/privacy.html` verified live with zero stale claims.

A **user opt-out** ships with it — Settings → Privacy Center → "Crash reports", all ten
languages. Defaults ON (personalised ads need consent; identity-free diagnostics rest on
legitimate interests) and gates at SEND time, failing closed until the preference has been
read so an opted-out user cannot leak a report during startup.

`EXPO_PUBLIC_SENTRY_DSN` is set on the **preview and production** build profiles only — not
development, so the daily dev client never spends quota. Takes effect on the next build.

**Still owner-side:**

1. ~~**`SENTRY_AUTH_TOKEN` as an EAS secret**~~ **Done 2026-07-30.** Verified via
   `eas env:list --environment production`: present, secret visibility, value unreadable.
   Source maps will upload on the next production build, so stack traces arrive with real
   file names and line numbers instead of minified frames.
   ⚠️ It is scoped to **production only**. The `preview` profile also carries the DSN, so a
   preview build reports crashes but its traces stay minified. Add the same variable with
   `--environment preview` if preview builds ever need readable traces.
2. ~~**Notify existing users** of the policy change.~~ **N/A 2026-07-30** — owner confirms
   every account is a test account. The obligation returns the moment real users exist, so
   any *future* policy change needs the notification the 2026-07-29 correction in §0.1
   describes.
3. Declare the **Diagnostics** data type in the App Store Connect privacy nutrition label:
   Crash Data + Other Diagnostic Data, **not** linked to identity, **not** used for
   tracking, purpose App Functionality. Those answers match the shipped configuration.
4. Let the Sentry trial lapse to the free Developer plan — 5k errors/month is ample.

Already hardened for that review, so the disclosure can be narrow: `sendDefaultPii: false`,
`tracesSampleRate: 0`, **Session Replay deliberately NOT enabled** (Sentry's own guide
suggests `mobileReplayIntegration`, which records the screen — unacceptable on an app with
DMs and minors), no automatic user identity, and a scrubber that strips JWTs, emails, auth
headers and Supabase query strings from every event and breadcrumb.

⚠️ Sentry is a config plugin, so it needs a **native rebuild**. It is in the tree now
specifically so the submission build contains it — retrofitting later costs another build,
and means the first real users' crashes are invisible.

**Owner, in flight:**

4. **Apple organisation conversion.** D-U-N-S obtained; verification takes up to three weeks.
   When it lands: re-sign Paid Apps as the LLC → bank account to the LLC's → W-9 with the EIN
   → **then** Small Business Program. Confirm the **Team ID didn't change** before running
   `scripts/set-store-ids.mjs`, because it is baked into the AASA file.

   ⚠️ **This blocks the five money tests below, and it was not obvious until the first
   build ran (2026-07-29).** While Paid Applications is not `Active`, App Store Connect
   serves NO in-app purchase products to StoreKit, so RevenueCat fails at startup with
   "None of the products registered in the RevenueCat dashboard could be fetched from
   App Store Connect." Credits fund tips, shop and offers, so tests 5–8 are all gated on
   an Apple agreement rather than on any code. Test 9 (Stripe) is not — do that one first.
   The app degrades correctly meanwhile (`getCreditPacks()` returns `[]`), and the red
   LogBox errors are dev-only.

**Then the build, and the five tests that cover every money path:**

5. Buy credits → ledger balance moves
6. Tip → 30%/35% split, earnings show a 14-day hold
7. Buy a shop listing → instant delivery, file unlocks
8. Make an offer, decline it → credits come back
9. Connect a bank via Stripe → onboarding returns cleanly

**After the build:**

10. Store identifiers → `node scripts/set-store-ids.mjs --check`. **Team ID DONE 2026-07-31**
    (7X9PRLSGZC, read off the Membership page, wired into the AASA). Remaining two:
    the App Store numeric ID (exists the moment the App Store Connect app record is
    created — no need to be live) and the Android app-signing SHA-256 (exists after the
    first Play upload, and it must be the APP SIGNING key, not the upload key).
11. Screenshots + a seeded demo account (listing copy is written — `docs/STORE_LISTING.md`)
12. Fund the Stripe balance, **then** flip `payoutsAvailable()`. Credits money arrives in a
    *bank* account, not Stripe, so transfers fail until it is topped up.

---

## 0.2b 📋 THE LIST *(HISTORICAL as of 2026-08-09 — the money test, both store setups and the Android rail are all DONE. Kept for the reasoning; the live list is §0.0)*

**Updated 2026-08-01.** Ordered so the two stores advance together and the money code is
tested ONCE, with both rails live (owner's call — one sitting, not two).

### ✅ Done (stop re-checking these)

| | |
|---|---|
| D-U-N-S | In hand, issued to **Laybell LLC** via Apple's flow — never apply again |
| Apple Team ID | `7X9PRLSGZC`, wired into the live AASA |
| Apple org conversion | **Submitted 2026-07-31**, case ID emailed — awaiting review |
| Google org conversion | **Completed 2026-08-01** (CP 575 accepted path), org payments profile linked |
| `laybell.app` | Live, verified for the org in Search Console (Domain property, GoDaddy TXT) |
| Backend | All SQL applied + verified; 16 edge fns deployed; `send-push` redeployed |
| App Store Connect | Credit IAP products created; RevenueCat iOS configured (`iosApiKey` set) |

### ✅ ANDROID BUILDS — blocker cleared 2026-08-01

**Was:** every Android build died in Gradle. **Now:** `711f701a` FINISHED and installs.
Two library-level New Architecture incompatibilities, both fixed by patch-package:

- `@api.video/react-native-livestream` — RN 0.81 made `Event.viewTag` a real Kotlin
  member, so the lib's `private val viewTag` shadowed it (5 compile errors).
- `react-native-track-player` — 36 `@ReactMethod`s used Kotlin expression bodies
  (`= scope.launch {}`), inferring a `Job` return where TurboModule interop demands
  `void`. Converted to block bodies. **Also** its Android service emitted every
  native→JS event through the legacy bridge accessor, which is permanently null under
  bridgeless — that's what left the media notification, the in-app scrubber, and
  track auto-advance all dead. Routed through the architecture-aware context.

**Read EAS failures for free, without the dashboard:** `eas-cli build:list --platform
android --limit 3 --json` returns `logFiles` (signed URLs, 15-min expiry); fetch and grep
`^e:` / `FAILURE:`. Timing is a WORTHLESS signal — a ~3min failure was wrongly used to
rule OUT a Kotlin compile error, which is exactly what it was.

⚠️ **Build credits exhausted — every build is billed.** Verify assets and patches
locally before spending (a pre-flight caught a silently-unmasked app icon that would
otherwise have shipped).

### 🟠 ANDROID POLISH — real, deferred by owner 2026-08-01

The app runs well on the Samsung, but with UI glitches the owner is **taking a break
from**; he'll report specifics later. **Do not treat Android feel as launch-blocking
until he re-raises it** — and do NOT let it delay the money test, which needs only
purchases to work.

Fixed and shipped so far: hooks crash at login (PhotoGrid's permission gate sat between
hooks); tab-bar chips colliding with the system nav bar (edge-to-edge is mandatory in SDK
54 — iOS's home-indicator math put them on the real buttons); tab swipes lost to
PanResponder blocking native interception; the chips pinned stationary on Android by
owner preference; sub-tab steppers disabled there (they also silently disabled the main
pager); StoriesTray rehosted out of the FlashList header (its native view was orphaning
into a ghost stuck over the tab bar). Still open: mid-swipe page flashes (Fabric-level,
transient) and whatever the owner reports next.

### 💰 THE MONEY TEST — one sitting, both stores (owner's decision)

Every line of payment code has executed **zero times**. This session is the single
biggest risk retirement left. It needs BOTH rails ready, so treat the items below as one
checklist that unlocks one event.

**Apple side — waiting on review, then ~an hour of setup**
1. Org conversion clears (in review now).
2. **Paid Applications agreement** — App Store Connect → Agreements. Banking + tax.
   THIS is the gate: until it's active, App Store Connect serves NO IAP products to
   StoreKit and RevenueCat fails at startup.
3. **Enroll in the App Store Small Business Program the same day** — free, easily
   forgotten, and every fee rate in the app is engineered at break-even until the 15%
   rate lands (see §0.3).
4. An iOS build carrying RevenueCat (native — nothing payment-related works in Expo Go).

**Android side — UNBLOCKED, can start today. FULL RUNBOOK: `docs/PLAY_CONSOLE_SETUP.md`**
   ⏳ **Start the RevenueCat service-account credentials FIRST — they take up to 36 HOURS
   to validate.** Everything else is same-day; that one is not. Also: the Android API key
   ships via **EAS Update, not a rebuild** (it lives in the manifest `extra`), so this
   whole track costs ONE build.
5. ~~Fix the Android build~~ — DONE. Produce a `preview`/`production` AAB when ready
   (the dev client already proves the native stack compiles and runs).
6. Play Console → create the app → **internal testing** track → upload.
7. Create the credit products. **IDs must match exactly** (`lib/purchases.ts`):
   `laybell_credits_499` / `_999` / `_1999` / `_4999` / `_9999`.
8. RevenueCat → add the Play app + service-account JSON → **set
   `extra.revenuecat.androidApiKey` in app.json** (currently `""`, so the whole
   monetization stack is inert on Android) → rebuild.
9. Add yourself as a **license tester** (sandbox purchases, no real charge).

**The sitting itself — run the same script on both phones**
10. Buy a credit pack → webhook → ledger (`funding` transaction, balance appears).
11. Tip a creator → `earnings` with the hold, server-computed fee.
12. Shop: buy, lease, free-claim → delivery + the `Sold`/counters.
13. Make an offer → escrow held → accept → payout leg; and decline → refund leg.
14. Spotlight + Ad Manager purchases (still simulated — confirm the copy is honest).
15. `select public.ledger_verify();` — must return **zero rows**.

### 🟡 Parallel, unblocked, any time

- **Samsung first pass** (needs only the dev build): hardware back everywhere, tab bar
  (scrim, no iOS blur), keyboard `pan` in DMs/comments, SwipeBackPager feel, Chromecast
  (Android auto-discovers), notifications.
- **FCM V1 credentials** in EAS (Firebase project → service-account key) — Android push.
- **Android OAuth client** for Google sign-in — needs the keystore SHA-1.
- **`assetlinks.json`** — needs the Play **app-signing** SHA-256 (NOT the upload key);
  Claude writes + deploys it given the fingerprint.
- **App Store numeric ID** → `node scripts/set-store-ids.mjs --app-store-id <n>`. Exists
  the moment the App Store Connect record is created — no need to be live.
- **Store assets both stores**: screenshots + seeded demo account (copy written,
  `docs/STORE_LISTING.md`), Play data-safety form, content rating (UGC), US-only
  availability to match iOS, iOS "Diagnostics" privacy label.

### ⏳ Passive — no action, just don't forget

- 🟡 **ASCAP: paid 2026-08-02, awaiting confirmation.** Website & Mobile App licence, **$336/yr, 08/01/2026 → 07/31/2027**, bought self-serve after the 07-28 email turned out to be an enquiry rather than a filing. **Card charge confirmed 08-02** (the timeout was cosmetic — the transaction completed). Remaining: the acceptance email + licence PDF **by ~Aug 11** (ASCAP quotes 5-7 business days), and **do not resubmit** — re-entry is duplicate-blocked and re-paying risks a double charge. Escalate by PHONE, (800) 505-4052. Details in `PRO_DEFERRAL_NOTE.md`.
- 📅 **Both PRO licences expire within days of each other and NEITHER auto-renews** — BMI (signed 07-28) and ASCAP (term ends 07/31/2027). Set ONE reminder for **early July 2027** and re-apply to both together. A lapsed licence while the app is live is the exact exposure these were bought to prevent.
- **BMI**: all revenue is reported; **contact Violet Cieri at ~$18,500 gross** (§5.1).
  Monthly check pairs with the §8 stream-hours auto-terminate clause.
- Sentry trial lapsing to free.
- Stripe funding + flipping `payoutsAvailable()` — deliberately post-launch.
- Maryland Form 1, **due April 15 2027** ($300) — first one, nothing owed before then.


---

## 0.3 REVERSE THESE AFTER SMALL BUSINESS APPROVAL ⚠️ STILL PENDING — LIVE ACTION

**Status 2026-08-09: enrolment SUBMITTED, awaiting Apple's approval email.** This is the
one §0.x section outside §0.0 that still contains work to do. The moment approval lands,
make all three changes together (two are SQL, one is a client constant) and redeploy.

At Apple 15% the break-even rates net 15% each, which is more than either surface needs —
and the surplus is better spent on creators than banked.

| Where | Now | After |
|---|---|---|
| `shop_fee_rate()` + `SHOP_FEE_RATE` | 0.30 | 0.25 (seller keeps 75%) |
| `tip_fee_rate()` premium + `DONATION_FEE_RATE_PREMIUM` | 0.30 | 0.20 (creator keeps 80%) |
| `STORE_COMMISSION_RATE` (lib/shop.ts) | 0.30 | 0.15 — the seller-facing split currently overstates Apple's cut |

At 70% versus a standard 65%, "Earn More" is barely a reason to buy Premium. That is the
real cost of leaving it.

---

## 0.4 KNOWN, ACCEPTED, NOT BLOCKING *(still accurate — read before "fixing" any of it)*

- **Perfect the custom Laybell link appearance.** [OWNER-REQUESTED, 2026-07-29] Shared links
  work — they unfurl a card with the post's own thumbnail, the caption and the author
  (`Heee · Observer`), and tap into the app. They do not yet look the way Spotify's and
  TikTok's do. Two gaps, both understood, neither cheap:

  1. **No second text line.** Apple's card renders `og:title` and the domain and nothing
     between them, so the author had to be folded into the title after a `·` instead of
     sitting on its own line under it. `og:description` was tested on-device twice — once
     WITH the `twitter:card` + `application/activity+json` pair that
     [TN3156](https://developer.apple.com/documentation/technotes/tn3156-create-rich-previews-for-messages)
     says gates it for social-network posts, and once without, after diffing our `<head>`
     against a live Spotify track page. Neither produced a third line. **Do not spend more
     time on markup here** — Spotify's artist line is almost certainly special handling for
     music links, not something reproducible. The remaining lead is `og:video` pointing at a
     downloadable MP4, which TN3156 says Messages downloads and plays inline; that is what
     makes TikTok's cards feel alive. Cloudflare Stream can expose per-video MP4 downloads,
     so this is real work rather than a tag.
  2. **No blue "View" button.** That is the Universal Link affordance, confirmed by TikTok's
     AASA covering `/@*`, `/v/*` and `/share/video/*`.
     ✅ **Half of this is now fixed — re-verified live 2026-08-10.** `laybell.app` serves a
     real AASA carrying the actual Team ID (`7X9PRLSGZC.com.laybell.app`); the `TEAMID`
     placeholder this section used to describe is gone, so the links are no longer inert by
     construction. What remains is that SHARE links point at `open.laybell.app` (the
     share-page Edge Function, for per-post OG), and Supabase can't serve
     `/.well-known/apple-app-site-association` on that host — so a shared post still won't
     carry the affordance even though the domain itself is now set up correctly.
     Fixing the rest means serving share links from a host that does BOTH the AASA and
     per-post OG — i.e. moving off GitHub Pages to Cloudflare Pages / Vercel / Netlify. That
     migration also fixes the `octet-stream` item below, so do them together.

  Already fixed and not to be re-litigated: the shared `*.supabase.co` domain force-serving
  `text/plain` (hence the custom domain); the user-agent split that redirected Apple to
  `open.html` and made every card generic; portrait thumbnails sized on the wrong edge
  (404x720); a hardcoded `og:image:width/height` of 640x640 that no real cover matched.

- **`apple-app-site-association` is served as `application/octet-stream`.** Apple asks for
  `application/json`; GitHub Pages cannot set headers and ignores `web/_headers`. Measured on
  the live domain, not predicted — **still true on 2026-08-10.** Android is unaffected: its
  `assetlinks.json` IS served as `application/json`, verified live, with the real app-signing
  SHA-256. If iOS universal links fail once a build exists, this is the first suspect and
  Cloudflare Pages is the fix — which would also give free email routing.
- ✅ **The Stripe payout return page is live** (verified 2026-08-10). `stripe-connect` sends
  creators to `https://laybell.app/payouts`, which used to 404 — the site's error page at the
  exact moment someone finished handing over bank details. `web/payouts.html` now answers
  there (GitHub Pages resolves the extensionless path), and `open.html` carries the real App
  Store ID `6795675871`.
- **Icon-only buttons — largely closed 2026-07-30.** The "~76 unlabelled" figure was
  misleading: **538** of the codemod's skips are touchables with visible text, which
  VoiceOver already reads and where a label would *override* the words on screen. The real
  gap was 26 state-dependent icons (mute, like, play/pause, save, password visibility) —
  the controls a screen-reader user needs most, announcing as bare "button". The codemod now
  emits a ternary label mirroring the component's own condition, spliced verbatim from
  source so icon and label cannot drift; 19 applied across 16 files, and 13 new `a11y.*`
  keys added in all 10 locales.
  Left: **3** story-camera toggles (caption / song / save) whose pairs are reported rather
  than guessed because they need copy decisions, and **28** "no icon child" touchables plus
  **10** files lacking `useTranslation` in scope. None blocking.
- **Spotlight and Ad Manager have no per-impression refund.** Spotlight is a flat price for a
  time window; ad budgets refund only the unspent remainder.
- ~~**The Premium paywall is English-only.**~~ **Done 2026-07-30.** The whole Premium surface
  now carries all 10 locales — `premium.*` (38), `musicOrder.*` (5) and
  `followerInsights.*` (9), verified 10/10 each with the `{premium}` / `{standard}` / `{when}`
  placeholders intact in every one.

- **448 of 2180 i18n keys are still not at 10 locales** (79% translated; 414 of them are
  English-only, the rest partial). Re-measured 2026-07-31 by counting occurrences per key —
  the earlier 462/2143 figure predates the Premium-paywall translation pass. Every key added
  since has shipped at 10/10, so this number only moves down. The "i18n ADOPTION COMPLETE"
  note elsewhere is stale. `translate()` falls back `DICTS[lang] ?? en ?? key`, so every one of these renders
  readable English rather than breaking — which is why it went unnoticed. Not a launch
  blocker while the App Store listing is **US-only** (§0.2), and it becomes one the day
  availability widens. Largest gaps, all English-only unless noted:

  | Keys | Namespace | |
  |---|---|---|
  | 112 | `communities.*` | the biggest single gap |
  | 50 | `gif.*` | |
  | 34 | `offline.*` | **at 6 locales, not 1** — a partial pass that stopped |
  | 27 | `live.*` | |
  | 25 | `groups.*` | |
  | 23 | `report.*` | user-facing moderation copy |
  | 23 | `wallet.*` | money-facing |
  | 18 | `a11y.*` | screen-reader labels |

  `offline.*` sitting at 6 is worth a look on its own — it means a translation pass covered
  six languages and stopped, rather than never starting.

---

## 0.5 POST-LAUNCH FEATURE IDEAS — not launch scope

Parked deliberately. Neither belongs in the first release; both are recorded here with the
research already done so the next look starts from facts rather than from scratch.

### Public-domain music section

Highlight genuinely out-of-copyright music that anyone can use freely.

**Legal in principle. The hard part is proof, not permission.**

Correct the usual premise first: sampling is **not** a public-domain practice. Producers who
sample clear the sample — a licence on both the recording and the composition — or
interpolate (re-record the melody, which still needs a publishing licence), or infringe and
settle. Don't model the feature on how sampling works.

**Every recorded song carries two separate copyrights**, and both must have expired:
the **composition** (melody/lyrics, songwriter and publisher) and the **sound recording**
(that specific performance, the label). Clearing one gets you nothing.

Where the US lines fall, as of July 2026:

| | Public domain |
|---|---|
| Compositions | published **1930** and earlier (95 years from publication) |
| Sound recordings | published **1925** and earlier |

Recordings are the binding constraint. The Music Modernization Act put pre-1923 recordings
into the public domain in 2022, then 100 years for 1923–1946 — 1925 rolled in this January,
1926 arrives next January. **So the catalogue is acoustic-era**: early jazz, ragtime, blues,
marches, opera. Nothing from the 40s, 50s or 60s — a 1957 recording is locked until 2067.

Three traps:

- A **modern recording of a public-domain composition is fully protected.** A 2015 orchestra
  playing Beethoven is Beethoven-free and recording-locked. The most common mistake by far.
- Modern **arrangements and editions** carry their own new copyright.
- Public domain is **per-country**. The US-only App Store restriction (§0.2) helps here —
  only one jurisdiction has to be right. Revisit if availability ever widens; the EU is
  *more* permissive on old recordings (70 years from publication) and less on some
  compositions.

**Build shape, if it ever happens:** a small curated catalogue — hundreds of tracks, not
millions — sourced from places that already did the verification (Library of Congress
National Jukebox, Musopen for classical), with per-track provenance stored: publication
year, source, verification date, which of the two copyrights was checked how. The version
that gets sued is letting users upload and self-certify something as public domain. Keep the
`copyright_strikes` machinery (§0.2 item 0) pointed at it regardless.

**The upside that makes it worth considering:** public-domain tracks have no rights holder,
so they sit outside the PRO obligations in §5. It is the only music servable at zero
licensing cost.

⚠️ **[LEGAL]** Have counsel confirm the specific catalogue before shipping, not the concept.
The downside is a rights-holder claim against an LLC with real money moving through it.

### AI-assisted search and personalisation

Worth doing **only once there are enough users to have data**, which is the whole point of
parking it. Both halves are data-hungry and would launch worse than what exists today.

**Search.** Currently `ilike '%term%'` across `username`, `display_name` and `caption`
(`app/(tabs)/explore.tsx`). That is substring matching: it cannot handle typos, synonyms,
or "sad late-night beats". Two upgrades, in increasing order of cost:

1. **Postgres full-text search** — `tsvector` + a GIN index. No AI, no new infrastructure,
   handles stemming and ranking, and would be a real improvement on `ilike` on its own.
   **Do this one first regardless**; it may be enough.
2. **Semantic search over embeddings** — `pgvector` is available in Supabase, so captions,
   song titles and bios can be embedded and matched by meaning. Embedding is cheap and
   happens once per item at write time; the per-query embedding call is the recurring cost
   and adds latency to a screen that was just optimised hard for responsiveness. Measure
   before adopting.

**Personalisation.** `lib/feedScorer.ts` and the Explore genre clusters already rank on
affinity signals, so this is a refinement rather than a new system. The blocker is the cold
start: collaborative filtering needs many users interacting with many items before it beats
the current heuristics, and on a small library it will confidently recommend the same twenty
posts to everyone. **Rule of thumb: don't start until the interaction table is large enough
that the current affinity ordering is visibly the weak link.**

Two things to settle *before* building, not after:

- **Privacy.** Personalisation on user behaviour has to be disclosed in the Privacy Policy
  and Privacy Center, and the existing opt-in-ads precedent suggests users should be able to
  turn it off. Cheaper to design in than to retrofit.
- **Cost per request.** Unlike everything else in the app, inference bills per call. Any
  design that runs a model on every feed render needs a cache and a ceiling.

---

## 0. Confidence — read this first (2026-07-28)

| Area | Status |
|---|---|
| Money/commerce surfaces (§2) | **Verified**, full file:line evidence |
| Apple/Play billing rules (§2 Phase 1) | **Researched 2026-07-28**, cited to guideline sections and the Epic litigation record |
| Pending SQL run list (§3) | **Verified** from git history |
| App/EAS config + UGC requirements (§4) | **Verified** from `app.json` / `eas.json` / repo |
| Cloudflare Stream orphans (§1) | **Fixed**, needs a device test |
| Music licensing (§5) | **Researched 2026-07-28**, primary sources (copyright.gov, MLC, BMI, CFR, case law) |
| Payments/money law (§6) | **Researched 2026-07-28**, primary sources (FinCEN, COMAR, IRS, Stripe docs) |
| Privacy / minors / business setup (§7) | **Researched 2026-07-28**, primary sources (FTC, state legislatures, USPTO, Maryland) |

All legal research is **informational, not legal advice**, and litigation status in the
minors-safety area changes month to month. Sections 5–7 each end with the specific questions
to bring to counsel. Where a conclusion turns on facts only you can supply — exact user counts
by state, the precision of your stored location values, how shop revenue flows — that is
flagged inline.

---

## 1. Blocking bugs — must be fixed before any submission

### 1.1 Orphaned Cloudflare Stream assets — **FIXED THIS SESSION [CODE]**

The composer prewarms a video upload on the details step, so Cloudflare creates and bills
an asset *before* the user decides to post. The uid lived only in an in-memory `useRef`, so
an app kill, crash, or OS eviction lost it forever — an unfindable asset billing storage
indefinitely. Fixed in two layers:

- **On-device tracker** (`lib/streamUpload.ts`) — every minted uid is persisted to
  AsyncStorage *before the first byte moves*, stamped with its owner. Cleared when a post or
  ad creative provably references it, or when the asset is deleted.
- **Boot sweep** (`app/_layout.tsx`) — on each launch, leftovers from a dead process are
  checked against `posts.video_uid`, `posts.media_url` and `ad_creatives.media_url`. Still
  referenced → forget it. Unreferenced and older than 10 minutes → delete via the existing
  ownership-checked `stream-delete` function. Capped at 20 per launch; a failed database
  read aborts rather than assuming "no references."
- **Server backstop** (`supabase/functions/stream-sweep/`, **new — not deployed**) — for
  users who uninstall or never return. Dry-run by default, skips live recordings, skips
  anything younger than 24h, requires a `STREAM_SWEEP_SECRET` header.

✅ **RESOLVED AND VERIFIED IN PRODUCTION, 2026-07-28.**

The sweeper's first real run confirmed the bug was live: **10 orphans out of 37 aged assets —
a 27% leak rate.** The pattern was unmistakable — three uploads from one creator inside two
minutes, two of them byte-identical, plus one **zero-byte** asset (an upload URL minted with
nothing ever sent). Exactly the abandoned-prewarm signature. All 10 deleted, zero failures,
after verifying each uid against `posts.video_uid`, `posts.media_url` and
`ad_creatives.media_url`.

Run `node scripts/stream-sweep.mjs` **monthly** (dry run; add `--apply` to delete). It rotates
its own secret each run, so a leaked value dies on next use. The client-side tracker now
catches the common case as it happens — **a large future number means that regressed.**

- [ ] **[CODE]** Device test still worth doing on the production build: post a video,
      force-quit mid-prewarm, relaunch, confirm the asset disappears and a *published* video
      is untouched.

### 1.2 Wallet payout trap — **FIXED THIS SESSION [CODE]**

`lib/wallet.ts:19-27` sums a spendable balance from money Laybell never collected, and the
UI offers to send it to a bank. Two independent legs:

- **Donations** are a bare client-side `INSERT` with no processor (`lib/donations.ts:107`).
  Two accounts can mint balance at $500 a tap.
- **Shop earnings** count 85% of off-platform sales — money the seller *already received
  in full, directly from the buyer*. The app itself says "Laybell doesn't process payments."
  That number should never have been on this screen.

`requestPayout()` was a single `AsyncStorage.setItem`, and the UI said *"Your money is safe
and waiting."* Nothing was waiting.

**The fix — a collected-funds gate.** `lib/wallet.ts` now has two explicit flags,
`PLATFORM_COLLECTS_DONATIONS` and `PLATFORM_COLLECTS_SHOP`, both `false`. A wallet *balance*
is a promise that Laybell is holding money for you, so it may now only count money Laybell
actually collected — which today is nothing. Earnings are still shown, but as a **lifetime
record** ("Earned on Laybell"), not a withdrawable balance. `payoutsAvailable()` gates the
transfer path, and `requestPayout()` refuses while it is false. Flip a flag when that
revenue stream genuinely settles into a Laybell-controlled account.

The screen (`app/wallet.tsx`) shows the lifetime figure with an honest label while payouts
are unavailable, and the standing note now explains that shop sales are paid directly by the
buyer and tips aren't being charged yet.

### 1.3 Wrong fee disclosed to donors — **FIXED THIS SESSION [CODE]**

`lib/i18n.ts` hardcoded *"Laybell fee (15%)"* while the real rate is 8% Premium / **35%**
standard. Now interpolated (`Laybell fee ({pct}%)`) and derived from the host's actual plan
in `components/LiveDonateModal.tsx`, so a donor always sees the rate applied to their tip.

### 1.4 Shop refund copy — **FIXED THIS SESSION [CODE]**

The old copy promised buyers they "get their money back" on a transaction Laybell never held
and cannot reverse. Rewritten in **all 10 languages**: taking a listing down revokes buyer
access, and because payment was arranged directly between the two users, settling any refund
is the seller's own responsibility.

### 1.5 Shop earnings cap bug — **CODE FIXED / SQL APPLIED 07-28, BUT NEEDS A RE-RUN**

> **Superseded, read this first (2026-07-29).** `wallet_earnings.sql` *was* applied on
> 2026-07-28 (§3.1 item 14), so the "still pending" text below is stale. But the file
> changed again on 2026-07-29 to derive the fee from `shop_fee_rate()` instead of a
> hardcoded `0.85`, so it must be **re-run** — see §0.2 item 0b. The bug is no longer an
> under-count; it is now an **over**-count of 15 points until the re-run.

`SCALE_HARDENING_2026-07-23.md` marks this fixed, but the fix routes through the
`delivered_earnings()` RPC, which **only exists once `wallet_earnings.sql` is run**. Until
then the code silently falls back to a client-side sum capped at 100 rows
(`lib/shop.ts:587-596`), so a busy seller's balance is short.

The **second instance** the doc missed — the Shop hub's "Earned" stat, which never consulted
the RPC at all — is **fixed this session**: `app/shop/index.tsx` now calls
`fetchDeliveredShopEarningsCents()` like the Wallet does. Both paths still need
`wallet_earnings.sql` (§3.1 item 14) to be run before the server-side sum exists.

---

## 2. The money decision — **make this first, it gates everything else**

Nothing in the app charges real money. There is no Stripe, no PayPal, no working IAP.
But **seven surfaces show real dollar amounts and four accept a "purchase" action**:

| Surface | What the user sees | What happens |
|---|---|---|
| Premium $9.99/mo | Full paywall, 7 perks, "$9.99/month" | "Coming soon" card — RevenueCat keys are `""` |
| Donations/tips | `$1–$50` presets, fee breakdown, **"You pay $2.12"** | Row insert. No processor. Credits a withdrawable balance |
| Wallet | **"Available balance $X"**, "Transfer to bank" | `AsyncStorage.setItem` |
| Spotlight | 4 tiers $5.99–$49.99, **"Pay $24.99"** | Simulated row — but the boost is *real* |
| Ad Manager | Budget input, **"Launch campaign · $20.00"** | Simulated row — but the ads *really serve* |
| Shop | `Buy · $X`, "You earn $X", 15% fee | Honestly off-platform. Real file unlocks in-app |
| CPM engine | "Spent $X of $Y" | Correct arithmetic on fake money |

Two things make this urgent:

1. **Apple rejects shipped-but-nonfunctional features** (Guideline 2.1/2.2). A paywall that
   says "coming soon" is a textbook rejection.
2. **A "Pay $24.99" button that mints a real product for free is a business hole**, not just
   a review risk.

### DECISION (2026-07-28): wire everything properly

The owner chose to build real payments across all surfaces rather than hide them for v1.
That is a multi-week project with hard external dependencies, so it runs in phases.

**Phase 0 — architecture-independent (DONE this session).** Correct under every payment
design, so it was safe to do before the rails are chosen: the collected-funds gate (§1.2),
the fee disclosure (§1.3), the refund copy (§1.4), and the earnings cap (§1.5).

**Phase 1 — determine the rails. RESOLVED 2026-07-28 (researched, sourced).**

The answer is worse than hoped: **five of the six surfaces require Apple IAP.** There is no
user-to-user carve-out for digital goods, and Apple names post-boosting explicitly.

| Surface | Apple | Guideline | Google Play | Confidence |
|---|---|---|---|---|
| Premium $9.99/mo | **IAP** | 3.1.1 | Play Billing | High |
| Tips to a live host | **IAP as designed** | 3.2.1(vii) fails; 3.1.3(d) excludes one-to-many | **Exempt** if 100% to creator + no digital benefit | Med-high |
| Shop (beat/song file) | **IAP** | 3.1.1; 3.1.3(e) is *physical* goods only | Play Billing | High |
| Spotlight (boost own post) | **IAP — named explicitly** | 3.1.3(g): "sales of 'boosts' for posts in a social media app" | Not required in practice | Very high |
| Ad Manager | **IAP** (Laybell displays the ads, so the campaign-management carve-out fails) | 3.1.3(g) | Not required in practice | High |
| Wallet payouts | **Outside IAP** — Stripe Connect | n/a | Outside Play Billing | High |

**Why tips fail the gift carve-out.** Guideline 3.2.1(vii) permits person-to-person gifts
outside IAP only if the gift is optional **and 100% goes to the receiver**, and it dies if the
gift is "connected to or associated at any point in time with receiving digital content or
services." Laybell breaks it twice: the platform takes 8%/35%, and the **on-stream donation
alert is consideration received in exchange for the tip** — the same mechanic as a Twitch bit.
Separately, 3.1.3(d)'s person-to-person route is closed by its own terms: "One-to-few and
one-to-many real-time services must use in-app purchase," and a livestream is one-to-many.
Also: **never call these "donations" or "fundraising" in UI copy** (3.2.2(iv) pulls that into
the charity rules, which only Apple-approved nonprofits may use in-app).
✅ **DONE 2026-07-28** — every user-visible string is now "tip"; `grep` for donation copy in
`lib/i18n.ts` returns zero. Only English defined these keys (the other nine languages fall
back), so it was a single-block change. Database names (`donations`, `donation_guard`) are
deliberately untouched — only the words a user reads matter here.

Two stale claims went with it: the note said Laybell keeps a flat **15%** (the real rate is
8%/35%, now shown live in the breakdown), and the locked-state copy claimed only Premium
creators can receive tips (`hostCanReceive()` has always returned true).

**Live enforcement signal:** Apple has told Patreon to move all creators to IAP by
**November 2026** or face removal. This category is being actively policed, not ignored.

**The US anti-steering window.** Since the April 2025 contempt ruling, US apps may include
real buttons and calls-to-action linking to external web checkout, with **no entitlement
required and, today, 0% Apple commission**. But the Ninth Circuit vacated the total
commission ban as overbroad (Dec 2025), and **the Supreme Court granted cert in June 2026** —
so a replacement cost-based fee is coming, at an unknown rate. **Do not build economics that
only work at 0%.**

**Play is now the permissive one**, which is the opposite of most people's intuition: US
alternative billing costs ~10% vs ~15% via Play Billing — a 5-point saving, not 30. And Play
explicitly exempts tips where 100% goes to the creator.

### The architectural decision that makes this cheap

Put a **single server-side ledger** between features and processors. Every surface debits or
credits a Laybell balance; IAP, Play Billing and Stripe become interchangeable **funding
sources** into that ledger. iOS funds via IAP, Android via Play Billing, web via Stripe,
payouts drain via Stripe Connect. When Apple's external-link commission finally lands at
whatever number, you change a funding source — not five features.

Two consequences worth building around:

1. **Copy Meta's ad pattern.** Fund an ad/promotion balance **on the web** (Stripe, outside
   the app), and let the in-app Ad Manager and Spotlight *spend* that balance. Spending a
   pre-funded balance is not a purchase transaction. This single move takes both surfaces out
   of IAP scope legitimately.
2. **The shop needs credits or a price ladder.** Prices are creator-set and per-listing, so
   SKUs can't be enumerated. Either constrain sellers to a fixed IAP price-point ladder, or
   sell a **Laybell Credits** consumable and denominate the shop in credits. Credits are
   cleaner and cover tips too.

### Phase 2 progress (2026-07-28)

✅ **Ledger** — `ledger.sql`, verified working in production (§2.1).
✅ **Premium + Credits configured on iOS** — App Store Connect products, RevenueCat project,
   entitlement `premium`, `default` + `credits` offerings, SDK key in `app.json`, webhook
   secret set and pointed at `revenuecat-webhook`.
✅ **Credits funding** — `revenuecat-webhook` posts purchases into the ledger, idempotent on
   RevenueCat's event id, with refund reversal. **Fixed a latent bug on the way:** the webhook
   wrote `premium_until` on *every* event type, so buying credits (which arrive with
   `expiration_at_ms: null`) would have silently cancelled the buyer's Premium subscription.
✅ **Credits purchase screen** — `app/credits.tsx`. Says credits are *on the way* rather than
   claiming a balance that hasn't landed: the store charges instantly, the webhook credits
   asynchronously.
✅ **Tips spend from the ledger** — `ledger_spend.sql`. Server computes amount bounds, fee
   rate and split; the client names only a target and an amount. **Both livestream and studio**
   tips go through one shared implementation, and a restrictive RLS policy now blocks direct
   client INSERTs into `donations` — closing the "conjurable tip" hole in the database, not
   just in the app.
- [ ] **Stripe Connect payouts** — the last piece; earnings can accrue but not leave.
- [ ] **Android** — blocked twice over: Play won't create in-app products until a bundle is
      uploaded, and RevenueCat can't add the Play app until those products exist.
- [ ] **Nothing is testable until a build exists** — RevenueCat is a native module and cannot
      run in Expo Go.

**Phase 2 — remaining.** Needs a Stripe account (owner), and an attorney + CPA engaged on §6
before real money moves. Work, in dependency order:

1. ✅ **The ledger — BUILT 2026-07-28** (`supabase/sql/ledger.sql`, `lib/ledger.ts`).
   Double-entry, append-only, server-authoritative. See §2.1 below.
2. **Funding sources** — StoreKit 2 / Play Billing consumables (credits), plus Stripe web
   checkout for the ad balance and external-link purchases.
3. **Server-side crediting** — tips must stop being a client-side insert
   (`lib/donations.ts:107`); every credit arrives via a verified receipt or a webhook.
4. **Stripe Connect** for payouts, then flip the §1.2 flags.
5. **Rename "Donate" → "Tip"/"Support"** app-wide before submission (3.2.2(iv)).

### 2.1 The ledger (built 2026-07-28)

Every feature moves value against one ledger; each processor is merely a **funding source**
into it. Wiring five surfaces to three processors directly would be fifteen integrations — and
since Apple's external-purchase commission is actively being re-litigated, the rails *will*
change. This way that's a funding-source swap, not five rewrites.

```
Apple IAP ─┐
Play Bill. ─┼──▶ [ credits ] ──▶ purchases / tips ──▶ [ earnings ] ──▶ Stripe payout
Stripe web ─┘
```

**The account split is load-bearing, not cosmetic.** `credits` are bought with real money but
are **spend-only and never redeemable for cash** — that is precisely what keeps them out of
stored-value/prepaid-access territory and away from state money-transmitter licensing (§6.3).
`earnings` is the only cashable balance. **Never add a credits → bank path.**

Five invariants, enforced by constraint rather than convention:

1. **Entries are append-only** — update and delete raise, for the service role too.
   Corrections are posted as new compensating transactions. A ledger you can edit isn't one.
2. **Every transaction sums to zero** — money moves, never appears. `ledger_post` rejects
   unbalanced legs.
3. **Idempotent posting** — unique on `(source, external_id)`. A retried Stripe webhook or
   re-validated Apple receipt cannot double-credit. Handles concurrent duplicate delivery too,
   not just sequential retries: the loser of the race returns the winner's transaction id.
4. **Balances can't drift** — maintained by trigger over an append-only log, so there is no
   edit path that could desync them. `ledger_verify()` audits it anyway.
5. **No client can write** — no write policy exists on any ledger table, and `ledger_post` is
   revoked from `authenticated`. `lib/ledger.ts` is read-only by design and must stay that way.

Also handled: user accounts can never settle negative (the platform account may, since
absorbing a chargeback before recovering it is a real state worth showing); the
negative-balance check runs *after* all legs post, because a single transaction may legitimately
debit and re-credit the same account; the statement view uses `security_invoker` so RLS
evaluates as the caller; and `ledger_verify` is revoked from `PUBLIC`, since Postgres grants
EXECUTE to everyone by default and it would otherwise expose every balance on the platform.

**The hold window** (§6.5) is built in: entries carry `available_at`, so a shop sale can sit
14 days before becoming withdrawable and a chargeback lands before the seller cashes out.
Available balance is computed rather than stored, because it changes with the clock rather than
with any write. The wallet now shows held funds as "clearing".

`fetchWalletBalance()` reads the ledger when it exists and falls back to the old derived sums
otherwise. Once applied, **the ledger supersedes the `PLATFORM_COLLECTS_*` flags** — it
structurally guarantees what they only asserted by convention, since a balance can exist only
because a server-side transaction created it.

✅ **APPLIED AND VERIFIED on the live database, 2026-07-28.** All 20 migrations ran. A
functional test then confirmed, end to end: money can enter; **a retried payment webhook
cannot charge twice**; an unbalanced transaction is refused; nobody can spend money they don't
have; no money was created or destroyed; and stored balances match the entry history. The test
posted real transactions and rolled them all back, so the ledger is clean.

To re-run that check any time (it ends in a deliberate error — that's what undoes it), see the
verification block in the session notes, or just run the two audit queries at the bottom of
`ledger.sql`:

```sql
select coalesce(sum(amount_cents), 0) from public.ledger_entries;  -- expect 0
select * from public.ledger_verify();                              -- expect 0 rows
```

**One fix was needed to get here:** an unqualified `id` in a row-level-security policy was
ambiguous across three joined tables and Postgres refused the whole file. Fixed, plus three
more of the same shape found by an added lint check before they could bite.

**Interim posture:** until Phase 2 ships, the money surfaces are honest but non-functional.
Premium still shows "coming soon" — **that alone is a likely Apple 2.1 rejection**, so if
submission comes before Phase 2, Premium must be either wired (it can be, independently of
everything else) or hidden.

---

## 3. Backend — SQL and functions **[OWNER]**

### 3.1 Pending SQL, in dependency order

Derived from git history: every file authored or modified *after* the last aggregator
(`_RUN_PREMIUM_2026-07-07.sql`, which already covers premium, donations v1, follower
insights, spotlight credit, and Laybell communities). Almost all are idempotent, so the
safe move is to **run the whole list top to bottom** rather than guess what's applied.

> ✅✅ **ALL 20 MIGRATIONS APPLIED SUCCESSFULLY, 2026-07-28.** This section is now history —
> keep it only as the record of what was run and in what order. The bundle files remain in
> the repo and are idempotent if a fresh environment ever needs rebuilding.
>
> Bundled in dependency order into three parts:
>
> - `supabase/sql/_RUN_LAUNCH_2026-07-28_part1.sql` (68 kb)
> - `supabase/sql/_RUN_LAUNCH_2026-07-28_part2.sql` (70 kb)
> - `supabase/sql/_RUN_LAUNCH_2026-07-28_part3.sql` (88 kb)
>
> **Run the parts in order and let each finish before starting the next** — later files
> depend on objects earlier ones create. Everything is idempotent, so re-running a part you
> already applied is safe. Dollar-quoting was verified balanced in all three.

```
 1. badges.sql              (re-run — updated 07-09)
 2. spotlight.sql           (re-run AFTER badges)
 3. tagged_mentions.sql     (re-run — updated 07-09)
 4. music_order.sql
 5. admin_console.sql       ─┐ strict order
 6. admin_console_rpcs.sql  ─┘
 7. originality.sql         (AFTER admin_console_rpcs)
 8. donations.sql           (re-run — adds the `message` column)
 9. studio_live.sql         (AFTER donations — rewrites donation_guard v3)
10. live_heartbeat.sql
11. ad_ecosystem.sql        (re-run — adds `objective` columns)
12. post_top_caption.sql    (re-run — v2)
13. shop_multi.sql
14. wallet_earnings.sql     (fixes §1.5)
15. scale_indexes_2.sql
16. content_filter.sql      (NEW — term blocklist behind lib/contentFilter.ts)
17. shop_downloads.sql      (NEW — dispute-evidence log; AFTER shop.sql)
18. minor_safety.sql        (NEW — is_minor() + followers-only DMs for minors;
                             AFTER profile_fields.sql)
19. ledger.sql              (NEW — the payments ledger; no deps beyond auth.users)
20. social_auth_trigger.sql (RUN LAST — rewrites the auth.users trigger;
                             fixes Apple/Google "Database error saving new user")
```

- [ ] **[OWNER]** Verify the Tier-1 set really was applied (`message_reactions`,
      `group_chats`, `conversation_reports`, `message_delete`, `user_gifs`, `scale_indexes`).
- [ ] **[OWNER]** Storage buckets `posts` and `avatars` are **not created by any SQL file** —
      they were made in the dashboard. They must exist in the launch project. (The old
      "create an `ads` bucket" note is stale; `lib/ads.ts` reuses `posts`.)
- [ ] **[OWNER]** Add your account to `laybell_admins` (bottom of the premium aggregator).

### 3.2 Edge functions and secrets

**17** functions in `supabase/functions/` (the old count of 15 missed `stripe-connect` and
`log-access` — which were also the two with no checklist coverage at all). Blocking for launch:

- [ ] **[OWNER]** `STRIPE_SECRET_KEY` — **payouts are counted as a live money surface in §0.1,
      but this secret appears nowhere else in the repo.** Without it `stripe-connect` cannot
      onboard a creator, read status, or move money: every payout path no-ops.
- [ ] **[OWNER]** `STRIPE_CONNECT_RETURN_URL` — defaults to `https://laybell.app/payouts`.
      Confirm that page exists, or onboarding returns the creator to a 404.

- [ ] **[OWNER]** `CF_ACCOUNT_ID` + `CF_STREAM_TOKEN` — powers **all** video posting and Live
      (`stream-direct-upload`, `stream-status`, `stream-delete`, `stream-sweep`, `live-input`).
      Without these, video posting is dead.
- [ ] **[OWNER]** `STREAM_SWEEP_SECRET` + deploy `stream-sweep` (§1.1).
- ✅ **[OWNER] AUTH SMTP DONE 2026-07-28 — signup emails now deliver.** Resend on
      `laybell.app`; DKIM (`resend._domainkey`), MX + SPF on the `send` subdomain, all four
      records verified resolving from outside. Template carries `{{ .Token }}`, so the in-app
      6-digit screen works.

      **Three things went wrong, worth recording:**
      1. GoDaddy Domain Connect reported *"successfully connected"* and wrote **nothing**.
         Caught only by querying DNS directly — never trust the success screen.
      2. Test signups were hitting `user_already_exists`, which sends no email and looks
         identical to a broken mail setup. Gmail `+alias` addresses solve this.
      3. **The actual cause: "Confirm email" was OFF.** Every signup was paired with an
         instant `Login` event in the auth logs — a session issued immediately means no
         confirmation email is ever sent, by any provider. The Resend setup was never the
         problem. *Two events at the same timestamp was the tell.*

- [ ] **[OWNER]** Remaining email polish: raise **Auth → Rate Limits** to ~30/hour (the
      default is sized for Supabase's built-in sender), fix the **DMARC** record (`rua` to
      your own address, `p=none` for the first week), and delete the `+test` users.
- [ ] **[OWNER]** `REVENUECAT_WEBHOOK_SECRET` + webhook — only if Premium ships wired.
- [ ] **[OWNER]** Confirm APNs (iOS) and FCM (Android) credentials in EAS for push.
- Deferrable: LiveKit secrets (Studio), custom Google Cast receiver (Live→TV Phase 2).
- Never set `SUPABASE_*` manually — those are auto-injected.

---

## 4. Store submission

### 4.1 Config — verified this session

| Item | State |
|---|---|
| Bundle / package | `com.laybell.app` both platforms ✅ |
| Version | `1.0.0`; no `buildNumber`/`versionCode` — EAS `autoIncrement` handles it ✅ |
| EAS `production` profile | Exists with `autoIncrement: true` ✅ |
| `eas.json` → `submit.production` | **Empty `{}`** — needs Apple/Google submit credentials |
| Encryption compliance | `ITSAppUsesNonExemptEncryption: false` declared ✅ |
| Permission strings | Supplied by config plugins (camera, mic, photos, location, contacts) ✅ |
| Sign in with Apple | `usesAppleSignIn: true` ✅ — **required**, since Google sign-in is offered |

### 4.2 Gaps to close

- [ ] **[OWNER]** **Apple App Store ID** — `id000000000` is still a placeholder in **two**
      files that must stay in sync: `lib/appLinks.ts` (`STORE_URLS.ios`) and `web/open.html`
      (`STORE` object). Until swapped, every iOS "get the app" link dead-ends.
- [ ] **[OWNER]** **Deep links do not verify.** `app.json` declares
      `applinks:laybell.app` (iOS) and Android `autoVerify` for `laybell.app/post`, but
      laybell.app is a **GoDaddy builder site that cannot serve `/.well-known/` files**.
      Universal links and branded share links silently fail. Share origin is currently the
      off-brand `https://3ddies.github.io/laybell`. Fix = point laybell.app at GitHub Pages
      (repo Settings → Pages → custom domain + GoDaddy A-records), then flip `WEB` in
      `supabase/functions/share-page/index.ts` and `STATIC_WEB_ORIGIN` in `lib/appLinks.ts`
      back to `https://laybell.app` and redeploy/rebuild.
- [ ] **[CODE]** **Android `FOREGROUND_SERVICE` has no declared type.** Android 14+ requires
      a typed foreground service and Play requires a justification form for several types.
      Verify against current Play policy before submitting.
- [ ] **[OWNER]** `READ_CONTACTS` and `ACCESS_COARSE_LOCATION` are sensitive permissions —
      expect a Play Console declaration and Data Safety detail for both.
- [ ] **[CODE]** **iOS privacy manifest** — confirm `PrivacyInfo.xcprivacy` is generated with
      required-reason API declarations. Expo modules cover their own, but LiveKit, WebRTC,
      Google Cast, Google Sign-In and RevenueCat each need theirs present. **Unverified.**
- [ ] **[OWNER]** Store metadata: description, keywords, subtitle, promo text, support URL,
      marketing URL, privacy-policy URL, and screenshots per device class.
- [ ] **[OWNER]** Age rating questionnaires — answer honestly for UGC + livestreaming + DMs.
- [ ] **[OWNER]** Data Safety (Play) and App Privacy nutrition label (Apple) — start from
      `docs/STORE_PRIVACY_DISCLOSURES.md`.
- [ ] **[OWNER]** First **production** build: everything so far shipped as `preview`/internal.
      Needs `eas build --profile production` + `eas submit`.

### 4.3 UGC requirements — both stores

Apple Guideline 1.2 and Play's UGC policy require five things. Verified in the repo:

| Requirement | State |
|---|---|
| **Report content** | ✅ Wired broadly — posts and authors via the 3-dot sheet (`contexts/PostOptionsContext.tsx:480`), comments (`components/Comments.tsx:307`), DMs (`app/messages/[id].tsx:704`), stories, GIFs |
| **Block abusive users** | ✅ `lib/blocks.ts`, `app/blocked.tsx`, block-confirm flow |
| **Account deletion in-app** | ✅ Settings (`app/settings.tsx:478`) and Privacy Center (`app/privacy-center.tsx:156`), backed by the `delete-account` function |
| **Published contact info** | ✅ Legal docs + contact inboxes (per `LEGAL_ROLLOUT.md`) |
| **Filter objectionable content from being posted** | ✅ **BUILT 2026-07-28** — `lib/contentFilter.ts` |

**The content filter** (was the one gap). Modelled on the existing `blocked_link_domains`
pattern: a small built-in seed merged over a curated `blocked_terms` table the owner tunes
from the dashboard **without shipping an app update**, since moderation policy moves faster
than release cycles. Two severities — `block` refuses the write, `review` allows it and flags
for the queue. Wired into **post captions** (before any upload work, so a refusal never costs
a long video upload) and **comments**.

The real engineering is in normalisation, because naive substring matching is trivially
evaded: full-width folding, diacritic stripping, zero-width character removal, leetspeak
collapse and repeat collapse, with word-boundary matching to avoid the Scunthorpe problem.
A unit test caught a genuine bug — `!` mapped to `i` as leetspeak, so an ordinary
`"NUDES!!!"` normalised to `"nudesii"` and slipped straight through. Symbol substitutions now
apply only between two alphanumerics. 12/12 cases pass, including seven false-positive guards.

⚠️ It is a **speed bump, not a boundary** — it runs client-side, so a modified client bypasses
it. Real enforcement remains the moderation console plus reporting.

- [x] ~~**[OWNER]** Run `content_filter.sql`~~ — **applied 2026-07-28** (§3.1 item 16).
      Still to do: expand `blocked_terms` from the dashboard.
      The seed is deliberately minimal (unambiguous slurs + solicitation patterns) — an
      over-broad filter trains users to route around it and buries the queue in false
      positives.
- [ ] **[OWNER]** State the **24-hour moderation response commitment** in the App Review
      notes, and make sure the admin console can actually meet it.

### 4.4 Native rebuild debt

A dev-client/production rebuild is required before submission — these are native modules
that autolink but aren't in the current binary:

- `react-native-video-trim` (trimming silently falls back to virtual until rebuilt)
- `react-native-pager-view` haptic patch (`patches/`, via patch-package)
- `expo-blur`, RevenueCat, NetInfo

Three patch-package patches apply automatically on a clean EAS install.

---

## 5. Music licensing — **[LEGAL] RESEARCHED 2026-07-28**

Informational research, not legal advice. Counsel is genuinely required on four points (§5.7).

### 5.1 The answer you most need: yes, you need PRO licences

**"All tracks are indie originals" does NOT exempt you.** The mechanism is *assignment*, not
repertoire. A songwriter affiliated with ASCAP or BMI has **already granted the performance
right to their PRO** — so they cannot grant it to you in your ToS. Your clause is void as to
that right. Independent rappers and producers are overwhelmingly PRO-affiliated, because
that's how performance royalties get collected and distributors push affiliation hard.

📄 **Ready-to-send pack: `docs/PRO_LICENSING_PACK.md`** — fact sheet, both pre-written emails,
the BMI form walkthrough, and the order of operations.

- ✅ **[OWNER]** **ASCAP emailed** 2026-07-28 (`weblicense@ascap.com`) — awaiting reply.
- ✅ **[OWNER]** **BMI LICENSED** 2026-07-28 — Digital Multi-Use Performance License
      Agreement, **$385/year, one-year term**, grants streaming performance rights for the
      BMI repertoire. ⚠️ **Annual renewal — diary it**; a lapse means performing BMI
      repertoire unlicensed.
- 📧 **BMI reporting clarified by Violet Cieri (vcieri@bmi.com), email 2026-07-31** —
      supersedes the earlier "no reporting requirements" read: **under this structure ALL
      revenue is reported.** Laybell tracks its revenue, and **at $18,500 gross revenue,
      contact Violet** to move to "the next most appropriate option" (the percentage-based
      structure). Practical monthly check (pair with the §8 stream-hours check —
      auto-terminate risk at 20% over 59,000 hrs, metered by `stream_hours.sql`):
      gross = App Store Connect + Play Console payment reports + anything direct. The
      threshold is generous pre-launch; the point is to notice the approach, not to fear it.
      **Save the email.**
- [ ] **[OWNER]** Get written confirmation the licence covers **on-demand interactive audio
      AND livestream audio-visual**. A "website & mobile app" audio licence may not, and
      finding out post-launch is the expensive way. **Save the reply.**
- [ ] **[OWNER]** Write the dated SESAC/GMR deferral note — deferring is defensible,
      deferring by accident is not.
- ⚠️ **BMI's gross-revenue base explicitly includes "donations, commissions from third party
  transactions"** — your tips and your 15% shop cut are inside the royalty base.
- SESAC and GMR publish nothing and must be negotiated. Small repertoire slices; defensible
  to defer with a documented decision.

**Masters are clean** — interactive services are excluded from the §114 statutory licence, so
SoundExchange is irrelevant; your ToS grant from the uploader *is* the master licence.

### 5.2 Mechanicals, the MLC, and a cost cliff to model NOW

Offline caching makes this unavoidable: an offline copy that dies with entitlement is a
**limited download**, a digital phonorecord delivery, a covered activity under §115.

The **variable** royalty is near zero for you — the rate is the greater of ~15.35% of revenue
or a content-cost prong, **minus** what you pay the PROs, and **free ad-supported services
have no royalty floor**. Your real cost is the fixed administrative assessment:

| Monthly unique recordings used | Annual assessment |
|---|---|
| ≤ 10,000 | **$2,500** |
| 10,001–25,000 | **$5,000** |
| **> 25,000** | **$60,000** |

- [ ] **[OWNER]** **Model the 25,000-recording cliff against your growth curve before
      launch.** A UGC music platform crosses 25k unique monthly recordings long before it
      crosses $60k of revenue. This is the single most important number in this section. The
      metric is recordings *used and reported*, not catalogue size — which is a product lever
      worth asking counsel about.
- [ ] **[LEGAL]** Decide your MLC posture (§5.7 item 2). Declining the blanket licence is not
      free: you may become a "significant nonblanket licensee" owing a Notice of Nonblanket
      Activity plus monthly reports, with **treble damages and attorney's fees** for
      non-compliance.
- [ ] **[CODE]** Monthly usage reporting pipeline (SURF format is Excel-completable early;
      DDEX DSRF later) — this is an engineering task, not paperwork.
- [ ] **[OWNER]** Annual report of usage requires **CPA certification** — a recurring
      several-thousand-dollar line item.

### 5.3 DMCA — the part beyond the agent

- [ ] **[OWNER]** ⚠️ **Your agent designation expires every three years.** $6 to renew. Set a
      calendar reminder with 60 days' lead. This is the cheapest catastrophic failure
      available to you — miss it and the safe harbour lapses.
- [ ] **[OWNER]** Publish on-site: full legal entity name, physical street address, **all
      trade names (including "Laybell" if the LLC name differs)**, and the agent's details.
> **These four are BUILT, not pending code (2026-07-29).** `supabase/sql/copyright_strikes.sql`
> implements notice intake, the §512(g) counter-notice clock (`add_business_days`),
> override-free trigger-fired termination, and the append-only audit log. It was committed
> 2026-07-28 and then left out of every run bundle, so **none of it exists in the database
> yet** — it is now in `_RUN_PENDING_2026-07-29.sql` (§0.2 item 0). Until that runs, Terms §8
> promises machinery that isn't there, which is the §512(i) "reasonably implemented" problem
> *BMG v. Cox* turns on. The remaining real work is the **UI** to work the queue.

- [ ] **[CODE]** §512(c)(3)-compliant notice intake with *expeditious* removal — build it as
      tooling, not an inbox. A solo founder cannot manually process notices at scale, and the
      failure mode isn't "slow", it's safe-harbour loss.
- [ ] **[CODE]** §512(g) counter-notice with the 10–14 business-day putback window.
- [ ] **[CODE]** **Deterministic repeat-infringer termination, enforced in code, with no
      manual override.** *BMG v. Cox* lost the safe harbour on exactly that override — a
      policy that existed on paper but bent for valuable accounts. *Ventura v. Motherless*
      shows a **sole operator can win** with an informal policy — because he could prove he
      had terminated 1,320–1,980 users with only nine slipping through. **You win on logs.**
- [ ] **[CODE]** Immutable append-only audit log of every notice, strike and termination;
      strikes attach to the *uploader* and survive post deletion; block re-registration by
      email; termination must propagate across surfaces (pull their shop listings, their
      sounds from the picker, their cached files).

**Red-flag knowledge — a specific exposure for you.** A solo founder who personally curates
(Spotlight, featured, communities, hand-ordered playlists) repeatedly puts his own eyes on
specific items. Curation doesn't destroy the safe harbour, but "I featured it on the front
page" + "it's plainly a major-label record" is the fact pattern a plaintiff builds on.

### 5.4 The shop commission is your highest-risk revenue shape

§512(c)(1)(B) strips the safe harbour where you get a "financial benefit **directly
attributable** to the infringing activity" **and** have the right and ability to control it.
Both halves must be met.

Ad revenue is diffuse and untethered — that's why *Motherless* won. **A 15% commission on the
sale of an infringing beat is revenue arithmetically derived from that specific infringing
transaction.** On the "directly attributable" half, that's close to the worst-shaped revenue
you could design. What normally saves you is the control half — but *Perfect 10 v. Cybernet*
found control where a platform combined **revenue-share with curation/pre-screening**. Laybell
already curates. **The combination is the danger, not either alone.**

Mitigations, in order of value:
- [ ] **[OWNER/CODE]** **Restructure the shop fee from a percentage to a flat listing fee or
      seller subscription.** Highest-leverage change available — it attacks the "directly
      attributable" half head-on. If you keep a percentage, keep it uniform and never vary it
      by performance.
- [ ] **[CODE]** **Keep editorial curation off the shop surface entirely** — that severs the
      *Cybernet* "detailed policing" factor.
- [ ] **[CODE]** Fingerprint the shop specifically (§5.6) — lowest volume, highest risk.
- [ ] **[CODE]** Automatic refund-and-terminate on a substantiated shop takedown, logged.

### 5.5 "Use this sound", livestreams, and the shop's contract bug

**"Use this sound" is a synchronisation use** — no compulsory licence exists. TikTok bought
negotiated, expiring publisher and label deals; you cannot. Restrict it to platform-uploaded
tracks only. The ToS sublicense **holds against the uploader** but **fails against anyone the
uploader couldn't bind** — a co-writer, a publishing administrator, a sample owner. It changes
your risk posture (good-faith reliance + indemnity + §512), it is not a licence.

> **Both are BUILT, not pending code (2026-07-29).** `supabase/sql/sound_optin.sql` provides
> `allow_sound()` (per-track consent) and `withdraw_sound()` (the global kill switch — it
> works because the song is never baked into the video file, so clearing the attribution
> reverts every derivative post). Same story as §5.3: committed 2026-07-28, in no run bundle,
> **not in the database**. Now in `_RUN_PENDING_2026-07-29.sql` (§0.2 item 0).

- [ ] **[CODE]** Separate **per-track opt-in** for "use this sound", distinct from the general
      upload grant — specific consent reads far better than a buried blanket clause.
- [ ] **[CODE]** **Global kill-switch** pulling a sound from every derivative post at once.
      Without it, one takedown is a thousand-post problem you cannot execute "expeditiously".

**Livestreaming** adds sync (music + video) and master use (if hosts play records) on top of
performance. Twitch is the cautionary tale — PRO deals but no label deals, then mass DMCA
notices in 2020.
✅ **[CODE] DONE 2026-07-28 — replay retention is now opt-in.** `live_replay.sql`,
      `supabase/functions/live-input` (redeployed), `lib/live.ts`, `app/live/go-live.tsx`.

      ⚠️ **The CODE is done; `live_replay.sql` was never run** (it is in no bundle — corrected
      2026-07-29, now in `_RUN_PENDING_2026-07-29.sql`). Until it is applied,
      `live_streams.replay_*` doesn't exist, so the attestation has nowhere to land.

      Live inputs were being created with `recording: { mode: 'automatic' }`, so **every
      broadcast was being saved by default.** Now `mode: 'off'` unless the host explicitly
      asks, and the opt-in is phrased as a rights question rather than a convenience, with the
      attestation timestamped in `live_streams.replay_attested_at`.

      The distinction is exactly the one BMI §3.B draws: performing live is a **public
      performance** (licensed); saving it is a **reproduction** (licensed by no PRO, ever).
      Same gap as offline downloads. Twitch is the cautionary version — PRO deals, no
      reproduction rights, VODs on by default, then mass DMCA notices in 2020.

- [ ] **[OWNER]** ⚠️ **Pre-existing recordings still exist and sit outside every licence you
      hold.** `live_replay.sql` marks them (`replay_attested_at is null`) — the query is at the
      bottom of that file. Note `stream-sweep` deliberately **skips** live recordings, so it
      will not clean these up; review and delete them from the Cloudflare dashboard.
- [ ] **[CODE]** Product copy and ToS currently allow hosts to "play music" — **affirmatively
      disallow DJing commercial recordings.**

✅ **CORRECTION (2026-07-28): the "sold-stops-leases contract bug" does not exist.** It was
flagged from the feature's *description* rather than its implementation, and repeated here
twice before anyone read the code. Verified:

- `shop_multi.sql` declines orders `where status = 'requested'` — **pending requests only**.
  Delivered leases are untouched and keep their file access.
- Marketplace Terms §7 says exactly that: *"existing Leases survive… An exclusive Buyer takes
  the Work subject to those previously granted non-exclusive licenses."*

Code and Terms match, and match industry norm. The listing page even shows the sales count so
an exclusive buyer can see prior copies exist before committing. **Nothing to fix.**

✅ **Seller of record — already done.** Buyer-facing copy states *"Laybell is a venue — every
sale is a deal between buyer and seller, and payment is arranged between you outside the
app"*, translated across all languages.

✅ **Standardised licence templates — already done.** Marketplace Terms define fixed Lease
(non-exclusive, unlimited, no caps), Exclusive Purchase, and Free Claim types. Sellers pick a
type; they don't write free-text licence terms.

> **Lesson worth keeping:** three items sat on this list as outstanding work because a research
> pass inferred them from feature descriptions. Reading the code took minutes. Verify before
> building.
- [ ] **[OWNER]** ⚠️ **Maryland marketplace facilitator sales tax** — the shop makes you a
      facilitator of digital-product sales, requiring collection, remittance and **monthly
      Form 202F filing**. Register before the first sale. CPA question as much as legal.

### 5.6 Fingerprinting — not required, but target it

§512(m) is explicit: the safe harbour is **not** conditioned on monitoring. So this is risk
mitigation. Don't fingerprint the firehose; fingerprint the three surfaces where the financial
benefit prong bites and volume is small: **shop listings**, **tracks opted into "use this
sound"**, and **anything monetised**. ACRCloud has a free tier; Pex is ~$1/file/month; Audible
Magic runs $10–25k/month at mid-size. Do not build your own — SoundCloud spent €5M and staffs
seven people on theirs.

### 5.7 Take these four to a music attorney

1. **The shop commission and §512(c)(1)(B)** — does 15% per transaction plus Laybell's
   curation supply both prongs? **Does a flat fee materially change it?** Does §512(c) even
   reach the sale and file delivery, or only the listing (*Hendrickson v. eBay*)?
2. **MLC posture** — blanket licence vs reliance on voluntary licences under §115(d)(1)(C),
   and whether you must file a Notice of Nonblanket Activity regardless. Get it in writing;
   treble damages make guessing expensive.
3. **The "use this sound" sublicense** — does it hold against a co-writer the uploader
   couldn't bind? And **co-owned works generally**: can one of three co-writers validly
   licence the whole composition? Your ToS silently assumes yes, and that assumption carries
   your entire rights chain for typical rap/beat collaborations.
4. **Minors' contracts** — is a licence grant from a 15–17-year-old disaffirmable, and what
   does that do to derivative posts and completed shop sales? Real hole in a 13+ platform.

Also worth the hour: §204(a) writing requirement for click-through *exclusive* beat sales;
the exclusive-terminates-leases design; written PRO scope confirmation.

**Bring a written product spec, not a description** — every one of these turns on exact
mechanics.

### 5.8 Realistic cost floor

**~$3,500–$6,000/year pre-revenue** (BMI ~$350 + ASCAP + MLC $2,500 + CPA certification),
**jumping to $60,000+/year past 25,000 monthly unique recordings.**

---

## 6. Payments and money movement — **[LEGAL] RESEARCHED 2026-07-28**

Informational research, not legal or financial advice.

### 6.1 The one rule that carries most of your defence

**Stripe Connect, Express accounts, destination charges** with `application_fee_amount` for
your 8/15/35% cut. Funds live in Stripe balances under **Stripe Payments Company's money
transmitter licences in 54 US jurisdictions**. The creator "wallet" becomes a ledger entry
against a Stripe balance, not cash in a Laybell account.

> ⚠️ **NEVER sweep creator funds into a Laybell-controlled bank account and pay out from
> there.** That is textbook unlicensed money transmission — a federal crime under 18 U.S.C.
> §1960, plus state cease-and-desist orders. This single rule is most of the licensing
> defence.

Correcting a common assumption: Twitch and Etsy did **not** avoid licensing — they bought it
(Amazon Payments is licensed in all 50 states). The model to copy is the *small-platform*
model: let a licensed processor be the transmitter and never take possession of funds.

**Risk if you follow this:** genuinely low. Regulators pursue platforms holding customer funds
in their own accounts. **Risk if you build your own escrow or cashable stored value:** jumps
sharply.

### 6.2 Tips are the legally soft flow — not the marketplace

Both the federal payment-processor exemption (31 CFR 1010.100(ff)(5)(ii)(B)) and Maryland's
agent-of-payee exemption (COMAR 09.03.14.03) are written around **"goods or services."** A
viewer tip is arguably a gratuitous transfer, not payment for anything. **The beat marketplace
fits the exemption language cleanly; tips do not.**

- [ ] **[LEGAL]** Get an attorney memo on tips specifically **before shipping tipping**.
- [ ] **[CODE]** Maryland's exemption also requires the payee to **publicly identify** Laybell
      as collecting on its behalf, and that Laybell act for **only one party** — awkward if
      the ToS positions you as protecting buyers too. Needs specific checkout disclosure text.

### 6.3 ⚠️ Cross-cutting conflict: "Laybell Credits"

§2 recommends a **Credits consumable** to solve the shop's un-enumerable SKU problem. §6
warns that purchasable credits push you toward **stored value / prepaid access**, which is
closer to money transmission in most states. **These are both right, and the resolution is a
design constraint:**

> Credits must be **non-refundable, non-cashable, spend-only** — purchased via IAP, spendable
> inside Laybell, never redeemable for money. The *seller's* proceeds are what gets paid out,
> through Connect, in dollars. If a credit can ever become cash in the buyer's hands, it's
> stored value and the analysis changes completely.

Take this exact design to the attorney — it sits at the intersection of both opinions.

### 6.4 The economics will surprise you

Stripe: **2.9% + 30¢** per charge, **$2/month per active connected account**, standard payouts
**0.25% + 25¢**, disputes **$15 received + $15 countered**.

**A $100 beat sale at a 15% headline rate nets Laybell ~$11.80 — an effective ~11.8%.**

> **On a $5 tip at the 8% Premium rate, Laybell takes $0.40 while Stripe takes $0.45. You
> lose money on small tips.**

✅ **RESOLVED 2026-07-28 — owner chose a $6 minimum.** `DONATION_MIN_CENTS` is now **$6** and
the presets are **$6 / $10 / $25 / $50 / $100**. $6 is the smallest whole-dollar tip that is
profitable on *both* tiers:

| tip | Stripe | net @8% Premium | net @35% standard |
|---|---|---|---|
| $5 | $0.45 | **−$0.045** | $1.30 |
| **$6** | $0.47 | **+$0.006** | $1.63 |
| $10 | $0.59 | +$0.21 | $2.91 |
| $25 | $1.03 | +$0.98 | $7.72 |
| $50 | $1.75 | +$2.25 | $15.75 |

The margin on a floor-sized *Premium* tip is ~nil by design — the 8% rate **is** the "Earn
More" perk, so giving margin back to the creator there is the point. It turns healthy above
$10, where real tipping volume sits. The modal now explains the floor instead of silently
disabling the button (the jump from $1 to $6 makes under-minimum entries common).

- [ ] **[CODE]** ⚠️ The minimum is **client-side only**. The `donation_guard` trigger in
      `donations.sql` should grow a matching server-side minimum during payments Phase 2, so
      a crafted request can't mint a $1 tip.

### 6.5 Chargebacks — your worst structural exposure

Destination charges make Laybell **merchant of record**: a disputed amount is debited from
*your platform balance*, and you recover by reversing the seller's transfer — which only works
if the seller still has a balance. A fraud ring that uploads stolen beats, sells 200, and
cashes out before chargebacks land leaves **Laybell absorbing 100%**.

Note this is a **commercial** risk, not a licensing one — the money still never leaves Stripe's
custody. Those two questions get conflated constantly; decide them separately.

Build before launch, not after the first fraud ring:
- ✅ **[CODE] Immutable download log — BUILT 2026-07-28.** `shop_downloads.sql` +
      `logDeliverableDownload()`, logged *before* the file handoff so the evidence doesn't
      depend on the browser open succeeding. Append-only by design: buyers may insert only
      their own rows and only against a delivered order that is genuinely theirs, and there is
      no update or delete policy for anyone. Stripe's `access_activity_log` is *the* winning
      evidence field for digital-goods disputes. **Server timestamp, authenticated buyer id
      and order linkage carry the weight; the user-agent is self-reported and advisory.**
      IP capture must be added server-side when payments land — the client cannot self-report
      it credibly.
- [ ] **[CODE]** Timestamped **click-through no-refund acceptance** at checkout — a checkbox
      with the policy visible, not a link.
- [ ] **[CODE]** **7–14 day payout hold** after delivery. Non-negotiable for instant delivery.
- [ ] **[CODE]** Rolling **reserve on new sellers**; velocity caps on new-account sales.
- [ ] **[CODE]** Recognisable statement descriptor (`LAYBELL*` + seller) — "I don't recognise
      this charge" is the most common friendly-fraud trigger.
- [ ] **[OWNER]** Refund fast and generously. A $30 refund beats $30 + a $15 dispute fee +
      dispute-rate damage. Past ~0.75–1% dispute rate the networks put you in monitoring.

### 6.6 Tax — and a trap

**1099-K for TY2026 is settled: $20,000 AND 200 transactions**, both required (restored
retroactively by the One Big Beautiful Bill). The $600 threshold is dead federally.

> **The trap:** Stripe issues 1099-Ks only when the *connected account* pays Stripe's fees.
> Because Laybell controls pricing (8/15/35%), **Stripe will NOT file for you** — Laybell is
> expected to file **1099-NEC/1099-MISC at $600** (or $10 for royalties).

- [ ] **[CPA]** **The highest-value CPA question in this document:** is a beat sale a *sale of
      goods* (no 1099-NEC), or a *licence generating royalties* (1099-MISC box 2, $10
      threshold)? And are tips non-employee compensation or gifts? These change your filing
      burden materially, and the Stripe fee-payer setting is a config flag today and a
      migration later.
- ⚠️ **Maryland is a $600 1099-K state** (as are DC, MA, MT, VT, VA; Rhode Island is **$100**).
- [ ] **[OWNER]** Register for **Maryland sales & use tax as a marketplace facilitator** before
      the first on-platform sale — Maryland taxes digital products at **6%**, and listing +
      collecting + transmitting meets the statutory test exactly. (Note: Business Tax Tip #29
      was revised to exclude certain *business* purchases — a beat lease to a commercial-use
      buyer may fall in that exclusion. Real money, ask a SALT specialist.)
- [ ] Keep the **payout geo-gate US-only** until W-8BEN and Chapter 3 withholding are handled.

### 6.7 KYC / AML / OFAC

Stripe Express collects and verifies identity, beneficial owners, and government ID. But
Stripe says plainly: *"Don't rely on Stripe's verification to meet any independent legal KYC
requirements."* **OFAC compliance is non-delegable and has no small-business exemption.**

Minimum defensible program: no payout until Stripe reports `charges_enabled` and
`payouts_enabled`; log which requirements were satisfied and when; a written suspension policy
for suspected fraud/structuring/sanctions; a stated payout hold; enforced US-only payout gating.

### 6.8 Costs and sequencing

| Item | Cost |
|---|---|
| Fintech regulatory attorney memo on flow of funds | ~$3–8k — **the highest-value spend here** |
| Marketplace ToS + Seller Agreement (transfer-reversal + negative-balance rights) | ~$3–7k |
| Maryland sales & use tax registration | Free |
| Maryland SDAT annual report | ~$300, due April 15 |
| 1099 filing via Stripe | $2.99/form IRS + $1.49/form state |
| Stripe active connected accounts | $2/month each |
| **Total attorney + CPA before launch** | **~$10–20k** |

**Do last, and it'll be the easiest thing you build:** self-serve ad buying is a plain B2B
Stripe charge to Laybell's own account — no Connect, no money-transmission question, no 1099.

---

## 7. Privacy, minors, and business setup — **[LEGAL] partly done**

Already done per `docs/LEGAL_ROLLOUT.md` (~90%): domain, contact inboxes, DMCA agent
registered, mailing address, legal SQL run, and all documents built and wired — Privacy
Policy, Terms, Community Guidelines, Advertiser Terms, and Marketplace & Beat Licensing
Terms.

Remaining, from that document:
- [ ] **[OWNER]** Host the web copies of the legal documents (do at submission time)
- [ ] **[OWNER]** Fill out the store privacy disclosures
- [ ] **[LEGAL]** One-time attorney review — strongly recommended
- [ ] **[LEGAL]** EU/UK representative, only if you target EU/UK

**DECISION (2026-07-28): v1 launches US-only.** Set territory restrictions in App Store
Connect and Play Console at submission. Removes GDPR, UK-GDPR, the Art. 27 representative and
DSA obligations from v1 scope entirely.

### 7.1 🚨 NCMEC / CSAM reporting — a genuine launch blocker (free, ~1 day)

Highest-consequence item in this document: quasi-criminal, **no size threshold whatsoever**,
and it attaches the moment you host user media with minors present. Section 230 gives you
**nothing** here — §230(e)(1) expressly preserves Title 18 Chapter 110 enforcement.

18 U.S.C. §2258A requires reporting apparent child sexual exploitation to NCMEC's CyberTipline
"as soon as reasonably possible," and registering contact details. Penalty for knowing failure:
**$600,000** first violation, **$850,000** after.

**The relief you may not know about:** §2258A(f) is explicit — **no duty to monitor, and no
duty to affirmatively search, screen or scan.** You do not need PhotoDNA or a scanning
pipeline. You must report what you actually learn about.

📄 **Full procedure written up: `docs/CSAM_RESPONSE_RUNBOOK.md`.**

- ✅ **[OWNER] REGISTERED as an NCMEC ESP, 2026-07-28.** Declared data scope: reported media +
      URL, the server snapshot that survives deletion, uploader username/email/display
      name/self-declared DOB, timestamps, surrounding caption-comment-DM context, city-level
      location. Explicitly declared **no IP addresses collected** — see §7.1a.
- ✅ **[CODE]** Report buttons exist on every UGC surface including DMs, group chats and live
      (verified §4.3).
- ✅ **[CODE]** **Preservation is already wired** — `legal_hold` (`moderation_preservation.sql`)
      blocks user deletion via RLS, `delete-account` **bans instead of deleting** when a hold
      is set (`index.ts:45-48`), and the 3-month cleanup sweep skips held accounts
      (`account_deletion_sweep.sql:53-55`). This is the hard part of the retention duty and
      it's done.
- [ ] **[OWNER]** Commit to checking the moderation queue **daily**. A queue nobody reads
      turns a bounded, reactive obligation into a knowing failure — which is the version with
      the $600k penalty.
- ✅ Legal docs already cover this: Community Guidelines and Terms prohibit CSAM and name
      NCMEC; the Privacy Policy discloses reporting to NCMEC and law enforcement (verified
      2026-07-28). Reporting user data without that disclosure would have been its own problem.

### 7.1a ⚠️ No IP addresses are logged anywhere

Discovered while completing the NCMEC form: the app records **no IP addresses at all** — not
on upload, not on post, not on messages — and `auth.audit_log_entries` is empty, so there are
no sign-in IPs either. This was declared honestly on the registration.

It costs Laybell twice over, which is why it's worth fixing rather than living with:
- It is the field investigators most want after the media itself.
- It is the field that **wins card chargebacks** (Stripe's `access_activity_log`, §6.5) — and
  that starts mattering the moment real money moves through the ledger.

✅ **BUILT 2026-07-28.** `supabase/sql/access_log.sql` + `supabase/functions/log-access/` +
`lib/accessLog.ts`, wired into the three events that matter: **media upload**, **report
submission** (post and user), and **shop download**.

The client never sends an address — it only names the event. The IP is read from the request
by the Edge Function, because a self-reported address is worth nothing in a dispute and worse
than nothing in an investigation. The table records **which header** the address came from
(`cf-connecting-ip` can't be forged; `x-forwarded-for` can), so the evidence is
self-describing rather than falsely uniform. Append-only, no client writes, users can read
their own rows (state privacy access rights).

Retention is **13 months** — past the card-dispute window and past the 1-year CSAM
preservation duty, without holding personal data indefinitely. Prune query is in the file.
Deliberately a closed list of five events: this is a security log, not analytics.

- ✅ **[OWNER]** Privacy Policy updated — new §3.15 discloses the collection, limits it to
      three named purposes, states the 13-month retention, and explicitly rules out
      advertising/tracking/profiling use. Legal HTML pages rebuilt.
- [ ] **[OWNER]** Run `access_log.sql` — now bundled into
      `supabase/sql/_RUN_PENDING_2026-07-29.sql` (§0.2 item 0) — then
      `supabase functions deploy log-access` (keep the default `verify_jwt`).
- [ ] **[OWNER]** Diary a monthly retention prune.
- Optional and cheap: Cloudflare's CSAM Scanning Tool is free. Not required, but it converts a
  catastrophic risk into a managed one.

### 7.2 🚨 Mississippi HB 1126 — the one state law with no size threshold

**This changes your launch plan.** Most kids-safety laws have $25M/50,000-user thresholds you
are far below. Mississippi's has **none**, and it is **currently enforceable** (Fifth Circuit
stayed the injunction July 2025; SCOTUS declined emergency intervention August 2025).

Its definition — a service that connects users socially, lets them create a sign-in profile,
and lets them post content shared with others — describes Laybell exactly.

Requirements: "commercially reasonable" age verification (the statute accepts **email
verification** among other methods), a written strategy to protect minors from harmful
material, data minimisation, and **a prohibition on collecting geolocation from minors**.

✅ **The geolocation half is done (2026-07-28)** — `lib/location.ts` now refuses capture for
anyone not a known adult, and *clears* stored coordinates for a minor whose location was left
on by an earlier build.

Two options for the rest, both legitimate:
- [ ] **[CODE]** Comply: documented age assurance at signup (DOB + email verification +
      app-store age signal is defensible).
- [x] **DONE — Mississippi is geo-blocked.** `supabase/sql/geo_block.sql` + `lib/geoBlock.ts`.
      One state, ~1% of the US population, removes the sharpest-edged obligation you face.
      Many small platforms did exactly this, and it is built to be lifted in one UPDATE.

      (An earlier version of this line said "the way you're geo-blocking the EU." **There was
      never an EU geo-block in this codebase** — that was wrong, and Mississippi is the first
      region block Laybell has ever had. Don't go looking for an existing helper to extend.)

### 7.3 App Store Accountability Acts — Texas and Louisiana are live

These bind you **as a developer**, independent of your size, because you ship through Apple
and Google. Texas SB 2420 is in effect; **Louisiana's took effect 1 July 2026 and notably
rejects the developer safe harbor** that Texas and Utah grant; Utah's deadline is May 2027.

- [ ] **[CODE]** Adopt **Apple's Declared Age Range API** and **Google Play's age-signal API**.
      Consume and act on the age-bracket and parental-consent signals.
- [ ] **[CODE]** Notify the app store of "significant changes" to terms, privacy policy or
      monetisation features — and **re-obtain parental consent** after such a change.
- [ ] **[CODE]** Use age/consent data only for compliance, transmit encrypted, delete after use.

**Wiring these APIs is also your best liability shield.** California's AB 1043 (Jan 2027) makes
the OS-provided age signal *authoritative* absent clear contrary evidence — converting "you
should have known they were 12" into "the OS told me they were 13–17." The trap: once you
*receive* a signal saying under 13 and keep collecting, you have **actual knowledge** and are
squarely in COPPA.

### 7.4 Minor-account defaults — cheap now, expensive to retrofit

There is no federal statute covering 13–17; the FTC's lever is Section 5 unfairness, and its
2024 staff report criticised platforms for treating teens exactly like adults. These are config
flags in systems you already own:

**ALL FOUR BUILT 2026-07-28**, on a shared foundation in `lib/minors.ts`. The key design
decision there is an asymmetry worth preserving: `isMinor()` means *affirmatively known to be
under 18* and applies restrictions; `isAdult()` means *affirmatively known to be 18+* and
grants privileges. **An unknown age satisfies neither — so privileges require positive proof.**
Getting that backwards is how platforms end up serving targeted ads to 14-year-olds whose age
they "didn't have."

- ✅ **Location off for under-18s** — `lib/location.ts`, applied globally rather than
  geo-fenced, and it clears coordinates left over from an earlier build.
- ✅ **No targeted advertising to minors** — `lib/ads.ts`. Reuses the existing personalization
  flag, so minors fall through to the untargeted path that already existed: contextual ads
  still serve, so this costs inventory rather than revenue outright.
- ✅ **Minor accounts default to friends-only posting** — `app/(tabs)/post.tsx`. A default,
  not a restriction: a teen can still choose public, but the safe option is the one they opt
  out of.
- ✅ **DMs to minors are followers-only** — and this one is **server-enforced**
  (`minor_safety.sql`), because a client-side check is a UX affordance, not a control. A
  restrictive RLS policy ANDs with the existing permissive ones rather than replacing them.
  An adult stranger can't open a DM with a minor; the minor must have followed them first.
  Group chats (`receiver_id is null`) are explicitly guarded — without that the null would
  make the whole check null and Postgres would fail the policy, breaking group chat entirely.
- ✅ **Live broadcasting gated to 18+** — `app/live/go-live.tsx`. Watching is unaffected.
- [ ] **[CODE]** Prep for NY's SAFE for Kids Act (rules pending): ability to serve minors a
      **chronological follows-only feed** and to **suppress notifications overnight**
      (midnight–6am). Build as flags now; it targets exactly your reels pager, recommendation
      engine and notification scheduler.

### 7.5 COPPA — two documents are already overdue as a matter of form

The amended Rule's **full compliance deadline was 22 April 2026** — already passed. It doesn't
bind you unless you're "directed to children" or have actual knowledge of an under-13, but the
paperwork is a weekend of writing and its absence looks bad:

- [ ] **[OWNER]** **Written data retention policy**, published in your privacy notice
      (16 CFR §312.10 — no indefinite retention, must state purposes and deletion timeframe).
- [ ] **[OWNER]** **Written children's information security program.** 2–3 pages is fine.
- [ ] **[CODE]** Neutral age gate at signup with **no back-button re-entry** in the same
      session. On learning a user is under 13 → immediate disable + data deletion, logged.
- [ ] **[CODE]** **Do not ingest phone contacts from under-18 users** — the least defensible
      data you hold and a perennial FTC sore spot.
- ✅ Helpful: the FTC's **February 2026 enforcement policy statement** says it won't pursue
  operators who collect data *solely* to determine age, if they don't use it otherwise, delete
  it promptly, and vet any recipients. Match those three conditions in your age-check path.

### 7.6 Location precision — audit this, it may be good news

**One correction to an earlier assumption in this doc: it is *precise* geolocation that is
sensitive data, not coarse.** Maryland and most states define precise as within a
**1,750-foot radius**, and MODPA expressly permits ads based on *less* precise data such as
ZIP-code targeting.

✅ **AUDITED 2026-07-28 — good news.** `lib/location.ts` rounds every coordinate to one
decimal place (**~11 km**) before it is stored, and matching runs at that same resolution.
That is orders of magnitude coarser than the 1,750-foot threshold, so **what Laybell stores is
not precise geolocation and not sensitive data** under these laws. No consent regime attaches.

A comment now marks the rounding as load-bearing for legal reasons, not just privacy taste —
**do not increase that precision** without revisiting this section.

### 7.7 State privacy laws — you're under every threshold, with two exceptions

20 states have comprehensive laws in effect. Nearly all gate at ~100,000 state residents
(Rhode Island 35,000; California needs $25M revenue). **You are under all of them.** Two reach
you anyway:

- **Texas and Nebraska** drop the count threshold and exempt SBA-defined small businesses —
  **but even an exempt small business may not sell sensitive data without consent.**
- **Maryland (MODPA)**, your home state, applies from April 2026 at 35,000 Maryland consumers.
  Reachable. Two features worth designing to now, since they're becoming the template: MODPA
  **bans the sale of sensitive data outright** (no consent exception), and prohibits targeted
  advertising where the controller **"knew or should have known"** the user is under 18 — a
  broader standard than "actual knowledge."

Do regardless of size, all cheap: honour access/deletion/correction requests from anyone, keep
a working privacy contact, never sell sensitive data, no targeted ads to minors, honour Global
Privacy Control on any web surface.

### 7.8 Section 230 — what survives it

§230(c)(1) means you aren't liable for what users post, and (c)(2) means moderating doesn't
forfeit that. What survives: **federal criminal law** (your CSAM obligations sit entirely
outside §230), **intellectual property** (§230 gives you *nothing* on copyright — the §512 safe
harbour in §5.3 is what protects you, and a music app is a copyright-notice magnet), **ECPA**
(don't scan DMs outside your stated policy), **FOSTA-SESTA**, and product-liability/
negligent-design theories — the live frontier in teen-harm litigation.

### 7.9 Maryland business housekeeping

- [ ] **[OWNER]** ⚠️ **Annual Report + Personal Property Return (Form 1) to SDAT, due April 15,
      $300 for LLCs.** Missing it forfeits good standing — **which means losing the liability
      shield.** Calendar it now.
- [ ] **[OWNER]** Registered agent — you can self-serve with a Maryland street address, but
      your home address becomes public record. A commercial agent is ~$50–150/yr and worth it
      for a founder with a public consumer app.
- [ ] **[OWNER]** EIN — free from the IRS. Never pay a third party.
- ✅ **Trader's licence: almost certainly NOT required** — it covers tangible goods with
  inventory value. You sell digital products. (Free phone call to your Circuit Court clerk to
  confirm.) You **do** need the sales-and-use tax account from §6.6.
- ✅ **Foreign qualification is NOT triggered by having users in other states.** Triggers are
  an office, in-state employees, leased space or inventory. Note: no foreign qualification ≠
  no tax nexus — economic nexus for sales tax is a separate, lower bar.
- ⚠️ **Maryland's new 3% tech-services tax** (from July 2025) may reach subscription/ad
  revenue depending on NAICS classification. **[CPA]** — genuinely underrated, nobody warns
  founders, and unpaid sales tax follows you personally through an LLC in many states.

### 7.10 Trademark — ✅ owner reports search + registration already done

Owner confirmed (2026-07-28) the clearance search was run and the mark registered before the
LLC was formed. Worth a one-time sanity check that it was a **USPTO trademark filing** and not
only a business-name registration — those are different things, and a state LLC name grants no
trademark rights. Keep the serial/registration number with the NCMEC and DMCA records.

Original guidance retained below for reference.

- [ ] **[OWNER]** Free clearance search first: USPTO for "Laybell" + phonetic variants
      (Laibell, Laybel, Labell, Lay Bell), then **music-industry common-law uses** — Spotify,
      Apple Music, Bandcamp, SoundCloud, BMI/ASCAP repertory. **A band named Laybell is a real
      conflict risk for a music app.**
- [ ] **[LEGAL]** Then ~$500–1,500 for a clearance opinion. Worth it — a post-launch rebrand
      costs your entire brand equity.
- [ ] **[OWNER]** File **Section 1(b) intent-to-use now** to lock the priority date. **$350
      per class.** Minimum: **Class 9 (app) + Class 41 (streaming/entertainment) = $700.**
      Better: add **Class 45 (social networking) = $1,050**. Use pre-approved ID Manual
      descriptions to avoid every surcharge. Timeline 12–18 months.

### 7.11 Insurance — one detail matters more than the price

- [ ] **[OWNER]** Buy a bundled **Tech E&O + Cyber policy with a media-liability endorsement
      that explicitly covers third-party/user-generated content.** ⚠️ **Confirm in writing
      that UGC is not excluded** — many tech E&O forms carve it out, which defeats the entire
      purpose for a platform like yours. Realistic pre-revenue: ~$1,500–5,000/yr.

### 7.12 Accessibility — do the cheap 80%

DOJ's WCAG 2.1 AA rule binds only state/local government. Private apps are sued under Title III
directly. 3,117 federal web-accessibility suits in 2025 (+27% YoY) — but serial plaintiffs
target retail, restaurants and healthcare with revenue to extract. **Practical year-one risk
for a pre-revenue app is low.** Still, a few days of work:

**STARTED 2026-07-28 — partial, and honestly so.**

Measured before touching anything: **819 interactive elements, 19 labels. Reduce Motion:
zero coverage.** Run `node scripts/a11y-audit.mjs` any time — it counts icon-only buttons that
announce nothing to a screen reader, and the number should only ever fall.

- ✅ **Reduce Motion foundation** — `lib/a11y.ts` (`useReduceMotion`, `motionDuration`, one
  shared OS subscription rather than a listener per component). Wired into the double-tap
  heart burst, the most aggressive animation in the app. Note the design: Reduce Motion keeps
  the *confirmation* and drops the *motion* — the heart still appears and fades, it just
  doesn't leap. Removing it entirely would delete the only feedback that the like registered.
- ✅ **All media controls labelled** — `NowPlaying` (play/pause with live state, next,
  previous, minimise, options), `MiniPlayer` (all three layouts: ad, compact, full — play/pause,
  stop, skip-ad, open-player), `CastBar` (cast controls, stop casting, transport, retry). Plus
  `accessibilityState` carrying the disabled state that colour alone was conveying. These are
  the controls a blind user depends on most, so they went first.
  **Labels app-wide: 19 → 44.**
- [ ] **~223 icon-only buttons still unlabelled.** Biggest clusters: `story-camera` (12),
      `post` (10), `messages/[id]` (7), `TVRemote` (7). A real, incremental grind — best done a
      file at a time rather than in one sweep, and not something to claim done.
      ⚠️ Treat the audit count as **approximate**: its regex double-counts nested touchables,
      so it over-reports slightly. Use it as a trend, not a total.
- [ ] Wire Reduce Motion into the remaining animation surfaces (pager, tab bar, sheets).
- ✅ Dynamic Type is **not blocked** — zero `allowFontScaling={false}` in the codebase, so text
      already scales. What's untested is whether layouts survive it, which needs a device.
- [ ] Contrast check, ≥44×44pt touch targets, and one signup→post→DM pass under VoiceOver and
      TalkBack.
- [ ] **[OWNER]** Publish an accessibility statement with a contact email — a responsive
      address defuses most demand letters before they become filings.

### 7.13 Take these to an attorney

Budget **$3,000–8,000** for a focused privacy/tech engagement plus **$1,500–3,000** for
trademark. Highest-ROI legal spend available to you.

1. **Does Mississippi HB 1126 cover us, and is our age assurance "commercially reasonable"?
   Is geo-blocking Mississippi a rational trade?** — the question that changes your launch plan.
2. **Does Florida HB 3 capture us today?** Its gate needs ≥10% of DAU under 16 averaging 2+
   hrs/day plus algorithmic/addictive features. A new app almost certainly fails that test —
   but a successful teen-heavy music app could meet it. **Ask what monitoring tells you when
   you cross it.** (Largely enforceable since the 11th Circuit lifted the injunction.)
3. **Are we "directed to children" or "mixed audience" under amended COPPA?** Bring
   screenshots — subject matter, visual style and music/celebrity presence are the FTC's
   stated factors. Wrong answer here is the most expensive mistake available.
4. **Is our coarse location "precise" under the 1,750-foot test?** Bring the code path.
5. **Should minors livestream at all in v1?** Ask specifically about FOSTA-SESTA and
   negligent-design theories that survive §230.
6. **Can minors receive payouts at all?** Ties directly into §6.
7. **Does the LLC need to convert?** Delaware C-corp if you plan to raise; and does a
   single-member LLC adequately shield personal assets for a consumer UGC app?
8. Review the Advertiser and Marketplace Terms you drafted — indemnities, and **whether the
   arbitration clause is enforceable against minors**.

### 7.14 Status of everything else (tracked, not actionable yet)

- **Maryland Kids Code is LIVE law** (not enjoined — motion to dismiss denied Nov 2025) but
  gated at $25M revenue / 50,000 Maryland residents. Not yet. Its 90-day cure safe harbour is
  **conditioned on having completed a DPIA**, which argues for writing a lightweight one early.
- **Nebraska AAOSC** ($25M + 50,000), **California AADC** (partially enjoined; the Ninth
  Circuit upheld *age estimation* in March 2026 while striking vague data-use duties) — not yet.
- **Vermont AADC (Jan 2027)** uses a *usage* test, not a size test: ≥2% of users aged 2–17.
  **That will probably reach you.**
- **Ohio's parental-consent law was REVIVED** by the Sixth Circuit in June 2026 — trackers
  listing it as enjoined are stale. Utah, Texas HB 18, Arkansas, Georgia, Louisiana, Virginia
  and Nebraska's LB 383 remain wholly or partly enjoined.
- **Direction of travel: age-estimation mandates are surviving First Amendment challenge;
  vague content duties are not. Plan for age assurance becoming general, not exceptional.**

---

## 8. Suggested order of operations

1. ~~Decide §2 (money posture).~~ **Done — wire everything properly, US-only v1.**
2. ~~Land the architecture-independent money fixes.~~ **Done — Phase 0 (§1.2–§1.5).**
3. ~~Resolve the IAP-vs-processor question.~~ **Done — five of six surfaces need IAP (§2).**
4. **This week, and they're nearly free:** register with NCMEC (§7.1), diary the DMCA agent
   3-year renewal (§5.3) and the SDAT April 15 filing (§7.9), and run the trademark clearance
   search (§7.10). Hours of work, catastrophic if skipped.
5. **Start the long-lead items now:** apply to BMI and ASCAP — **90 days before launch**
   (§5.1) — and book the attorney (§5.7, §6.8, §7.13) and CPA (§6.6) engagements.
6. **Decide Mississippi** (§7.2) — comply or geo-block. It changes your launch plan.
7. Land the minor-account defaults (§7.4) and the age-signal APIs (§7.3) — config flags in
   systems you already own, far cheaper now than retrofitted.
8. Run the §3.1 SQL list; set the §3.2 secrets; deploy functions.
9. Sort hosting + the App Store ID (§4.2) — unblocks share links and deep links.
10. Build the payments Phase 2 (§2) — ledger first, then funding sources.
11. Native production build; device-test the Stream sweep (§1.1) and video posting end to end.
12. Store metadata, privacy disclosures, age ratings; submit **US-only**.
