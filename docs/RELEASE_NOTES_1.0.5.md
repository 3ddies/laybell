# 1.0.5 — release notes (IN PROGRESS)

Paste-ready store copy below. Google Play caps release notes at **500 characters**,
App Store "What's New" at **4000**:

```bash
node scripts/check-release-notes.mjs docs/RELEASE_NOTES_1.0.5.md
```

> **1.0.5 supersedes 1.0.4 (build 12).** Build 12 was uploaded to App Store Connect but
> never submitted, so 1.0.5 is the next public release after 1.0.3 — it carries React +
> profile views (new) AND everything from 1.0.4 (post analytics, the performance pass,
> cleaner sound, Explore previews, the profile checklist and badges). The notes cover it all.

---

## Google Play — "What's new" (≤500 chars)

```
• React: record your reaction to any video or song — you full-screen with the original in a corner, or the original full-screen with your reaction in the corner.
• See who viewed your profile (your call whether to share yours back).
• Post analytics: tap ⋯ on a post for views, engagement and trends.
• Faster app, cleaner sound, livelier Explore.
• New badges + a profile checklist. Polish and fixes.
```

---

## App Store — "What's New in This Version" (≤4000 chars)

```
What's new in 1.0.5

React — react to what you're watching. Record your take on any video or song and post it. Put yourself full-screen with the original in a small corner window, or flip it: the original full-screen with your reaction in the corner. Or react "after" — a slice of the original plays first, then your response.

See who viewed your profile — a new list of who's been checking you out. It's your call whether to take part: turn it off any time, and you only see others when you share yours too.

Also in this update:
• Post analytics — tap ⋯ on any of your posts to see how it's doing: views, likes, comments, shares and saves, an engagement rate, views over time, and how the post stacks up against your average.
• A faster, smoother app — quicker startup, snappier screens, smoother scrolling and lists, and animations that keep up with your finger.
• Cleaner sound — only one thing plays at a time now, so a song and a video's audio never talk over each other, and songs on posts start faster.
• Livelier Explore previews.
• A complete-your-profile checklist and new badges to earn.
• Plenty of polish and bug fixes.

Thanks for using Laybell!
```

---

# STATUS

## New in 1.0.5 (on top of 1.0.4's content)

**React (reaction videos)** — react to any video or song from the post's ⋯ menu; the
result is an ordinary video post that composes at playback (no baked file — that's the
deferred native follow-up). Files: `lib/composition.ts`, `components/CompositionPlayer.tsx`,
`components/CompositionBadge.tsx`, `app/remix/[id].tsx`. SQL: `post_remix_sequence.sql`
(**APPLIED + verified in prod**; constraint allows `pip`, `pip_flip`, `side_by_side`,
`top_bottom`, `green_screen`, `add`). Pure JS on the existing native binary.

- **Two views offered** (both corner overlays — they suit a vertical reaction): **pip** =
  you full-screen, the original in a small top-right window; **pip_flip** = the original
  full-screen, you in the corner. Side-by-side / top-bottom were dropped as offerings
  (poor full-screen in reels) but remain in the schema so any older post still resolves.
  Green screen is deferred to the native update — it will become an effect on these two
  views.
- **Two modes** — **Commentary** (you + the original play together, in a view) and **Add**
  ("After" — the original's cropped slice plays first, then your clip, on one stitched
  timeline the reel scrub bar can seek across).
- **Songs too** — react to a track (audio); it plays cleanly ducked under your voice.
- **Studio audio** — the reference is muted while you film (you watch it), so your mic
  records only your voice; the clean original is added ducked at playback → heard once, no
  echo, no headphones needed.
- **Auto-tags the original creator** so they're notified.
- Reels fill the whole screen; sync realigns only on load + loop (smooth); the source post
  is fetched through a cached, deduped `fetchSourcePost`.

**Profile views ("Viewed your profile")** — TikTok-style list, top-right of your own
profile. Opt-out and reciprocal (**on by default**; you see others only if you share yours),
30-day window, definer RPCs with **anon revoked**, realtime friend pop-up. SQL:
`profile_views.sql` (**APPLIED + verified in prod**: table, `profiles.profile_views_enabled`,
4 RPCs, added to `supabase_realtime`). Files: `lib/profileViews.ts`, `app/profile-viewers.tsx`,
`components/ActivityBanner.tsx`.

**Story pulse** — a subtle breathing animation on "Your story" when you have no active
story (minor; no store mention).

## Pre-build gates (verified 2026-09-25)

- 💰 Demo/fabricated money **clear** — `global_sum_must_be_0` = 0, no ledger violations,
  no negative balances (weekly health check).
- 🗄️ **Schema audit: no drift** — every declared table/function/column/index/trigger exists
  in prod; the two new SQL files are live with anon revoked on the profile-view RPCs.
- 📦 **No new native module or dependency** — pure JS + already-applied SQL, so the native
  fingerprint is unchanged from build 12. Standard production build; EAS auto-increments to
  build 13. Version bumped 1.0.4 → 1.0.5 in `app.json`.
- 🧹 No debug/"REMOVE BEFORE RELEASE" markers in the new code; typecheck 0 errors; iOS bundle
  builds clean.

## Everything from 1.0.4 (carried into 1.0.5)

1.0.4's full detail lives in `docs/RELEASE_NOTES_1.0.4.md` — post analytics (owner-only, real
data only, `post_view_series.sql` deployed), the Instagram-polish performance pass (Sentry
tracing, 120Hz, instant screens, right-sized images + thumbhash, UI-thread sheets, recycled
grids, leaner launch), React Compiler on, and audio-focus (one sound at a time). All committed
on `dev` (`07446c4`, `87a459d`, `cec8430`, `f34d52f`, `5a14c5f`).

## Before the owner submits

- Confirm demo/test money is still OFF at submit time (re-run the health check).
- **Android still needs the Play service-account key** (`docs/PLAY_SERVICE_ACCOUNT.md`) or a
  manual `.aab` upload; `eas.json` sends Android as a draft release.
- Owner triggers the EAS production build and the submit (`eas submit` only uploads — the
  version must still be created/submitted in App Store Connect, as with 1.0.4).
