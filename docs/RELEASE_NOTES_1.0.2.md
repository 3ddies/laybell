# 1.0.2 — release notes

Paste-ready copy for both stores. **The two are different lengths on purpose:**
Google Play caps release notes at **500 characters**, App Store "What's New" at
**4000**. Character counts are asserted by `scripts/check-release-notes.mjs` —
run it after any edit rather than trusting a word processor's count, because
Play rejects at submission time and that is a slow way to find out.

```bash
node scripts/check-release-notes.mjs docs/RELEASE_NOTES_1.0.2.md
```

Written for someone deciding whether to open the app, not for the changelog.
Internal names (`FloatingComments`, `slideshowCanvasAspect`) stay out of both.

---

## Google Play — "What's new" (≤500 chars)

```
Your story bar now shows what is happening across Laybell, not just the people you follow — so there is always something worth opening.

Songs look like songs in the feed: full-size cover art, the title cycling with its credits, and the best comments drifting up over the artwork.

Films get their own shelf on your profile, apart from your clips.

Plus a people-to-follow rail, tidier menus, and a long list of light-mode fixes.
```

---

## App Store — "What's New in This Version" (≤4000 chars)

```
STORIES WORTH OPENING

Your story bar used to show only the people you follow, which on a quiet day meant an empty row. It now also carries the most-watched stories from across Laybell — so there is something to open whether you follow two people or two hundred, and so a story you post can be found by someone who has not met you yet.

The rail is tighter, the circles have a little depth to them, and the bar sits at the top of the feed and scrolls with it rather than sticking to the header.

SONGS THAT LOOK LIKE SONGS

Music in the feed used to be a list row, which is right for a catalogue and forgettable between photos and video. Every third song now arrives as a full-width poster: the cover art at post size, the title cycling with its credits, and a few notes drifting up over the artwork.

The best comments on a track float up over the cover too — the person's photo, their name, and what they actually said, GIFs included. They are on the full-screen player and on reels as well, so a track carries the room reacting to it wherever you meet it.

FILMS HAVE THEIR OWN SHELF

Longer films on a profile no longer sit mixed into the same grid as twenty-second clips. They get their own section, as wide posters with the title and runtime on them — the way they already appear on Laybell TV.

SOMEONE TO FOLLOW

A little way into the feed you will now find a row of people worth following, each with the reason it is suggesting them: someone from your contacts, someone the people you follow already follow, someone near you, or simply someone popular right now.

SAVE YOUR OWN STORIES

You can save any story you posted straight to your camera roll, including ones that have already expired and moved to your archive.

MAIL FROM LAYBELL

You can now choose to hear from us about new features and artists worth knowing about — there is a checkbox when you sign up and a switch in Settings, and you can change your mind at any point. Account and security messages are separate and always sent.

A LOT OF SMALLER THINGS

Cropping one photo in a slideshow no longer re-crops the rest, so every picture in a post can be framed the way you want it.

Light mode got a real pass: the Diamond badge that was invisible against a pale background, the crop button that was black on black, the search field you could not read your own typing in, the timestamps in Messages that had faded almost to nothing, and the story progress bars that would not fill properly when you skipped ahead.

Messages sits closer to the edge of the screen, the search field lights up when you use it, and the tab you are on no longer looks like a black slab.

Editing your profile can no longer be swiped away by accident, and asks before it throws away changes you have not saved.
```

---

# Before you submit

Everything below is a manual step. The code is on `dev` and pushed; these are the
things a build alone does not do.

## Already done — do not repeat

- [x] **`email_marketing_optin.sql` applied to production** (2026-09-05). Adds
      `marketing_opt_in` + `marketing_opt_in_at`, rewrites `handle_new_user`,
      creates the `marketing_email_list` view. Verified: 13 accounts, all opted
      in, zero fabricated consent timestamps.
- [x] **`unsubscribe` Edge Function deployed** with `--no-verify-jwt`, and
      `UNSUBSCRIBE_SECRET` set. Tested live: forged token refused, valid token
      unsubscribes, RFC 8058 POST returns a bare 200, served as real
      `text/html`.
- [x] **Privacy Policy updated and LIVE** at laybell.app/privacy — §19 "Marketing
      Email", §18 corrected, dates moved to September 5 2026. The
      `deploy-legal` workflow published it on push to `dev`; no action needed.

## Store console — forms, not builds

These can be done today, before or after the build, and need no release.

- [ ] **App Store Connect → your app → App Privacy → Contact Info → Email
      Address.** It currently declares *App Functionality* only. Add
      **Developer's Marketing** as a purpose. Apple treats an inaccurate privacy
      label as grounds for rejection, and the marketing opt-in ships in this
      build.
- [ ] **Play Console → Data safety → Personal info → Email address.** Add the
      same purpose (**Marketing**). Play re-reviews the Data safety form
      separately from the APK, so a stale one can hold up a release that is
      otherwise fine.

## Build and submit

- [ ] **Bump the version to 1.0.2 in `app.json`.** The build number is handled
      for you — `eas.json` has `appVersionSource: remote` with `autoIncrement`,
      so do NOT hand-edit `buildNumber` or `versionCode`.
- [ ] **Build both platforms.** ⚠️ There is NO OTA on this project (no
      `expo-updates`), so production JavaScript is frozen at build time. All 48
      commits since `v1.0.1-build7` reach users only through this build.
- [ ] **Screenshots.** The feed, the story bar and the Messages list all changed
      visibly. `scripts/make-screenshots.ps1` regenerates the set; the captions
      in it are still in 1.0.1 order and will need rewriting for anything
      reshot.
- [ ] **App review notes.** 1.0.1's are in `docs/APP_REVIEW_NOTES_1.0.1.txt` and
      cap at 4000 characters. If the demo account or the walkthrough changed,
      write a 1.0.2 version — and hand reviewers the demo **email**
      (`3ddiemusic@gmail.com`), never the username: login takes email only.
- [ ] **Tag the release** once approved, matching `v1.0.1-build7`'s format.

## First send — not part of this release

Do not email anyone until these exist. See `docs/EMAIL_LIST.md`.

- [ ] Unsubscribe link **and the postal address** in every message.
      `scripts/unsubscribe-token.mjs` produces both the URL and the RFC 8058
      headers. Address: Laybell LLC, 28 Rivers Edge Ter, Indian Head, MD 20640.
- [ ] Send one to yourself, click the unsubscribe link, and confirm the Settings
      switch has flipped.
- [ ] Bounce and complaint handling (a Resend webhook flipping `marketing_opt_in`
      off) before any real volume — that is what protects the sending domain.

## Still open from before

- [ ] `expo-audio` bump for Play's foreground-service warning — **native, forces
      a prebuild**, so it needs a deliberate decision rather than being folded
      into a build.
- [ ] Play's 16 KB library alignment (has a future Play deadline), edge-to-edge
      deprecation, large-screen resizability.
- [ ] The Play listing still describes Laybell TV as turning sideways. It does
      not. Listing edit, not code.
