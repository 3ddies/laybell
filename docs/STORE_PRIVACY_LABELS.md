# Store Privacy Labels — App Store "Nutrition Label" + Google Play Data Safety

**Generated:** 2026-07-28 · **Basis:** static source audit of this repo at branch `polish/scale-hardening-2026-07-23`.
**Revised 2026-08-10:** the Diagnostics rows were WRONG. This file was written two days before
`@sentry/react-native` was added (2026-07-30) and still said "no crash SDK" everywhere — which would have
produced a nutrition label declaring no diagnostics on an app that ships crash reporting, contradicting the
app's own Privacy Policy §3.16. Crash Data and Other Diagnostic Data are now **Yes / not linked / not
tracking / App Functionality**; Performance stays **No** (`tracesSampleRate: 0`).
⚠️ **This is the failure mode to watch for in this file: it is a snapshot.** Re-verify against
`package.json` and `lib/monitoring.ts` before transcribing anything into either console.

This document is evidence-first. Every "Yes" below is backed by a `file:line` citation. Anything the code
could not answer is in the **⚠️ UNCERTAIN** section rather than guessed at. Do not transcribe an answer into
App Store Connect or Play Console that this file marks uncertain without checking it yourself.

> There is an older, hand-written cheat-sheet at `docs/STORE_PRIVACY_DISCLOSURES.md`. It is **broadly correct
> but not precise enough for a legal filing**, and it omits several categories (Financial Info / creator
> earnings, IP-address logging, third-party recipients such as Giphy and Cloudflare). Discrepancies are listed
> at the bottom. Prefer **this** file.

---

## Headline answers

| Question | Answer | Why |
|---|---|---|
| **Does the app need an ATT prompt?** | **No** | Zero occurrences of ATT / IDFA / `expo-tracking-transparency` / `requestTrackingPermission` / `advertisingIdentifier` anywhere in the repo. No such package in `package.json`. |
| **Apple "Used for Tracking"?** | **No — for every category** | Ad targeting is 100 % first-party (`lib/ads.ts:315-352`). No ad network SDK, no data broker, no cross-app identifier. |
| **Precise or Coarse Location?** | **Coarse only** | Coordinates rounded to 1 decimal degree ≈ **11 km** before anything is stored or transmitted (`lib/location.ts:21`, `:53-54`). Apple's precise threshold is 1,750 ft. |
| **Payment Info collected by developer?** | **No** | No card/bank field exists in the app. IAP via RevenueCat→Apple/Google; payouts via Stripe-hosted onboarding in the system browser. |
| **Third-party analytics / crash SDK?** | **Crash reporting only — Sentry** ⚠️ *corrected 2026-08-10* | `@sentry/react-native` was added on 2026-07-30, AFTER this document was first written, and ships with a live DSN on the preview and production build profiles (`eas.json`). Everything below was rewritten to match. There is still no analytics SDK: no Firebase, Amplitude, PostHog, Segment, Bugsnag, Mixpanel or Datadog. |
| **Health data?** | **None** | No HealthKit, `expo-sensors`, pedometer, or heart-rate code or dependency. |
| **Encrypted in transit?** | **Yes** | All backend traffic is HTTPS (`lib/supabase.ts:6`); ad CTA URLs are force-upgraded to `https` (`lib/ads.ts:481-484`). |
| **Can users request deletion in-app?** | **Yes** | `lib/accountDeletion.ts` (48-h deferred hard delete) + `supabase/functions/delete-account/index.ts`. |

---

## 1. Apple App Privacy — summary table

Legend: **Linked** = associated with the user's identity. **Tracking** = used to track across other companies'
apps/websites (Apple's definition). Purposes: `AF` App Functionality · `AN` Analytics · `PP` Product
Personalization · `DA` Developer's Advertising · `TPA` Third-Party Advertising.

| Apple category | Collected? | Linked? | Tracking? | Purposes | Evidence |
|---|---|---|---|---|---|
| **Contact Info — Name** | Yes | Yes | No | AF | `app/onboarding.tsx:123`; `lib/dataExport.ts:29` (`profiles.display_name`) |
| **Contact Info — Email** | Yes | Yes | No | AF | Supabase Auth signup; `lib/dataExport.ts:14`; hashed copy `lib/identifiers.ts:34,44` |
| **Contact Info — Phone** | Yes (hash only) | Yes | No | AF | `lib/identifiers.ts:38-44` + `supabase/sql/contacts_discovery.sql:22-27`. Plaintext stays on device: `lib/identifiers.ts:11-22` |
| **Contact Info — Physical Address** | **No** | — | — | — | No address field anywhere |
| **Contact Info — Other** (parent/guardian email for 13-17) | Yes | Yes | No | AF | `supabase/functions/parent-consent/index.ts:17,27-29` |
| **Health & Fitness** | **No** | — | — | — | Verified absent |
| **Financial Info — Payment Info** | **No** | — | — | — | See §3 |
| **Financial Info — Credit Info** | **No** | — | — | — | No credit check anywhere |
| **Financial Info — Other** (creator earnings balance / ledger) | Yes | Yes | No | AF | `lib/ledger.ts:41-58`; `lib/wallet.ts:62-99`; `supabase/functions/revenuecat-webhook/index.ts:84-93` |
| **Location — Precise** | **No** | — | — | — | Never stored or transmitted; see §4 |
| **Location — Coarse** | Yes (optional, adults only) | Yes | No | AF, PP | `lib/location.ts:21,53-54,62-64` |
| **Sensitive Info** | ⚠️ Judgment call — see §5 | Yes | No | AF | Gender `app/onboarding.tsx:123`; DOB `app/onboarding.tsx:124` |
| **Contacts** | Yes — **salted hashes only, not retained** | No (hashes are not stored) | No | AF | `lib/contacts.ts:37-56`; `lib/hash.ts:15-21`; `lib/suggestions.ts:114-125`; `supabase/sql/contacts_discovery.sql:49-64` |
| **User Content — Photos or Videos** | Yes | Yes | No | AF | Composer `app/(tabs)/post.tsx`; `lib/upload.ts`; `lib/streamUpload.ts`; stories, slideshows, attachments (`lib/attachments.ts`) |
| **User Content — Audio Data** | Yes | Yes | No | AF | Audio posts (`app/(tabs)/post.tsx`); livestream/studio audio (`lib/live.ts`, `lib/studio.ts`, `lib/whip.ts`) |
| **User Content — Emails or Text Messages** | Yes | Yes | No | AF | DMs `app/messages/[id].tsx`; group chats `lib/groups.ts`; comments `lib/commentActions.ts` |
| **User Content — Gameplay Content** | **No** | — | — | — | Not a game |
| **User Content — Customer Support** | Yes | Yes | No | AF | In-app reports: `lib/ads.ts:1005-1018`; `lib/linkSafety.ts:330`; `supabase/sql/link_safety.sql:37` |
| **User Content — Other** (captions, bios, playlists, shop listings) | Yes | Yes | No | AF | `lib/dataExport.ts:29-35` |
| **Browsing History** | **No** | — | — | — | See §7 caveat on Safe Browsing |
| **Search History** | **No** | — | — | — | Queries are transient filters, never persisted — see §7 |
| **Identifiers — User ID** | Yes | Yes | No | AF, AN, PP | Supabase `auth.uid()` used throughout |
| **Identifiers — Device ID** | Yes (app-generated, resettable) | Yes | No | AF (fraud prevention) | `lib/deviceId.ts:10-31`; sent at `lib/viewTracker.ts:60`. **Not** IDFA/IDFV. Push token: `hooks/useNotifications.ts:62-71` |
| **Purchases** | Yes | Yes | No | AF | `lib/purchases.ts:43-61,108-169`; `supabase/functions/revenuecat-webhook/index.ts:58-115` |
| **Usage Data — Product Interaction** | Yes | Yes | No | AF, AN, PP | Views `lib/viewTracker.ts:59-89`; listen seconds `lib/listenMeter.ts:26-34`; likes/comments/saves aggregated in `lib/analytics.ts:98-184` |
| **Usage Data — Advertising Data** | Yes | Yes | **No** | DA | Ad impressions/clicks/skips/completes with `viewer_id`: `lib/ads.ts:696-747`, read back at `lib/ads.ts:1038-1062` |
| **Usage Data — Other** | **No** | — | — | — | — |
| **Diagnostics — Crash Data** | **Yes** | **No** | No | AF | Sentry. `lib/monitoring.ts` — `sendDefaultPii: false` (no IP, no request bodies), no `setUser`, and a scrubber strips JWTs, emails, auth headers and Supabase query strings from every event and breadcrumb. Nothing ties a report to an account, hence NOT linked. |
| **Diagnostics — Performance Data** | **No** | — | — | — | `tracesSampleRate: 0` (`lib/monitoring.ts`) — performance monitoring is off. |
| **Diagnostics — Other** | **Yes** | **No** | No | AF | Handled (non-fatal) errors and breadcrumbs reported through the same Sentry pipeline and the same scrubber. Session Replay is deliberately NOT enabled — it records the screen, unacceptable on an app with DMs and minors. |
| **Other Data — IP address** | Yes (5 events only) | Yes | No | AF (security/legal evidence) | `supabase/functions/log-access/index.ts:41,63-76,89-103`; `lib/accessLog.ts:14-21` |
| **Other Data — Date of birth / age** | Yes | Yes | No | AF (age gate) | `app/onboarding.tsx:109-124`; `lib/minors.ts:26-46` |
| **Other Data — Gender** | Yes | Yes | No | AF, PP | `app/onboarding.tsx:123`; `lib/profileOptions.ts:10` |

---

## 2. Advertising & tracking — the consequential answer

**Verdict: no ATT prompt is required, and "Used for Tracking" is `No` for every category.**

Searched the entire repo (case-insensitive) for `tracking-transparency`, `requestTrackingPermission`,
`AppTrackingTransparency`, `getAdvertisingId`, `IDFA`, `advertisingIdentifier`, `NSUserTrackingUsageDescription`
— **zero matches**. No such package appears in `package.json:5-67`, and `app.json` declares no
`NSUserTrackingUsageDescription`.

Ads are Laybell's **own inventory**, served from Laybell's own database and rendered by Laybell's own
components. Nothing is fetched from, or reported to, an ad network.

**What the targeting actually uses** (`lib/ads.ts:315-352`):
- `profiles.age` (line 328-333)
- `profiles.gender` (line 335-337)
- On-device genre affinity built from the user's own likes/saves (line 339-343, `lib/feedScorer.ts:37-59`) — cached in AsyncStorage, never uploaded
- Coarse `profiles.latitude/longitude` + haversine radius (line 345-349) — the ~11 km values from §4

**Guardrails already in code, worth stating on the label:**
- Personalization is **opt-in and default OFF** (`lib/adPrefs.ts:14-23`). When off, only campaigns with *no*
  targeting at all are eligible (`lib/ads.ts:323`).
- Known minors **never** receive targeted ads regardless of their own setting, and an *unknown* age is treated
  as a minor for this purpose (`lib/ads.ts:522` → `lib/minors.ts:43-46,76-78`).

**Ad payments are simulated**, not real: `provider: 'simulated'` at `lib/ads.ts:909-915`.

---

## 3. Payments — the app never touches card or bank data

**Declare "Financial Info → Payment Info" as NOT collected.**

| Money path | Who handles the instrument | Evidence |
|---|---|---|
| Premium subscription | Apple IAP / Google Play Billing, brokered by RevenueCat | `lib/purchases.ts:43-61,81-92` |
| Credit packs (consumable) | Apple IAP / Google Play Billing; balance granted **server-side only** by webhook | `lib/purchases.ts:104-169`; `supabase/functions/revenuecat-webhook/index.ts:58-115` |
| Creator payouts | **Stripe Connect Express hosted onboarding**, opened in the system browser — never a WebView | `lib/payouts.ts:48-70`; `supabase/functions/stripe-connect/index.ts:101-129` |
| Shop / marketplace | **Off-platform.** The app explicitly tells buyers "Laybell doesn't process payments — you arrange payment with the seller in chat" | `lib/i18n.ts:2205`; `lib/wallet.ts:35-39` |
| Livestream tips | Client-side DB insert with **no processor behind it** — nothing is charged today | `lib/donations.ts:182-188`; `lib/wallet.ts:44-45` |
| Ad campaigns | Simulated | `lib/ads.ts:909-915` |

The only payout-related string the app itself stores is a **user-typed display label**, and any run of ≥5
digits is redacted to its last 4 *before* it is written and *again* on every read
(`lib/wallet.ts:119-147`). Nothing resembling an account or routing number is persisted.

Laybell never holds creator funds — this is a deliberate money-transmission boundary documented at
`supabase/functions/stripe-connect/index.ts:7-17`.

**Do declare "Purchases"** (subscription/entitlement status and credit purchase history) — that is real and
linked to the user id (`supabase/functions/revenuecat-webhook/index.ts:58-62,84-93`).

**Consider declaring "Financial Info → Other"** for the creator **earnings balance**, which is income-like
data held per user (`lib/ledger.ts:41-58`). Flagged in §⚠️ as a judgment call.

---

## 4. Location — Coarse, confirmed

**The exact rounding is `Math.round(n * 10) / 10` — one decimal degree.**

```
lib/location.ts:21    const coarse = (n: number) => Math.round(n * 10) / 10;
```

One decimal degree of latitude ≈ **11.1 km** (≈ 36,400 ft). Apple's "Precise Location" threshold is data that
locates a user **within 1,750 ft**. 11 km is ~20× coarser, so **declare Coarse Location, not Precise.**

Flow (`lib/location.ts:46-71`):
1. `getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })` — line 52. A precise-ish fix is obtained
   **in memory on the device**.
2. Both coordinates are immediately coarsened — lines 53-54.
3. Reverse geocoding is performed on the **already-coarsened** coordinates (line 58), so the precise fix is
   never sent to Apple's/Google's geocoder either.
4. Only `{latitude, longitude, city, location_enabled}` — all coarse — are written to `profiles` (lines 62-64).

Additional facts for the label:
- **Optional.** Feature is off unless the user enables it; `disableLocation()` clears the stored values (lines 74-81).
- **Adults only.** Minors are excluded entirely, and an *unknown* age does not unlock capture
  (`lib/location.ts:28-30,48`, `:91`). Rationale in the file's own comment (lines 23-27).
- **Android cannot get fine location at all** — the manifest requests only
  `android.permission.ACCESS_COARSE_LOCATION` (`app.json:40`). `ACCESS_FINE_LOCATION` is absent.
- Refresh is capped at once per 24 h (`lib/location.ts:13,93`).

Uses: "people near you" suggestions (`lib/suggestions.ts:103-110`) and optional advertiser radius targeting
(`lib/ads.ts:345-349`).

⚠️ See §⚠️ for an iOS-side hardening suggestion (`NSLocationDefaultAccuracyReduced`).

---

## 5. Contacts — hashed, transmitted, **not retained**

This is the most nuanced answer in the document. Read it before ticking the box.

**What happens** (`lib/contacts.ts:32-60`):
1. `Contacts.getContactsAsync({ fields: [PhoneNumbers, Emails] })` reads the address book **on device** (lines 37-39).
2. Values are normalized (lowercased email / last-10-digits phone) and de-duplicated into a `Set` (lines 42-53), capped at 5,000 (line 10).
3. Each unique value is hashed with **salted SHA-256** — `SALT + input`, salt `'laybell:v1:'` (`lib/hash.ts:11,15-21`, via `expo-crypto`).
4. **Only the hash array** is returned. Raw names, numbers and emails never leave the function.

**What is transmitted** (`lib/suggestions.ts:114-125`): the hash array is sent in batches as an argument to the
`match_contacts` RPC.

**What is stored:** *nothing from the address book.* `match_contacts` is a `stable`, read-only SQL function that
performs a `SELECT` against `user_identifiers` and returns matching user ids — it contains no `INSERT`
(`supabase/sql/contacts_discovery.sql:49-64`). The only persisted flag is the boolean preference
`profiles.contacts_enabled` (`app/onboarding.tsx:161`).

Separately, the **signed-in user's own** email and (optional) phone are stored as salted hashes in
`user_identifiers` so that *other* people's contacts can match them (`lib/identifiers.ts:28-48`;
`supabase/sql/contacts_discovery.sql:22-27`). That table has **no SELECT policy** — clients can never read it
(lines 34-44).

**Recommended declaration.** Apple permits treating data that is transmitted only to service a request and not
retained as *not collected*. That technically applies here. **However**, hashes derived from a third party's
phone number are still personal data about that third party, and Apple reviewers are not going to reverse-engineer
your RPC. **Declare Contacts as Collected, Not Linked to identity, Not used for tracking, purpose App Functionality**,
and add the clarifying note that only salted hashes are transmitted and none are retained. Under-declaring here
is the higher-risk error.

On Google Play, tick **Contacts → collected → "Data is processed ephemerally"** (see §8).

⚠️ Honest caveat that the code itself documents (`lib/hash.ts:8-10`): a *static client-side* salt does not make
phone-number hashes brute-force-proof. This does not change the label, but it is worth knowing.

---

## 6. IP address logging (`lib/accessLog.ts` + `log-access`)

**Purpose: legal / security evidence, not analytics.** The function's own header says so
(`supabase/functions/log-access/index.ts:40`).

- The client **never sends an IP**. It only names the event (`lib/accessLog.ts:16-21`). The address is read
  server-side from `cf-connecting-ip` → `x-real-ip` → `x-forwarded-for`, and the header used is recorded
  alongside it so provenance is auditable (`supabase/functions/log-access/index.ts:63-76,101`).
- **Closed event list — 5 events only:** `upload`, `post`, `report`, `shop_download`, `live_start`
  (`lib/accessLog.ts:14`; enforced server-side at `supabase/functions/log-access/index.ts:41,87`).
- **Stored fields:** `user_id`, `event`, `subject_type`, `subject_id`, `ip`, `ip_source`, `user_agent` (truncated to 300 chars) — `index.ts:95-103`.
- **Retention: 13 months**, by manual/scheduled prune. Rationale documented as the ~120-day card-dispute window
  plus the 1-year CSAM preservation duty under 18 U.S.C. §2258A(h) — `supabase/sql/access_log.sql:78-87`.
- Rows are **immutable** (update trigger blocks edits, `access_log.sql:69-72`); DELETE is deliberately left open
  so retention pruning can work (`:73-75`).

Apple has no dedicated IP category. Declare under **Other Data**, linked, purpose App Functionality
(security / fraud prevention / legal compliance). It is **not** tracking.

⚠️ **The 13-month prune is not automated.** `access_log.sql:83` provides the statement as a comment and says
"Run monthly from the dashboard or a scheduled function." A human must actually schedule this, or the stated
retention period will not be true.

---

## 7. Browsing History & Search History — both NO, with two caveats

**Search History — not collected.** Grep for `recent_searches`, `search_history`, `recentSearches`,
`searchHistory`, `saveRecentSearch` returned **zero matches**. Search is executed as a transient `ilike` filter
on the query and discarded (`app/(tabs)/explore.tsx:386,407-409`; `app/(tabs)/music.tsx:316,335-336`). There is
no recents list, local or remote.

**Browsing History — not collected.** Apple's category covers content viewed *outside* the app. In-app viewing
(feed, reels, listens) is Usage Data → Product Interaction, and is declared there.

Two things a careful reviewer should know:

1. **Giphy** receives the GIF search term and the device's IP directly from the client
   (`lib/gifSearch.ts:36-41`). This is a live third party with a hardcoded key in the client bundle
   (`lib/gifSearch.ts:9`). Search *terms* are shared with Giphy but never stored by Laybell. Reasonable people
   declare this as "not collected by the developer" while listing Giphy as a recipient; it is your call whether
   to tick Search History. It is **not** tracking.
2. **Google Safe Browsing** would receive URLs the user is about to open — but only if configured. The default
   provider is `'none'` (`supabase/functions/check-link/index.ts:30`), and with no provider the function returns
   `allow` without contacting anyone (`:18-20`). **Today, no URL leaves.** If you set
   `LINK_CHECK_PROVIDER=safebrowsing`, revisit this row.

---

## 8. Google Play Data Safety — mapped

Play uses a different taxonomy and asks two extra questions. Both are answered below.

### Security & handling (global)

| Play question | Answer | Evidence |
|---|---|---|
| Is all user data **encrypted in transit**? | **Yes** | Supabase over HTTPS (`lib/supabase.ts:6`); Stripe API over HTTPS (`supabase/functions/stripe-connect/index.ts:55`); ad CTA URLs force-upgraded from `http` to `https` (`lib/ads.ts:481-484`); Giphy/Safe Browsing/Resend all HTTPS |
| Do you provide a way to **request data deletion**? | **Yes** | In-app: `lib/accountDeletion.ts:10-40` (flag → sign out → hard delete 48 h later by `supabase/sql/account_deletion_sweep.sql`). Server: `supabase/functions/delete-account/index.ts` |
| Do you provide **data export/access**? | Yes (not required, but true) | `lib/dataExport.ts:8-38` |
| Is any data **shared** with third parties (Play's definition)? | **No** — all recipients are processors/service providers | See recipient list below |
| Is data collection **optional** for some types? | Yes | Location, Contacts, Phone number, Ad personalization are all opt-in |

### Data types

| Play category | Type | Collected | Shared | Optional | Ephemeral | Purpose | Evidence |
|---|---|---|---|---|---|---|---|
| Personal info | Name | Yes | No | No | No | Account management, App functionality | `app/onboarding.tsx:123` |
| Personal info | Email address | Yes | No | No | No | Account management | Supabase Auth; `lib/dataExport.ts:14` |
| Personal info | User IDs | Yes | No | No | No | Account management, App functionality | `auth.uid()` throughout |
| Personal info | Phone number | Yes (hash) | No | **Yes** | No | App functionality (friend matching) | `lib/identifiers.ts:38-44` |
| Personal info | Gender | Yes | No | No | No | App functionality, Personalization | `app/onboarding.tsx:123` |
| Personal info | Date of birth | Yes | No | No | No | App functionality (age gate) | `app/onboarding.tsx:124`; `lib/minors.ts` |
| Personal info | Other info (username, bio, link) | Yes | No | No | No | App functionality | `lib/dataExport.ts:29` |
| Location | **Approximate location** | Yes | No | **Yes** | No | App functionality | `lib/location.ts:21,62-64` |
| Location | Precise location | **No** | — | — | — | — | §4 |
| Financial info | Purchase history | Yes | No | No | No | App functionality | `supabase/functions/revenuecat-webhook/index.ts:84-93` |
| Financial info | Payment info | **No** | — | — | — | — | §3 |
| Financial info | Credit score / other | ⚠️ see §⚠️ (earnings balance) | No | No | No | App functionality | `lib/ledger.ts:41-58` |
| Health & fitness | — | **No** | — | — | — | — | Verified absent |
| Messages | Other in-app messages | Yes | No | No | No | App functionality | `app/messages/[id].tsx`; `lib/groups.ts` |
| Messages | Emails / SMS | **No** | — | — | — | — | App never reads SMS or mail |
| Photos and videos | Photos, Videos | Yes | No | No | No | App functionality | `app/(tabs)/post.tsx`; `lib/upload.ts`; `lib/streamUpload.ts` |
| Audio files | Music files, Other audio | Yes | No | No | No | App functionality | Audio posts; `lib/live.ts`, `lib/studio.ts` |
| Files and docs | — | **No** | — | — | — | — | `expo-document-picker` present but used for media import only |
| Calendar | — | **No** | — | — | — | — | No calendar dependency |
| Contacts | Contacts | **Yes** | No | **Yes** | **Yes — processed ephemerally** | App functionality | §5; `supabase/sql/contacts_discovery.sql:49-64` |
| App activity | App interactions | Yes | No | No | No | App functionality, Analytics, Personalization | `lib/viewTracker.ts:59-89`; `lib/listenMeter.ts:26-34` |
| App activity | In-app search history | **No** | — | — | — | — | §7 |
| App activity | Other user-generated content | Yes | No | No | No | App functionality | Captions, comments, playlists, listings |
| App activity | Other actions (ad impressions/clicks) | Yes | No | No | No | Developer's advertising | `lib/ads.ts:696-747` |
| Web browsing | — | **No** | — | — | — | — | §7 |
| App info & performance | **Crash logs** | **Yes** | No | **No** | **Yes** | App functionality | Sentry. Not linked to an identity; users can switch it off in Privacy Center, which is what makes it optional |
| App info & performance | Diagnostics (performance) | **No** | — | — | — | — | `tracesSampleRate: 0` |
| App info & performance | Other app performance data | **Yes** | No | **No** | **Yes** | App functionality | Handled errors + breadcrumbs, same pipeline, same scrubber |
| Device or other IDs | Device or other IDs | Yes | No | No | No | App functionality, Fraud prevention | `lib/deviceId.ts:10-31`; push token `hooks/useNotifications.ts:62-71` |

### Recipients (processors — **not** Play "sharing")

| Recipient | What it receives | Evidence |
|---|---|---|
| **Supabase** | Everything — DB, auth, storage, edge functions | `lib/supabase.ts:6` |
| **Cloudflare Stream** | Uploaded video + live video/audio | `lib/streamUpload.ts`; `lib/cast.ts:23-44`; `supabase/functions/stream-direct-upload` |
| **RevenueCat** | Purchase events, `app_user_id` = Supabase uid | `lib/purchases.ts:50`; `supabase/functions/revenuecat-webhook/index.ts:58-62` |
| **Apple IAP / Google Play Billing** | Payment instrument (never seen by Laybell) | `lib/purchases.ts:81-92` |
| **Stripe** (Connect Express) | Creator identity + bank details, entered on Stripe's own pages | `supabase/functions/stripe-connect/index.ts:101-129` |
| **Expo push / APNs / FCM** | Push token + notification payloads | `hooks/useNotifications.ts:62-71`; `supabase/functions/send-push` |
| **LiveKit** | Studio session audio | `lib/studio.ts`; `supabase/functions/livekit-token` |
| **Giphy** | GIF search term + device IP (direct from client) | `lib/gifSearch.ts:9,36-41` |
| **Resend** | Parent/guardian email address (13-17 consent) | `supabase/functions/parent-consent/index.ts:41-58` |
| **Translation provider** (LibreTranslate default / Google / DeepL) | User-typed text the viewer asked to translate | `supabase/functions/translate/index.ts:35,60-68` |
| **Google Safe Browsing** | URLs — **only if `LINK_CHECK_PROVIDER` is set**; default `none` | `supabase/functions/check-link/index.ts:30,43-55` |
| **Google / Apple Sign-In** | Auth identity | `lib/socialAuth.ts`; `app.json:126-131` |

---

## 9. Explicit NOT COLLECTED list

Apple wants certainty. Each of these was actively searched for and is absent from the codebase:

- **Health & Fitness** — no HealthKit, no `expo-sensors`, no pedometer, no heart-rate, no workout data. No such dependency in `package.json:5-67`.
- **Financial Info → Payment Info** — no card number, CVV, expiry, routing number, or account number field exists. §3.
- **Financial Info → Credit Info** — no credit score or creditworthiness data.
- **Precise Location** — never stored or transmitted. §4.
- **Physical Address** — no address field.
- **Browsing History** — §7.
- **Search History** — §7.
- **Diagnostics — PERFORMANCE data only** — `tracesSampleRate: 0`, so no transactions or spans are sent. ⚠️ Crash data and other diagnostic data ARE collected via Sentry; see the Diagnostics rows above. No Firebase, Crashlytics, Bugsnag, Amplitude, PostHog, Segment, Mixpanel, Datadog, `expo-insights` or `expo-updates`.
- **Advertising identifiers (IDFA / GAID / IDFV)** — zero references repo-wide. §2.
- **Gameplay Content** — not a game.
- **Calendar data** — no calendar dependency.
- **SMS / call log** — no `READ_SMS`, `READ_CALL_LOG`, or equivalent in `app.json:37-42`.
- **Biometric data** — no Face ID / Touch ID / `expo-local-authentication`.
- **Racial or ethnic origin, religion, political opinion, trade union membership, genetic data** — no such field.
- **Sexual orientation** — not collected. Gender options are `Woman / Man / Non-binary / Other / Prefer not to say` (`lib/profileOptions.ts:10`) and do not capture orientation.

---

## 10. Permission strings (from `app.json`)

| Permission | Platform | Plugin / key | Current string | `app.json` |
|---|---|---|---|---|
| Photo library (read) | iOS/Android | `expo-media-library.photosPermission` | "Allow Laybell to access your photos so you can choose one to post." | `:67` |
| Photo library (write) | iOS/Android | `expo-media-library.savePhotosPermission` | "Allow Laybell to save captured stories to your photo library." | `:68` |
| Camera | iOS/Android | `expo-camera.cameraPermission` | "Allow Laybell to use your camera to capture stories and posts." | `:75` |
| Microphone | iOS/Android | `expo-camera.microphonePermission` | "Allow Laybell to use your microphone for video stories." | `:76` |
| Microphone (audio recording) | iOS/Android | `expo-audio.microphonePermission` | "Allow Laybell to record audio for your posts." | `:103` |
| Camera (livestream) | iOS/Android | `@config-plugins/react-native-webrtc.cameraPermission` | "Allow Laybell to use your camera to broadcast livestreams." | `:111` |
| Microphone (livestream/studio) | iOS/Android | `@config-plugins/react-native-webrtc.microphonePermission` | "Allow Laybell to use your microphone for livestreams and studio sessions." | `:112` |
| Location — when in use | iOS/Android | `expo-location.locationWhenInUsePermission` | "Allow Laybell to use your approximate location to suggest people near you." | `:91` |
| Contacts | iOS/Android | `expo-contacts.contactsPermission` | "Allow Laybell to access your contacts to find people you may know on Laybell." | `:97` |
| Notifications | iOS/Android | `expo-notifications` | *(no custom string — system default)* | `:80-87` |
| `FOREGROUND_SERVICE` | Android | manifest | *(n/a)* | `:38` |
| `MODIFY_AUDIO_SETTINGS` | Android | manifest | *(n/a)* | `:39` |
| `ACCESS_COARSE_LOCATION` | Android | manifest | *(n/a)* — note: **no** `ACCESS_FINE_LOCATION` | `:40` |
| `READ_CONTACTS` | Android | manifest | *(n/a)* | `:41` |
| Background audio | iOS | `UIBackgroundModes: ["audio"]` | *(n/a)* | `:22-24` |
| App Tracking Transparency | — | **absent** | **none — correct, no tracking** | — |

Also in `app.json`: `ITSAppUsesNonExemptEncryption: false` (`:25`), `usesAppleSignIn: true` (`:27`).

---

## ⚠️ UNCERTAIN — a human must verify

These could not be settled from source alone. Do not fill in the store forms on these rows without checking.

1. **Is DOB/age "Sensitive Info" under Apple's definition?** Apple's Sensitive Info list is racial/ethnic origin,
   sexual orientation, pregnancy, disability, religious belief, trade union membership, political opinion,
   genetic data, biometric data. **Age is not on that list**, so the literal answer is no — but the app knowingly
   stores that a user is a minor (`lib/minors.ts:36-39`), and some reviewers treat known-minor status as
   sensitive. This document's table declares DOB/age under **Other Data**. Confirm with counsel whether you want
   to also tick Sensitive Info. `MIN_AGE = 13` (`lib/profileOptions.ts:28`).

2. **Is gender "Sensitive Info"?** Gender identity is not in Apple's enumerated list (sexual *orientation* is,
   and is not collected). The stored options are `Woman / Man / Non-binary / Other / Prefer not to say`
   (`lib/profileOptions.ts:10`). Declared here under **Other Data**. Confirm.

3. **Creator earnings balance → "Financial Info → Other"?** Apple defines that sub-type as "salary, income,
   assets, debts, or any other financial information". A creator's withdrawable earnings balance
   (`lib/ledger.ts:41-58`, `lib/wallet.ts:62-99`) is arguably income data. It is not a payment instrument. This
   document flags it Yes conservatively. Confirm whether you want to declare it — note that the ledger returns
   zeros until `supabase/sql/ledger.sql` is applied, and `PLATFORM_COLLECTS_DONATIONS`/`PLATFORM_COLLECTS_SHOP`
   are both `false` today (`lib/wallet.ts:44-45`), so no real balance exists yet.

4. **Contacts — "collected" vs "ephemeral".** §5 explains the trade-off. The code supports the ephemeral
   reading; the recommendation here is to declare collection anyway. **Decide deliberately and document why.**

5. **iOS will grant *full* location accuracy by default.** `app.json:88-93` requests when-in-use with no
   `NSLocationDefaultAccuracyReduced`. The app immediately discards the precision (`lib/location.ts:53-54`), so
   the *label* answer (Coarse) is correct — but consider adding
   `ios.infoPlist.NSLocationDefaultAccuracyReduced: true` so the OS never hands over a precise fix in the first
   place. That would make the Coarse declaration unassailable and matches the Android manifest, which already
   requests coarse only. **Requires a native rebuild.**

6. **Does RevenueCat collect device identifiers or forward to attribution networks?** `lib/purchases.ts:50`
   configures it with the Supabase uid as `appUserID` and sets no attribution integrations in code. RevenueCat's
   SDK does collect some device data of its own, and *can* forward to ad attribution partners if that is enabled
   **in the RevenueCat dashboard**. **Check the dashboard.** If any attribution/ad-network integration is on,
   "Used for Tracking" may become `Yes` and an ATT prompt would be required. Code alone cannot tell you this.
   Note the iOS key is live (`app.json:156`) while `androidApiKey` is empty (`:157`).

7. **Which translation provider is actually configured in production?** `supabase/functions/translate/index.ts:35`
   defaults to `libre` (`https://translate.argosopentech.com` — a third-party public instance), but memory notes
   say Google is live. **User-typed message and comment text is sent to whichever it is.** Verify the deployed
   `TRANSLATE_PROVIDER` secret and name that provider in your privacy policy.

8. **Is `LINK_CHECK_PROVIDER` set in production?** Default is `none` (`supabase/functions/check-link/index.ts:30`).
   If Safe Browsing is enabled, URLs the user opens are sent to Google — reconsider the Browsing History row.

9. **Access-log retention is not automated.** `supabase/sql/access_log.sql:83` supplies the prune statement only
   as a comment. Schedule it, or the "13 months" figure is aspirational rather than true.

10. **Supabase Auth stores its own metadata** (last sign-in, provider, possibly IP) inside `auth.users` /
    `auth.audit_log_entries` — that is platform behaviour, not application code, so it is invisible to this
    audit. Check your Supabase project settings for auth-log retention before claiming a complete inventory.

11. **Cloudflare Stream / Cloudflare edge logs** may retain viewer IPs independently of `access_log`. Outside
    this repo. Check your Cloudflare configuration.

12. **Giphy API key is hardcoded in the client bundle** (`lib/gifSearch.ts:9`). Not a labelling issue, but it is
    extractable from any shipped build and should be rotated/proxied. Flagging it here because it also means
    Giphy sees raw device IPs with no Laybell intermediary.

13. **`expo-document-picker` is a dependency** (`package.json:31`). This audit found no flow that reads arbitrary
    user documents, but the capability exists. Confirm it is only used for media import before ticking Play's
    "Files and docs → No".

---

## Discrepancies vs. the existing `docs/STORE_PRIVACY_DISCLOSURES.md`

| Existing doc says | This audit found |
|---|---|
| Gender + DOB listed under **Sensitive Info** | Neither is in Apple's enumerated Sensitive Info list. Moved to Other Data; flagged as a judgment call (⚠️ 1-2). |
| No mention of **IP address logging** | `access_log` stores IP + user agent for 5 event types, 13-month retention (§6). Must be disclosed. |
| No mention of **creator earnings** as financial data | Ledger holds per-user income-like balances (⚠️ 3). |
| Third-party recipients listed as "Supabase, Expo, RevenueCat" | Also **Cloudflare Stream, Stripe, LiveKit, Giphy, Resend, a translation provider**, and conditionally Google Safe Browsing (§8). |
| "Spotlight & Ad Manager remain simulated" | Confirmed — `provider: 'simulated'` (`lib/ads.ts:913`). |
| "no third-party ad/analytics/crash SDKs" | Confirmed. |
| "We do NOT use data to track you" → Tracking: No | Confirmed, with the RevenueCat-dashboard caveat (⚠️ 6). |
| Coarse location declared | Confirmed, and the exact ~11 km rounding is now cited (§4). |
| Contacts "stored hashed" | **Imprecise.** Other people's contact hashes are **not stored at all** — only matched and discarded. The user's *own* email/phone hashes are stored (§5). |
