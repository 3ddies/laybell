# 1.0.6 — release notes

Paste-ready store copy below. Google Play caps release notes at **500 characters**,
App Store "What's New" at **4000**:

```bash
node scripts/check-release-notes.mjs docs/RELEASE_NOTES_1.0.6.md
```

> **Shipping as 1.0.6 build 15 — uploaded to App Store Connect 2026-09-30, awaiting the owner's Submit.**
> Why 1.0.6 and not another 1.0.5 build: App Store Connect **rejected build 14 (1.0.5)** with
> *"the train version '1.0.5' is closed... must be higher than the previously approved version [1.0.5]"* —
> i.e. **1.0.5 was already approved by Apple** (train closed). So React, profile views, post
> analytics and the performance pass already reached users in 1.0.5; these notes therefore cover
> only what's **new in 1.0.6**.
>
> ⚠️ **Confirm before pasting:** if 1.0.5 did NOT actually reach users (approved but unreleased),
> fold its features back in. If 1.0.5 is live, the copy below is correct as-is.

---

## Google Play — "What's new" (≤500 chars)

```
• New camera: record in multiple clips and film in time with a song for tight lip-sync.
• A fresh look: redesigned dark (obsidian) and light themes.
• A cleaner Shop, easier to browse, with your wallet one tap from your profile.
• Redesigned "go live" screen, 99+ notification counts, plus polish and fixes.
```

---

## App Store — "What's New in This Version" (≤4000 chars)

```
What's new in 1.0.6

A new camera — record your post in several clips and we'll stitch them into one, and film in time with a song so your lip-sync lands right.

A fresh look — a redesigned dark theme in deep obsidian black, and a brighter, cleaner light theme.

A refreshed Shop — the marketplace is easier to browse, with a cleaner layout and clearer pricing. Your wallet is now one tap from your profile, too.

Also in this update:
• A redesigned "go live" screen.
• Your unread notification count now shows all the way up to 99+.
• Cleaner playlist and music menus.
• Plenty of polish and bug fixes.

Thanks for using Laybell!
```

---

# STATUS

## New in 1.0.6 (on top of everything shipped in 1.0.5)

- **Camera-first / multi-clip / lip-sync capture** — the New Post camera records in several
  segments stitched into one clip (native concat via `modules/laybell-video-export`), and plays
  a chosen song out loud during a silent recording so the post is lip-synced. Files:
  `app/(tabs)/post.tsx`, `components/CaptureCamera.tsx`, `lib/videoConcat.ts`,
  `components/VideoStudio.tsx`.
- **App-wide theme redesign** — dark → obsidian `#040406`; light → Instagram-clean `#FAFAFA`
  canvas with pure-white cards + `#DBDBDB` hairlines (`constants/theme.ts`); Settings swatches
  updated.
- **Shop revamp** — category-chip clipping fixed, filled category pills, card scrim + price pill
  (`app/shop/index.tsx`, `components/ShopListingCard.tsx`).
- **Profile → Wallet shortcut** — one-tap wallet icon in the own-profile header
  (`app/(tabs)/profile.tsx`); credits are one tap further from inside the Wallet.
- **Go-live screen redesign**, notification dropdown badge counts to **99+**, credits dialog shows
  `$0` not "FREE", playlist + SongBrowser accent cleanup, white/black legal banner.

## Pre-build gates (verified 2026-09-30)

- 💰 Demo/fabricated money **clear** — all balances $0, no ledger violations, no negative balances,
  demo marker rows gone (health check + read-only money verify).
- 🗄️ **All three audits clean** — schema audit (0 missing objects), deploy-drift (26/26 functions
  current, RevenueCat webhook + stripe-connect not stale), weekly health check.
- 📦 No new native module/dependency; typecheck 0 errors; iOS bundle builds clean.

## Before the owner submits (App Store Connect)

- Apple finishes processing build 15 (~5–10 min) → it appears under the app's builds.
- Create/select the **1.0.6** version → **select build 15** → paste What's New above → add the
  reviewer demo login from `docs/APP_REVIEW_NOTES_1.0.5.txt` (demo **email**, not username) →
  **Submit for Review**.
- **Android** still needs the Play service-account key (`docs/PLAY_SERVICE_ACCOUNT.md`) before any
  `eas submit -p android`.
