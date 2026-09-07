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

REMINDERS, IF YOU ASK FOR THEM

Laybell can tell you when a badge you have earned is about to lapse — naming the badge, in time to do something about it. Streak badges only, so it is the ones that took days to build rather than the ones you re-earn in a minute.

And if you have not opened Laybell in a while, a single notification: what you have earned, who followed you while you were away, or just that your listeners are still there. Never more than one every thirty days.

Both are off unless you turn them on. There is a box when you set up your profile and a switch in Settings under Notifications, and turning off All Notifications turns these off too.

MORE ROOM TO POST

The limit your badge puts on public posts now counts music and everything else separately. A Bronze badge that allowed six posts in total now allows six songs AND six of everything else, so putting up a photo no longer costs you a slot you were saving for a track.

A LOT OF SMALLER THINGS

Cropping one photo in a slideshow no longer re-crops the rest, so every picture in a post can be framed the way you want it.

Light mode got a real pass: the Diamond badge that was invisible against a pale background, the crop button that was black on black, the search field you could not read your own typing in, the timestamps in Messages that had faded almost to nothing, and the story progress bars that would not fill properly when you skipped ahead.

Messages sits closer to the edge of the screen, the search field lights up when you use it, and the tab you are on no longer looks like a black slab.

Editing your profile can no longer be swiped away by accident, and asks before it throws away changes you have not saved.

Setting up a broadcast, the fields you have selected now glow in the same colours as the Go Live button itself.
```

---

# STATUS — submitted 2026-09-06

**iOS `1.0.2 (9)` is SUBMITTED FOR REVIEW, set to AUTO-RELEASE.** Approval
publishes it to users with no further step, whenever that lands. Review notes,
What's New and the privacy labels were all entered before submitting.

**Android is NOT submitted.** The `.aab` for build 9 is built and waiting:
https://expo.dev/artifacts/eas/qGRpTAg9Uc7Sky5_sHdc9ELv-V6ZTzBOxLbMkbaLlRM.aab
`eas.json` is already wired for `eas submit --platform android` — it needs the
service-account key first, which is four minutes of console work in
`docs/PLAY_SERVICE_ACCOUNT.md`. It is configured as a DRAFT release, so even
after approval nothing reaches Play users until it is rolled out by hand.

Tag `v1.0.2-build9` once Apple approves, matching `v1.0.1-build7`.

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
- [x] **`reengagement.sql` applied to production** (2026-09-06). Adds the
      opt-in + cadence columns, the `system` notification type, `pg_net`, the
      daily `send-reengagement-nudges` cron at 17:00 UTC, and the two functions.
      **It is inert until this build ships**: `reengage_opt_in` defaults to
      false and nothing in the live 1.0.1 app can set it, so the job selects
      nobody. Verified 0 opted in, 0 due. Quiet period is **12 days**.
- [x] **`ehall1@ncat.edu` deleted** (2026-09-06). 14 → 13 accounts, ledger
      verified clean (0 violations, global sum 0).
- [x] **Verified ON THE DEVICE** (2026-09-06), not just in tests:
      - The Laybell notification row renders and its rows do not group.
      - A real push was delivered (`supabase/sql/_DEV_test_push.sql`) and a
        **COLD START** tap landed on the followers list. That was the case most
        at risk: the router is not ready at cold start, and the
        `useRootNavigationState` guard had never run on hardware.
      - The Settings toggle writes (`reengage_opt_in_at` stamped), and the
        asymmetry holds — All-notifications-off turns reminders off, turning it
        back on does NOT turn them on. That is the 4.5.4 requirement.
      - Test rows removed afterwards; the owner's account is left opted OUT.

- [x] **`live_notifications.sql` applied to production** (2026-09-06). Adds six
      tables to the `supabase_realtime` publication, the `live_started`
      notification type, and the go-live trigger.

      ⚠️ **The publication half is a FIX THAT IS ALREADY LIVE FOR 1.0.1 USERS.**
      The app subscribed to realtime on notifications, messages, comments,
      message_reactions and live_streams, and none of those tables published, so
      every one of those subscriptions was silently dead with no polling
      fallback — a DM did not appear until you left the thread and came back.
      Publishing them switched all of that on server-side, no build needed.
      RLS was verified enabled with SELECT policies on all six BEFORE publishing:
      realtime enforces RLS on postgres_changes, so publishing a table with RLS
      off would broadcast every row to every subscriber.

      Go-live trigger verified in a rolled-back transaction against the real
      follow graph: all 9 followers notified, host not self-notified, one
      batched push, three heartbeats added nothing (the guard that matters —
      live_streams updates every ~15s during a broadcast), and a restart inside
      two hours does not re-announce.

      Banner verified ON THE DEVICE: a real notification row written to the
      owner's account arrived as a banner through realtime. Test rows removed.

      **Purchases are deliberately NOT bannered.** Telling someone's followers
      what they bought exposes their spending. If it is ever wanted it needs its
      own opt-in and its own consent language.

      **Still unverified on hardware:** the "someone you follow posted" banner
      (needs a second account posting while you watch).

      **Still verified in logic only:** the badge-lapse reminder. 34 assertions
      against the real compiled rule code, but it has never fired on a phone —
      triggering it needs a held streak AND a skipped day. Local notification,
      no server dependency, so the blast radius is small.

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
- [ ] **Both consoles → App activity / Usage data.** The re-engagement reminder
      reads when an account was last seen and sends a promotional push off it,
      so **Marketing** belongs on that purpose too, not just on the email
      address. Same reasoning as the two rows above: the label has to match what
      the build actually does.

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
- [ ] **Say where the reminder opt-in is, in the review notes.** Guideline 4.5.4
      is the one this feature lives under, and a reviewer who does not find the
      consent will assume there is none. Two lines is enough: the unticked box
      on the profile-setup step, and Settings → Notifications → "Reminders when
      you're away", which is also the opt-out. Point at both.
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

## First reminders — after the build is live

Nothing fires until someone opts in, and nobody can opt in until this build
ships. Then, roughly three weeks later, the first ones become possible.

- [ ] **Look before it sends.** `select * from public.reengagement_due();` is
      read-only and shows exactly who would be nudged and with what. Run it once
      the first accounts pass three weeks of silence, and read the messages.
- [ ] **Check the job's outcome, not its status.** The lesson from the deletion
      sweep: an exception handler had pg_cron reporting success hourly while
      deleting nothing. What matters is `select count(*) from notifications
      where type = 'system'` going up, and `net._http_response` returning 200
      with Expo tickets that are not `DeviceNotRegistered`.
- [ ] **Prune dead push tokens.** Expo answers `DeviceNotRegistered` for a token
      whose app was deleted. Nothing reads those responses yet, so the tokens
      stay and every run re-sends to them. Harmless at 8 tokens, worth fixing
      before it is thousands.
- [ ] **Watch the badge reminder for nagginess.** It is a LOCAL notification
      scheduled by the app (see `lib/badgeRisk.ts`) at 20:00 UTC — 4pm Eastern —
      and only for streak badges, so someone with no streak never sees one. If
      it turns out to fire more than feels right, the lever is
      `STREAK_BADGE_KEYS` in `lib/badges.ts`, not the timing.

## Still open from before

- [x] ~~`expo-audio` bump for Play's foreground-service warning~~ — **investigated
      2026-09-06: THERE IS NO BUMP TO DO, and doing one would break the app.**
      - `expo-audio@~1.1.1` resolves to **1.1.1**, which is what is installed and
        the newest *stable* release in that line. Everything above it on npm is
        either a `1.1.x` canary or `58.0.0`, a different major for a much later
        SDK. `npx expo install --check` does not list expo-audio at all.
      - The concern behind the item is already satisfied. expo-audio 1.1.1 ships
        `FOREGROUND_SERVICE_MEDIA_PLAYBACK` and types **both** its services
        (`mediaPlayback`, `microphone`) in its own manifest, which merges into
        the build.
      - Audited every `AndroidManifest.xml` in `node_modules`: no dependency
        declares an untyped foreground service. (`expo-notifications`'
        `ExpoFirebaseMessagingService` has no type because it is a
        `FirebaseMessagingService`, not a foreground service — correct as is.)
      - The `FOREGROUND_SERVICE` line in `app.json` is fine. **Permissions do not
        have types — services do**, which is what the old checklist entry at
        `LAUNCH_CHECKLIST.md` §2138 got wrong.
      - One real gap, currently unreachable: expo-audio types `AudioRecordingService`
        as `microphone` but declares no `FOREGROUND_SERVICE_MICROPHONE`
        permission, which would throw on Android 14+. That service only starts
        when `allowsBackgroundRecording` is true, and this app never sets it
        (`useForegroundService` defaults false; the only recording call is
        `app/(tabs)/post.tsx:957`). **If background recording is ever turned on,
        that permission has to be added to `app.json` first.**
- [ ] Play's 16 KB library alignment (has a future Play deadline), edge-to-edge
      deprecation, large-screen resizability.
- [ ] **Give the realtime screens a slow poll.** The six tables now publish, so
      DMs, comments, the unread badge and the live rail update live again — but
      they depend on the publication ALONE. If it is ever lost, or a fresh
      database is stood up without `live_notifications.sql`, they go silent with
      no symptom, which is exactly how this went unnoticed through 1.0.1. The
      standing rule (see the realtime memory) is to pair every publication fix
      with a poll; that half is still owed.
- [ ] **In-app video recorder + editor ("like TikTok")** — deferred 2026-09-06 to a
      later update. Survey in `docs/VIDEO_EDITOR_PLAN.md`: recording and trimming
      already work (react-native-video-trim is a native module ALREADY in the
      binary), everything else needs re-encoding, and ffmpeg-kit was retired
      2026-07-02. There is a no-new-native path — overlays as a recipe rendered
      at playback — with one real trade-off written up there.
- [ ] The Play listing still describes Laybell TV as turning sideways. It does
      not. Listing edit, not code.
