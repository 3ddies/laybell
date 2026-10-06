# 1.0.7 — release notes

Paste-ready store copy below. Google Play caps release notes at **500 characters**,
App Store "What's New" at **4000**:

```bash
node scripts/check-release-notes.mjs docs/RELEASE_NOTES_1.0.7.md
```

> **Shipping as 1.0.7.** 1.0.6 was **approved by Apple** (train closed), so the multi-clip
> camera, the obsidian/light theme redesign and the Shop revamp already reached users in 1.0.6 —
> these notes cover only what's **new in 1.0.7**: one-tap beat purchases plus a batch of social
> polish (post-engagement viewers, quick-follow, story editor/viewer fixes, a profile-completion
> prompt).
>
> ⚠️ **1.0.7 is the first build that carries the beats direct-IAP feature live.** The server side
> (RPCs, webhook, ledger) is already deployed and reviewed; the one-tap **Buy** only appears once
> the store IAP products are approved **with this version** — see "Before the owner submits".

---

## Google Play — "What's new" (≤500 chars)

```
• Buy beats in one tap — purchase a track straight from the Shop.
• See who liked your posts: tap any like count to view everyone who engaged.
• Quick-follow suggested people right from your stories tray.
• A smoother story editor and viewer.
• A new prompt to help you finish your profile, clearer counts in dark mode, plus polish and fixes.
```

---

## App Store — "What's New in This Version" (≤4000 chars)

```
What's new in 1.0.7

Buy beats in one tap — you can now purchase a beat directly from the Shop, right when you find it. Quick and secure.

See who's engaging — tap the like count on any post to see everyone who liked it. On your own posts you can also see who reposted and saved them.

Quick-follow — found someone new in your stories tray? Follow them with a single tap, no profile visit needed.

Also in this update:
• A smoother story editor and viewer.
• A friendly prompt to help new accounts finish setting up their profile.
• Clearer, easier-to-read counts in dark mode.
• Plenty of polish and bug fixes.

Thanks for using Laybell!
```

---

# STATUS

## New in 1.0.7 (on top of everything shipped in 1.0.6)

- **Beats direct in-app purchase** — the headline. A buyer can purchase a fixed-price beat with a
  single tap in the Shop (Apple/Google IAP → RevenueCat webhook → append-only ledger → file
  delivery), instead of pre-loading credits. Off-ladder or variable prices still fall back to
  credits. Committed on `dev`: `1312e6a` (feature), `71bc014` + `00c1c70` (revoke anon/PUBLIC on
  the RPCs), `12de5b4` (deferred money fixes), `565c552` (Android $400 cap + version bump).
  - Money core is **already deployed to prod and reviewed** (`supabase/sql/shop_iap.sql`,
    `supabase/sql/shop.sql` surgical, `supabase/functions/revenuecat-webhook`) — it runs for the
    live apps now; 1.0.7 is only the **client** that shows the Buy button.
  - Price ladder: `lib/pricing.ts` (22 tiers $4.99 → $999.99). **iOS has all 22** App Store
    products; **Android has 19** — Google Play's default **$400 price cap** means the top three
    tiers ($499.99 / $699.99 / $999.99) have no Play product, so `canBuyWithIap()` is
    platform-aware and those route to **credits-only on Android**. 19/22 is the max creatable on
    Play until Google grants a higher limit (needs >$1M Play earnings).
  - Products: **22 in App Store Connect + 22 in RevenueCat (App Store app); 19 in Google Play + 19
    in RevenueCat (Play app, as Consumable).** iOS-sandbox device-tested end-to-end.
  - 🔒 A live **anon-mint hole** (a missing `revoke anon` on `shop_iap.sql`, the classic default-
    PUBLIC-grant gotcha) was found, fixed and verified in prod on 2026-10-05.
- **Post-engagement viewers** — tap a post's like **count** to see who liked it; on your own posts,
  extra owner-only **Reposts** and **Saved** tabs (Saved is a private count only — no RLS change).
  New `app/post-engagement/[id]`, `lib/postEngagement.ts` (both uncommitted on `dev`).
- **Suggested-follow ＋** — a white/black follow ＋ on the Home stories tray's suggested profiles;
  tap → check, persists until a focus refresh (`StoriesTray.tsx`, uncommitted).
- **Profile-completion card** — a prompt that nudges new accounts to finish their profile
  (`components/ProfileCompletion.tsx`).
- **Story editor + viewer polish** — editor/viewer refinements plus a fix for the text-sticker
  viewer bug (`StickerLayer.tsx`, `app/story/[userId].tsx`, `contexts/StoriesContext.tsx`,
  `lib/stories.ts`, `app/(tabs)/story-camera.tsx`).
- **Dark-mode feed counts → white** — like/comment/repost counts that were hard to read on the dark
  feed are now white (`app/(tabs)/index.tsx`, `app/post/[id].tsx`, `app/reel/[id].tsx`,
  `components/NowPlaying.tsx`, `components/TVRemote.tsx`, `components/StoryAvatar.tsx`).

> The story/UI batch above is **uncommitted on `dev`** (see `git status`). Owner device-tests in the
> dev build, then the owner commits + pushes. Typecheck is 0.

## Pre-build gates (verified 2026-10-06)

- 💰 **Money integrity clear** — `global_sum_must_be_0` = 0, no ledger violations, no negative user
  balances (read-only money verify + `_HEALTH_CHECK.sql`). Open moderation items (1 post report,
  3 user reports) are non-blocking.
- 🗄️ **Both audits clean** — schema audit **no drift** (`node scripts/schema-audit.mjs`), and
  deploy-drift **26/26 edge functions deployed**, none committed-after-deploy (RevenueCat webhook
  current, deployed after its last commit).
- 📦 **App typecheck 0 errors** (the only `tsc` output is Deno globals/URL-imports under
  `supabase/functions/**`, which don't ship in the app bundle). No new native module or dependency
  vs 1.0.6 → **native fingerprint unchanged**, so no forced rebuild reason beyond the new JS.

## Before the owner submits

**App Store Connect (iOS):**
- Build 1.0.7 (EAS autoincrements the build number) → `eas submit` uploads it → Apple processes.
- Create/select the **1.0.7** version → select the new build → paste the "What's New" above → add
  the reviewer demo login from `docs/APP_REVIEW_NOTES_1.0.5.txt` (demo **email**, not username).
- 🟡 **Attach the beat IAP products to this version and submit them *with* the build.** A first IAP
  submission is reviewed alongside the app; until the products are **Approved**, the one-tap Buy has
  no product to sell (the client already falls back to credits, so nothing breaks — it just won't
  show the IAP path). Confirm the products are "Ready to Submit"/attached in ASC.
- ⚠️ **Re-confirm demo/fabricated money is OFF** before clicking Submit (standing rule).

**Google Play (Android):**
- Play **upload key granted 2026-10-04**; the latest EAS Android build is stale (1.0.5 / vc11) →
  rebuild 1.0.7 and `eas submit -p android` (draft), or upload the `.aab` manually.
- The 19 Play IAP products + RevenueCat Play products are already live; the 3 tiers above $400 are
  intentionally credits-only on Android (handled in `lib/pricing.ts`).
- The "What's new" above is 342/500 chars (verified with the check script).
