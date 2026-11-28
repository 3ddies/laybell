# Web Ads — plan + build log

**Owner priority 2026-11-21: ads BEFORE web purchasing.** Goal: the app's ad ecosystem
(`lib/ads.ts`) serving on **laybell-web**, with web **music** ads behaving exactly like
the app music ecosystem and web **Laybell TV** ads like the app TV. Companion to the app
ad engine (`lib/ads.ts`) and `docs/BEATS_IAP_PLAN.md`.

**Reality check (2026-11-21): prod has 0 ad_campaigns and 0 ad_creatives** — the engine is
built, no advertiser has run a campaign. So *nothing serves yet on any surface*, and web
serving degrades to "no ad" exactly like the app. Billing is therefore not urgent; the
anti-abuse layer is built but **gated on owner money-review before it ever bills**.

---

## 0. Serving model (shared with the app)

Ads serve CLIENT-SIDE and unranked — organic ranking is never touched. An eligible
campaign is: `kind='ad'`, `status='active'`, within schedule, within budget, not the
viewer's own, author not blocked, and targeting-match. RLS already limits the anon key to
active campaigns. Entitlements: Premium = ~½ ads, Premium+ = none (web has no entitlement
for anon → anon always sees ads). Minors/unknown-age → **untargeted only** (carried over).

**Web v1 serves UNTARGETED campaigns only** (`targetingMatch(..., personalized=false)` →
campaigns with no targeting). Full personalization (age/gender/genre/geo + affinity) is a
follow-up once the web has the viewer's affinity profile. This is honest + privacy-safe.

## 1. Laybell TV — web (THIS build)

The app weaves TV ads *between* videos on a count cadence (every 4, first at 2+20s) via the
swipe pager. **The web has no pager** — `/tv` is a grid you click to watch one video at a
time. So per owner (2026-11-21): on the web, a Laybell TV video **plays a PRE-ROLL ad on
click, YouTube-style — but ONLY for videos > 120s** (short clips never pre-roll).

- **Where:** `/p/[id]` watch page, when `isVideo && aspect>1 && duration_seconds > 120`.
- **Serve:** server component fetches ONE eligible untargeted `tv` creative (anon client);
  if present, the client `TvPreroll` plays it full-bleed before the Stream player.
- **Playback/skip (mirrors app):** unskippable by default (plays fully), `skip15` →
  skippable after 11s, `skip10` (simple shop ads) → 10s. Countdown → Skip button.
- **Overlay:** "Sponsored · {advertiser}", CTA (awareness→profile, engagement→shop/listing,
  traffic→website), a report affordance; then reveal the real video on end/skip.
- **No inventory → no pre-roll:** the video just plays. Graceful, identical to the app.

**Films on web:** the Stream player *can* pause + overlay, so real mid-rolls (app
`filmAdThresholds`, watch-time-based) are portable — **follow-up phase**.

## 2. Music — web (follow-up phase)

App music ads are **time-gated breaks** (first 60s, then 3–5 min, play as a song card
between tracks). Port to the web music player: the break scheduler + a sponsored "song
card" between tracks, same `pickAudioAd` eligibility. Needs the web music player's
play-session clock. Not in the first build.

## 3. Impressions, views & ANTI-ABUSE (money-gated)

Owner: web ad views count as real views, **but** anonymous (no-account) viewing must not be
exploitable (bots, repeat-on-same-device, IP rotation, endpoint abuse, budget-drain).
Layered, **server-authoritative** design — the client never asserts "I viewed this":

1. **Recorded server-side only.** Logged-in web reuses the existing, money-reviewed
   `record_ad_event` RPC (same `(viewer, campaign, placement, hour)` dedup as the app).
   Anonymous web goes through a NEW edge fn `record-web-ad-event`.
2. **Viewability-gated.** Count only after genuine in-viewport playback ≥ N s (pre-roll:
   after the unskippable window / N s of real play). A bare load never bills.
3. **Bot check:** Cloudflare **Turnstile** token required for anonymous impressions
   (invisible to real users; blocks headless/scripts). We already use Cloudflare.
4. **Anon dedup = app model, adapted:** key `(signed first-party device token + hashed
   IP + UA, campaign, placement, hour)` — same once-per-hour cap.
5. **Per-device & per-IP caps** per campaign/window; beyond them the ad still *shows* but
   does NOT *bill* (caps single-abuser impact + budget-drain attacks).
6. **Anomaly reconciliation:** don't bill impression spikes from a single IP/device.

**GATE:** `record-web-ad-event` + any `supabase/sql` for anon billing is money-adjacent →
**owner adversarial money-review before deploy, and before anon impressions bill** (same
bar as the IAP/Stripe rails — "always review money code before it runs"). Until then:
show ads to everyone; bill logged-in only (existing RPC); anon = show-don't-bill.

## 4. Build phases

- **Phase 1 — BUILT + VERIFIED 2026-11-21 (not yet deployed).** `web-app/lib/ads.ts`
  serving (untargeted eligibility, one-tv-ad fetch w/ legacy-select fallback, skip helpers,
  `record_ad_event` helper gated to logged-in viewers); `web-app/lib/streamSdk.ts` (shared
  SDK loader); `TvWatch` client component (idle poster+play → ad → video state machine,
  SDK-driven skip countdown, impression-on-play, graceful fallbacks); wired into `/p/[id]`
  for landscape videos >120s (same aspect>1 rule as /tv). Logged-in impression via the
  existing money-reviewed RPC; **anon = show-don't-bill** (no anon billing path exists yet,
  so nothing is exploitable). Verified end-to-end against a forced test ad: idle→ad (AD
  badge + sponsor + "Shop now" CTA + "Skip in 11s" → "Skip Ad" at the gate)→real video,
  plus the graceful no-ad path (0 prod inventory → video plays directly). Build clean 16/16;
  no console errors. **Holding deploy for owner go-ahead (money surface).**
- **Phase 2:** anon billing — `record-web-ad-event` edge fn + Turnstile + caps + SQL →
  owner money-review → deploy.
- **Phase 3:** web music ads (time-gated breaks in the web music player).
- **Phase 4:** film mid-rolls on web; full web personalization/targeting.
