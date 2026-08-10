# Store listing — copy-paste fields

Everything App Store Connect and Play Console will ask for, written out. Nothing
here needs a build; you can fill all of it in today.

Character limits are enforced by the stores and are **counted after** each block
below. Verify anything you edit with:

```bash
node scripts/check-listing.mjs
```

---

## 1. App Store Connect

### App Name — max 30

```
Laybell: Music & Creators
```

`Laybell` alone would work, but the name field is the single heaviest ASO signal
Apple has, and nobody is searching for a brand they've never heard of. The two
extra words are what make you findable at all on day one.

**Alternatives** (all within 30): `Laybell — Music Community` ·
`Laybell: Beats & Livestreams` · `Laybell: Indie Music`

### Subtitle — max 30

```
Make music. Find your people.
```

**Alternatives:** `Where artists build audiences` · `Beats, livestreams, fans`

### Promotional Text — max 170

Updatable **without** a review, so this is your announcement slot. Change it
freely for launches and features.

```
New: Films — post landscape video up to an hour and get your own shelf on Laybell TV. Plus sell beats from your profile, go live, and get tipped for the work.
```

### Keywords — max 100 characters total

Comma-separated, **no spaces after commas** (a space costs you a character).
Don't repeat words already in the name or subtitle — Apple indexes those
separately, so repeating wastes the field.

```
beats,producer,rapper,singer,songwriter,indie,studio,livestream,fans,tips,collab,podcast,films
```

### Description — max 4000

```
Laybell is where independent artists build a real audience.

Post your music. Go live. Sell your beats. Get paid by the people who actually listen.

MADE FOR MUSIC, NOT REPURPOSED FOR IT
Upload songs, podcasts and audiobooks with real cover art and credits. Tag the producers, writers and features who worked on it — they get credited on the track, with a link back to their profile.

SHARE HOWEVER YOU WANT
Songs, videos, photo slideshows, and 24-hour stories. Attach another artist's track to your video and they get credited automatically. Shoot vertical or go full cinematic landscape — rotate your phone and the whole feed follows.

GO LIVE
Broadcast to your followers from your phone, or run a listening session from the studio with real vocal presets. Fans can tip you live, and everyone in the room sees it. Cast the whole thing to your TV.

LAYBELL TV AND FILMS
Turn your phone sideways for a full landscape feed built for watching, not scrolling. Films sit on their own shelf — full-length work up to an hour, from creators who make more than clips. Cast any of it to your TV.

SELL YOUR WORK
List beats and songs on your own storefront. Sell them outright, lease them, or give them away to fans who follow you. Buyers get the files instantly.

GET PAID
Fans can tip you directly. Your earnings, your shop sales and your payout details all live in one wallet.

BUILD SOMETHING TOGETHER
Genre communities with their own tags and moderators. Public playlists that credit the curator. Group chats. Friends are mutual follows, so your private posts stay with the people you actually know.

IN YOUR LANGUAGE
The whole app runs in 10 languages, and you can translate any comment, caption or message with one tap.

PREMIUM
Laybell Premium is optional. It gets you an ad-free feed, a bigger share of every tip, custom ordering on your music, deeper follower insights, half the ads in Reels and Music, and a monthly spotlight boost.

Laybell Premium+ adds Films — landscape videos up to an hour, with their own shelf on Laybell TV — plus no ads anywhere in the app, unlimited offline downloads, and badges that hold while you're subscribed.

Auto-renewing subscriptions. Laybell Premium is $9.99/month and Laybell Premium+ is $19.99/month, charged to your Apple ID at confirmation of purchase. Either renews automatically unless cancelled at least 24 hours before the end of the current period. Manage or cancel in your Apple ID account settings.

Terms of Use: https://laybell.app/terms.html
Privacy Policy: https://laybell.app/privacy.html

Laybell is built by one person who thinks independent artists deserve better tools than a repost button.
```

> **The subscription block is not optional.** Guideline 3.1.2 requires the
> length, the price, the renewal terms and functional links to your Terms and
> Privacy Policy wherever an auto-renewable subscription is offered. Apps get
> rejected for omitting it more often than for almost anything else in metadata.
> Update the price here if it ever changes.

### What's New — max 4000 (first release)

```
Laybell is live.

Post your music, go live to your fans, sell your beats, and get tipped for the work — all in one place, built for independent artists.
```

### URLs

| Field | Value | Required? |
|---|---|---|
| Privacy Policy URL | `https://laybell.app/privacy.html` | **Required** |
| Support URL | `https://laybell.app/` (needs a visible contact route) | **Required** |
| Marketing URL | `https://laybell.app/` | Optional |

> Support URL is checked by a human. A page with no way to reach you is a
> rejection. An email address on the page is enough.

### Categories

- **Primary: Music** — less competitive than Social Networking, and it's what
  the app actually is.
- **Secondary: Social Networking**

---

## 2. Age rating questionnaire

Apple **computes** the tier from your answers; you don't pick it. Answer
honestly — a rating that's too low is a rejection, and a rating that's too high
quietly costs you the teen audience the app was designed for.

> ⚠️ Apple expanded the age tiers in 2025 (adding 13+ and 16+ between the old
> 12+ and 17+). Read the questions as presented to you rather than trusting the
> tier names here.

| Question | Answer | Why |
|---|---|---|
| Cartoon or Fantasy Violence | None | |
| Realistic Violence | None | |
| Prolonged Graphic or Sadistic Realistic Violence | None | |
| Profanity or Crude Humor | **Infrequent/Mild** | Music lyrics. Don't answer None — explicit lyrics are inevitable on a music platform. |
| Mature/Suggestive Themes | **Infrequent/Mild** | Same reason. |
| Horror/Fear Themes | None | |
| Medical/Treatment Information | None | |
| Alcohol, Tobacco, or Drug Use or References | **Infrequent/Mild** | Lyrical references. |
| Simulated Gambling | None | Tips and credits are not gambling — there's no wager and no chance-based outcome. |
| Sexual Content or Nudity | None | Prohibited by your guidelines and filtered. |
| Graphic Sexual Content and Nudity | None | |
| Contests | None | |
| Unrestricted Web Access | **See note** | |
| Made for Kids | **No** | |

**On "Unrestricted Web Access":** the app opens external links in the system
browser (`expo-web-browser`), behind the "leaving Laybell" interstitial — it does
not embed a freely-navigable browser. The honest answer is therefore **No**. But
the studio's web connector loads a page inside the app, so if that surface can
navigate anywhere, the answer flips to Yes. **Check that before you submit** —
answering No when a WebView can reach arbitrary URLs is the kind of thing that
gets caught on a later review, not the first one.

**On user-generated content:** Apple doesn't rate UGC through this
questionnaire; it enforces it through Guideline 1.2, which requires four things.
You have all four — say so in the review notes:

1. A method for filtering objectionable material → `lib/contentFilter.ts`
2. A mechanism to report offensive content → post/profile reporting
3. The ability to block abusive users → blocks
4. Published contact information → in the listing and the app

---

## 3. App Review Information — the most important box you'll fill in

Laybell has a lot of surface area, most of it behind a login. A reviewer who
can't reach a feature assumes it doesn't work.

**Demo account: required.** Create a real account, seed it with a few posts, a
shop listing, and some credits, and hand over working credentials.

**Notes field:**

```
Laybell is a music-focused social platform for independent artists.

DEMO ACCOUNT
Username: laybellreview
Password: [fill in]
This account has posts, a shop listing, and a credit balance already loaded, and both subscription tiers are active on it, so every feature — including Films and the ad-free experience — is reachable without making a purchase.

USER-GENERATED CONTENT (Guideline 1.2)
All four required protections are implemented:
- Automated filtering of objectionable terms on post captions and comments
- In-app reporting on every post, profile, comment and message
- Blocking, which removes the blocked user's content and prevents contact
- Contact information published in the app and on laybell.app

MINORS
Users under 18 are identified at signup. For them the app disables location capture, disables targeted advertising, defaults posts to friends-only, restricts incoming direct messages to accounts they follow, and blocks livestream broadcasting. The messaging restriction is enforced server-side in the database, not only in the UI.

PURCHASES (Guideline 3.1.1)
All digital purchases use In-App Purchase. Users buy credits, and credits are spent on tips, shop purchases and promotion. Credits cannot be converted back to money and cannot be transferred between users. Creator earnings are a separate balance, paid out by bank transfer via Stripe, and are never redeemable as credits.

SUBSCRIPTION
Two auto-renewing tiers in one subscription group: Laybell Premium at $9.99/month and Laybell Premium+ at $19.99/month. Premium+ is the higher service level and adds Films (landscape video up to one hour), no advertising anywhere in the app, and unlimited offline downloads. Terms and Privacy Policy links are in the app description and inside the app before purchase.

FILMS
Films are landscape videos longer than nine minutes, available to Premium+ subscribers and shown on their own shelf inside Laybell TV (turn the device sideways, or use the TV entry beside the home logo). The demo account has Premium+ active, so this is reachable without a purchase.

LIVESTREAMING
The LIVE button sits next to the home logo. The demo account can start a broadcast. Streams are recorded only if the broadcaster opts in.

MUSIC LICENSING
Content is uploaded by users, who warrant they hold the rights. Laybell additionally holds BMI and ASCAP public performance licences. A registered DMCA agent and a repeat-infringer termination policy are in place.

CONTACT
[your email]
```

---

## 4. Screenshots

Required at minimum: **6.9" iPhone** (1320×2868). Apple scales that down for
smaller devices, so one set covers all iPhones. Add **13" iPad** (2064×2752)
only if you're shipping iPad support.

Up to 10 per size. The first two are the only ones most people see — they show
in search results without anyone tapping through.

Suggested order — the first two carry the whole listing, so they lead with what
Laybell has that a generic social app does not:
1. The feed, with real music posts — this is the product
2. **Laybell TV in landscape, Films shelf visible** — the clearest "this is not
   another short-video app" shot in the whole product
3. Going live, with tips visible
4. A profile with the shop button
5. The shop listing screen
6. Studio / listening session
7. Communities
8. Wallet and earnings

Shoot #2 in landscape and let it fill the frame; a portrait screenshot of a
landscape feature undersells it.

Text overlays on screenshots consistently outperform bare captures. Keep them
short enough to read at thumbnail size.

**Caption overlays — one per shot, in the order above.** Each is a plain
statement of what the screen does; none of them oversell, because the screenshot
is right there and a caption the picture contradicts costs more trust than it
buys.

| # | Overlay text | Reads as |
|---|---|---|
| 1 | `Music first. Not an afterthought.` | the whole positioning, in four words |
| 2 | `Turn it sideways for Films.` | tells them the shot is landscape ON PURPOSE |
| 3 | `Go live. Get tipped in real time.` | |
| 4 | `Your profile is your storefront.` | |
| 5 | `Sell beats. Buyers get the files instantly.` | |
| 6 | `Run a session. Bring an audience.` | |
| 7 | `Communities that stay about the music.` | |
| 8 | `Your earnings, in one wallet.` | |

Keep every overlay in the SAME position, weight and size across all eight — a
caption that moves between frames reads as amateur even when each frame is
good. Top third is safest: the phone's own status bar sits above it and the
app's content usually starts below.

**Shoot these on the demo account** (`laybellreview`): it carries both
subscription tiers, so the ad-free feed and the Films shelf are both real there,
and nothing in frame will be an upsell wall.

---

## 5. Google Play

### App name — max 30

```
Laybell: Music & Creators
```

### Short description — max 80

```
Post your music, go live, sell beats, and get paid by the fans who listen.
```

### Full description (max 4000 — not checked here, it's assembled from the block above)

The App Store description above works, with two changes:

1. Replace the Apple subscription block with:
   ```
   Auto-renewing subscriptions. Laybell Premium is $9.99/month and Laybell Premium+ is $19.99/month, charged to your Google Play account. Either renews automatically unless cancelled at least 24 hours before the end of the current period. Manage or cancel in Google Play subscription settings.
   ```
2. Play indexes the full description for search, so keywords belong in the prose
   here rather than in a separate field — Play has no keywords field.

### Graphics

| Asset | Size | Required? |
|---|---|---|
| App icon | 512×512 PNG | **Required** |
| Feature graphic | 1024×500 | **Required** |
| Phone screenshots | min 2, 16:9 or 9:16 | **Required** |

### Content rating

Play uses the IARC questionnaire, which is separate from Apple's and produces
ESRB/PEGI ratings. Answer it consistently with the Apple answers above. It asks
additionally about **user interaction** — say yes to users interacting, sharing
location (coarse only), and digital purchases.

### Data safety

Answers are in [STORE_PRIVACY_LABELS.md](STORE_PRIVACY_LABELS.md), derived from
the actual code rather than from memory.

---

## 6. Before you hit submit

- [ ] Demo account created, seeded, and credentials pasted into the review notes
- [ ] `node scripts/set-store-ids.mjs --check` passes
- [ ] `laybell.app/privacy.html` and `/terms.html` load — reviewers click these
- [ ] Support URL shows a way to contact you
- [ ] Subscription block present in the description, price correct
- [ ] Confirmed whether the studio WebView can navigate freely → answers the
      "Unrestricted Web Access" question
- [ ] Privacy labels match [STORE_PRIVACY_LABELS.md](STORE_PRIVACY_LABELS.md)
- [ ] Export compliance: `ITSAppUsesNonExemptEncryption` is already `false` in
      `app.json`, so Apple won't ask
