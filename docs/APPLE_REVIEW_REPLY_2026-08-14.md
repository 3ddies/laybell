# Apple review reply — Guideline 2.1 "Information Needed" (2026-08-14)

**Submission `9ea62a08-6a04-4c0a-b261-7e840a1a9f70` · `1.0.0 (4)` · rejected 08-14 02:09.**

**This is not a defect.** Apple did not report a crash, a broken feature, or a policy
violation. The message is titled *"Information Needed — New App Submission"*: the standard
questionnaire a first-time app gets. **No code change, no rebuild, no new build number.**
The deliverables are one screen recording and one written reply.

⚠️ **The reply is answered by REPLYING, not resubmitting.** Use **"Reply to App Review"** at
the bottom of the message thread. "Resubmit to App Review" is greyed out and is not the path
— nothing needs editing.

---

## 0. ~~FIX THIS BEFORE YOU REPLY~~ ✅ CLEARED 2026-08-14

`STORE_LISTING.md` §3 had warned since 2026-08-10 that `laybellreview` had **0 shop
listings** while the review notes promised the reviewer one — the exact dead end that earns a
second, deserved 2.1 rejection, on that doc's own rule that *a reviewer who cannot reach a
feature assumes it does not work.*

**The owner published a listing from `laybellreview` plus two others on 2026-08-14.** The
shop claim in the notes below is now true. Credits (~$482) and both subscription tiers were
already active on that account.

*(Note for later, not now: the fresh-start reset keeps **only** `laybellreview` and its
content. Any of those listings posted from other accounts will not survive it, so the Shop
will be sparser at launch than it is during review. That is expected and is not a defect.)*

---

## 1. The screen recording (Apple's item 1)

**Requirements Apple stated:** a physical device, running the latest OS, and **the recording
must begin with launching the app.** Not a simulator, not a montage that starts mid-flow.

### The email-address problem is solved

The recording has to show **account registration**, which needs a fresh address — and you
have run out. **Use Gmail plus-addressing:** `3ddiehall+review1@gmail.com` delivers to your
normal inbox, is a real deliverable address, and Supabase treats it as distinct. You already
proved this works — the Apple sandbox tester is `3ddiehall+sandbox@gmail.com`.

This also unblocks the **parent-consent end-to-end test** that Phase 2 flagged as possibly
impossible. Use `+minor1` and `+guardian1`.

### Format, length, editing

- **A plain iOS screen recording** (Control Center). Physical device on the latest iOS. Not a
  simulator, and not the phone filmed with a second camera.
- **Turn the Microphone ON** — long-press the record button first. Narrating each screen is
  the cheapest possible quality upgrade and answers half of Apple's questions out loud.
- **No length limit.** 8–12 minutes is normal here. Coverage beats brevity.
- **Do not edit.** No music, no transitions, no effects, no speed-up. This is evidence, not
  marketing, and **a cut inside a flow reads as something being hidden.** Trim dead air at
  the head and tail only.
- **Delivery:** attach it to the reply if it fits; otherwise put it on an unlisted YouTube or
  Drive link and paste the URL in the reply. Both are accepted.

### Before you press record

- **Do Not Disturb ON** — a notification banner mid-recording means a re-take.
- **Good Wi-Fi.** The Android clip that cost a day of diagnosis was shot on bad wifi.
- 🚨 **Sandbox account signed in BEFORE you record** — Settings → App Store → scroll to the
  bottom → **Sandbox Account** → `3ddiehall+sandbox@gmail.com` / `Eddie123$`.
  **This bit the first take on 2026-08-14.** With the slot empty, iOS falls back to the
  device's real Apple Account and the purchase sheet demands the owner's **personal Apple ID
  password — on camera.** Refusing was correct; the answer is to fill the slot, not to type
  it. The sandbox slot is independent of the real Apple ID, signs you out of nothing, and
  sandbox purchases never charge a card.
- 🚨 **Register as 18 or over.** Under-18 accounts have livestream broadcasting blocked and
  location capture disabled by design — film one of those and the reviewer sees a crippled
  app and asks why.

### Shot list — ONE continuous take, one throwaway account

Apple named four things explicitly; all four are marked 🎯 and all four must be on camera.
The order below does everything on a single fresh account so there is no signing in and out
mid-take, and it ends on deletion, which is where deletion naturally belongs.

1. **Cold launch** from the home screen. Do not start recording on an already-open app.
2. 🎯 **Registration** — sign up with `3ddiehall+review1@gmail.com`, through the age step
   (**18+**), username, and the About-you onboarding step.
3. 🎯 **Permission prompts as they appear** — camera, microphone, photos, contacts, location.
   Let each dialog sit for a beat so the purpose string is readable, and say what it is for.
   *(No App Tracking Transparency prompt exists — Laybell does not track across apps and ad
   personalisation is opt-in and off by default. Say so aloud, or Apple wonders why it never
   appeared.)*
4. **Browse** — the feed, play a music post, play a video post, a profile, Explore, Music.
5. **Create a post** — the user-generated content Apple asks about.
6. 🎯 **Report a post, then block a user.** Apple names "content reporting and blocking
   mechanisms" directly. **This is the most commonly missed item in a 2.1 reply.**
   Block one of the other test accounts — *never* `laybellreview`.
7. 🎯 **The IAP flow** — Settings → Credits, show the packs and prices, and complete one
   sandbox purchase so the flow is proven end to end. Then Settings → Promotion Tools → the
   Premium card: show **title, length, price** and the Terms and Privacy links, and buy a
   tier in sandbox.
8. **Paid content, now unlocked** — Films, via rotating the device or the TV entry beside the
   home logo. Buying it on camera is stronger than showing a pre-entitled account.
9. **The Shop** — open the listing published from `laybellreview` and buy it with credits.
10. **A livestream** — the LIVE button beside the home logo. Start one, then end it.
11. 🎯 **Account deletion** — Settings → Account → delete.
    🚨 **Delete the THROWAWAY account, never `laybellreview`** — Apple still needs those
    credentials to work.
12. **Optional but worth it:** sign in as `laybellreview` to prove the credentials handed to
    Apple actually work. Ten seconds, removes a whole category of doubt.

---

## 2. The written reply — paste this into "Reply to App Review"

> Fill the three bracketed placeholders before sending. Everything else is verified against
> the repo as of 2026-08-14.

```
Thank you for the review. A screen recording is attached, captured on a physical device and
beginning with a cold launch of the app. Answers to each item follow in order.

2. DEVICES AND OPERATING SYSTEMS TESTED
[FILL IN: e.g. iPhone 15 Pro on iOS 18.x and iPhone 12 on iOS 18.x — list the physical
iPhones and iOS versions you used for TestFlight testing.]
The build was also distributed through TestFlight and smoke-tested on device, including a
live broadcast.

3. WHAT THE APP DOES, AND FOR WHOM
Laybell is a music-focused social platform for independent artists and the people who
listen to them.

The problem it solves: general-purpose social apps treat music as an attachment. An
independent artist posting a song there loses the credits, cannot sell anything, and has no
way to be paid by the people who actually listen. Laybell is built around the track instead
of around the post.

Target audience: independent musicians, producers and beatmakers, and their listeners.
Rated 13+.

Core features: posting music, video, photo slideshows and 24-hour stories; collaborator
credits on tracks; live audio and video broadcasting; a shop for selling beats and songs;
direct creator support through tips; playlists; and communities.

4. SETTING UP AND ACCESSING THE APP
Sign-in is required for all features.

Demo account
Username: laybellreview
Password: [FILL IN]

This account is pre-loaded with posts, a credit balance, and both subscription tiers active,
so every paid feature — including Films, the ad-free experience, and offline downloads — is
reachable without making a purchase.

To test in-app purchases without a charge, sign in to a sandbox Apple Account under
Settings > App Store > Sandbox Account before opening a purchase sheet.

No sample files are required. Posting uses media already on the device.

5. EXTERNAL SERVICES USED FOR CORE FUNCTIONALITY
- Supabase — authentication, PostgreSQL database, and file storage
- RevenueCat — in-app purchase and subscription entitlement management
- Cloudflare Stream — video hosting, transcoding, and live stream ingest and playback
- LiveKit — real-time audio for collaborative studio sessions
- Stripe Connect — creator payouts to bank accounts (money out only; Stripe is never used
  to sell digital content, which is exclusively In-App Purchase)
- Resend — transactional email for parental-consent verification
- Google Cloud Translation — optional machine translation of user-typed text
- Tenor — GIF search in comments and messages
- Expo / EAS — application build and push notification delivery

The app does not use any AI services. There is no generative model, recommendation model, or
third-party AI provider in the product.

6. REGIONAL DIFFERENCES
There are none. Version 1.0 is available in the United States only, and the app functions
identically for every user in that region. There is no region-gated content, no region-gated
feature, and no regional pricing difference beyond Apple's own storefront handling.

7. REGULATED INDUSTRY AND PROTECTED THIRD-PARTY MATERIAL
Laybell does not license, host, or distribute a commercial music catalogue. There is no
licensed library to browse. All audio is uploaded by users, who warrant on upload that they
own or control the rights to it.

For the public performance of music on the platform, Laybell LLC additionally holds:
- A BMI licence, executed 2026-07-28
- An ASCAP Website & Mobile App licence, purchased 2026-08-02, term 08/01/2026 to 07/31/2027

Rights enforcement: a DMCA agent is registered with the U.S. Copyright Office, and a
repeat-infringer termination policy is published in the Terms of Service and enforced.

The app is not otherwise in a regulated industry. It offers no health, financial, gambling,
or age-restricted-goods functionality. Creator payouts are processed by Stripe, which is the
regulated party and performs its own identity verification before any payout is enabled.

8. IN-APP PURCHASES AND WHERE TO FIND THEM
Consumable credit packs — $4.99, $9.99, $19.99, $49.99 and $99.99.
Navigate to: Settings > Credits ("Buy credits for tips and the Shop").
Credits are spent inside the app on tips to creators, Shop purchases, and promoting a post.
Credits cannot be converted back into money and cannot be transferred between users.

Auto-renewable subscriptions — Laybell Premium at $9.99/month and Laybell Premium+ at
$19.99/month, in a single subscription group.
Navigate to: Settings > Promotion Tools > the Laybell Premium card.
Premium+ is the higher service level and adds Films (landscape video up to one hour),
removal of all advertising, and unlimited offline downloads. Title, length and price are
shown on the purchase sheet, alongside links to the Terms of Use and Privacy Policy.

Creator earnings are a separate balance from credits. They are paid out by bank transfer
through Stripe and are never redeemable as credits or as App Store currency.

ADDITIONAL CONTEXT

User-generated content (Guideline 1.2) — all four required protections are implemented:
automated filtering of objectionable terms on captions and comments; in-app reporting on
every post, profile, comment and message; blocking, which removes the blocked user's content
and prevents contact; and published contact information in the app and at laybell.app.

Minors — users under 18 are identified at signup. For them the app disables location
capture, disables targeted advertising, defaults posts to friends-only, restricts incoming
direct messages to accounts they follow, blocks livestream broadcasting, and hides any post
or story marked mature. The messaging restriction and the mature-content gate are enforced
server-side in the database, not only in the interface.

Tracking — the app does not track users across other companies' apps or websites, so no App
Tracking Transparency prompt appears. Ad personalisation is opt-in and off by default.

Livestreaming — our streaming provider serves live playback out of its recording pipeline,
so a broadcast is necessarily recorded while it is live. That recording is deleted
automatically when the broadcast ends. No replay is retained, published, or offered for
download.

Contact: [FILL IN: support email]
```

---

## 3. After you send it

**Paste the same text into App Store Connect → App Review Information → Notes.** Apple asked
for this directly — *"Include this information in the Notes field … for future submissions"* —
and doing it means version 1.1 never gets asked again.

**Timeline.** No rebuild is needed, so the only cost is the recording plus a review cycle.
Reply the same day and Sept 1 stays comfortable. The Phase 1 work (fresh-start reset) stays
**blocked** until this clears — the app is back in review, and `FRESH_START_RESET.md`
forbids resetting mid-review.
