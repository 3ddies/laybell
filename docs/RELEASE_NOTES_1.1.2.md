# Laybell 1.1.2 — release notes

## What's New (store copy)
- **Guided walkthroughs** introduce the Shop, Wallet, Spotlight and Premium the first time you open them — each in that feature's own colour.
- **Your lifetime stats** now greet you at the top of Notifications — Views, Song plays and Likes — flipping up live as engagement rolls in. Tap to see them full-screen.
- **Premium+** now makes clear it includes everything in Laybell Premium.
- Polish throughout.

## What shipped (technical)
- **Reusable coachmark system** — `lib/coachmarks` (`useCoachmark` + registry + `useCoachmarkTarget` + `resetAllCoachmarks`) and `components/Coachmark` (full-screen `CoachmarkCard` in each feature's colour, plus `CoachmarkPointer`). First-visit walkthroughs on Shop / Wallet / Spotlight / Premium; **Settings → "Replay tutorials"** resets them all (incl. legacy DJ flags).
- **Notifications lifetime-stats header** — Views / Song plays / Likes, with a flip/roll animation (`components/RollingNumber`) and a tappable **full-page view** (`app/lifetime-stats`). Live via focus-aware polling (`lib/useLifetimeStats`, 4s) over **denormalized counters only** (`view_count + stream_count + like_count`) — O(posts), safe at viral scale, never per-row realtime or counting the likes table.
- **Premium+** perks lead with an "Everything in Laybell Premium, plus:" highlight band.
- **Settings** footer shows the Laybell bell mark instead of the tagline line.
- **No new native modules, SQL migrations, or edge functions** — pure client JS over existing data. NO OTA → ships in this build. Commit `25c869d` on `dev`.

## Pre-build gates (verified 2026-11-05)
- 💰 money: `global_sum_must_be_0`=0, no ledger violations, no negative balances, nothing overdue.
- 🗄️ schema: no drift (no new objects this release).
- 🧩 edge functions: all 27 ACTIVE, no deploy drift (none changed this release).
- 🧹 app typecheck: 0.

## Submit steps
- **iOS:** EAS production build → App Store Connect (app `6795675871`) create the 1.1.2 version, select the build, paste What's New, keep the reviewer demo notes, Submit. No new IAPs this release. ⚠️ Confirm demo money OFF before Submit.
- **Android:** `eas submit -p android --profile production` (or upload the `.aab`) → roll out in Play Console.
