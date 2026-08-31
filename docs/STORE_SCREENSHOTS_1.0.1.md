# Store screenshots — the 1.0.1 re-shoot

The framing pipeline is fine and stays: `scripts/make-screenshots.ps1` turns raw
phone captures into all three size sets. What has to change is **what is in the
captures**, and the honest diagnosis is that the current eight were shot on test
data.

## What is actually wrong with the current set

Read from the shipped frames, not from memory:

- **Frame 1** — the story ring is a photo of a cat, the first post is
  `@laybellreview` with a placeholder "L" avatar, the song is
  *"The ABC song for Laybe…"* truncated mid-word, and the video below it is a
  dark tent at night. Top third of the phone is near-empty. This is the frame
  most people will ever see of Laybell.
- **Frame 5** — the shop listing is *"Tow truck jam"*, described as
  *"This is a beat of my car getting towed"*, sold by "Observer" with a photo of
  a bear, over a night shot of a parking lot.
- **Status bar** — 6:26 / 6:40 with a nearly flat battery, in every shot.
- **The background** — the red→orange gradient is the loudest thing in the frame
  and it competes with the orange still inside the UI. It also no longer matches
  an app that spent this whole cycle moving orange onto terminal actions only.

None of that is a bug. It is what happens when the shots are taken to prove the
pipeline works rather than to sell the app, and it is worth fixing precisely
because the app underneath is now good.

## What has to be true before a single capture

1. **Sign in as `@3ddie`, not `@laybellreview`.** The old note said to shoot on
   the review account because it carries both tiers. That was right when the
   catalogue was empty; it is wrong now. `@3ddie` has the real avatar, a real
   album (*Short Dreams*, 7 tracks), real artwork and real music videos. If a
   tier gate blocks a shot, switch for that shot only.
2. **Charge the phone past 80%** and take the shots near the top of an hour.
   Both are visible in every frame and both read as care.
3. **Turn on Do Not Disturb.** A notification banner in a store screenshot is an
   automatic reshoot.
4. **Pick the theme per shot, not per set.** Dark for the immersive player, the
   reel and Laybell TV; light for the profile and the composer. A set that shows
   both says the app has both.
5. **Nothing truncated.** If a title ellipsises in frame, scroll or pick another
   post. A cut-off word in the hero shot reads as a bug in the app.

## The eight frames, in order

The first two carry the listing — they appear in search results without anyone
tapping through. They lead with what a generic social app cannot show.

| # | Shot | Caption |
|---|------|---------|
| 1 | **Profile → Music tab**: Featured card, Albums shelf, Singles beneath | `Albums, singles, and what to hear first.` |
| 2 | **Laybell TV**, Films shelf visible — PORTRAIT (see below) | `A whole shelf of films.` |
| 3 | **Feed with a music video**: rotating title showing the song credit, artwork in the corner | `Real songs. Not fifteen-second clips.` |
| 4 | **Immersive player**: full-bleed artwork, scrubber | `A player built for listening.` |
| 5 | **Live**, with a tip landing | `Go live. Get tipped in real time.` |
| 6 | **Shop listing** — a real beat with real artwork and a real price | `Sell beats. Buyers get the files instantly.` |
| 7 | **Wallet**, with a non-zero balance | `Your earnings, in one wallet.` |
| 8 | **An album screen** — *Short Dreams*, cover art, numbered running order | `A real catalogue, not a feed.` |

Communities was dropped from the set (owner, 2026-08-30): it is not appealing
enough to spend a slot on. The album screen replaces it and is the better
argument anyway — frame 1 shows the album SHELF, and this shows what is behind
it, which together is the deepest proof in the app that this is an artist
platform rather than a feed with audio bolted on.

Frame 1 changed from the feed to the profile Music tab deliberately. The feed is
what every social app opens on and it is the frame that says the least; the
Music tab with Featured, an album and singles is the one screen no other social
app in the category can produce.

⚠️ **LAYBELL TV DOES NOT ROTATE, and the 1.0.0 instruction to "turn it sideways
for Films" was simply wrong.** `app/tv/index.tsx` contains no orientation
handling whatsoever — the word "landscape" appears in it only to describe the
SHAPE of the video tiles. The three screens that actually rotate are the reel
viewer (`app/reel/[id].tsx`, which flips to a fullscreen horizontal pager on a
landscape video) and the two live screens.

So frame 2 is Laybell TV in PORTRAIT. The argument it makes is that a shelf of
films exists at all, which is structurally different from a feed — the rotation
was never the point, and a caption promising one the screen cannot perform is
worse than no caption.

If a landscape frame is still wanted for variety in a gallery of portrait ones,
the honest source is the reel viewer rotated on an actual FILM. A rotated clip
of something else is a landscape video, not the Films feature.

## Where the reshoot stands (2026-08-30)

First pass captured. Two are keepers, the rest need another go.

- ✅ **Immersive player** ("The lite") — dark, full-bleed, use it.
- ✅ **Feed** (dark, Comeback Szn / Boba) — the best of the set. Real music
  videos, real titles, dense with product.
- ⚠️ **Wallet** — caught the pre-correction figure: `$231.31 from tips` against a
  `$456.00` headline, which does not add up. Re-apply `_DEMO_wallet_456.sql`
  and reshoot.
- ⚠️ **Profile** — shot on the POSTS tab. Frame 1 wants the MUSIC tab: Featured
  card, Albums shelf, Singles.
- ⚠️ **Shop** — still "Begging cat type beat", a photo of a cat, described as
  "This is just a smaple test". Same failure as "Tow truck jam" in the 1.0.0
  set, typo included. Post one real listing with real artwork first.
- ⚠️ **Landscape** — a cow video in the reel viewer, not Laybell TV with the
  Films shelf. A landscape REEL undersells the feature the shot exists for.
- ⏳ **Live + tip** — @laybell holds $100 of demo credits and can send the $80
  tip whenever. Clean up with `_DEMO_live_tip_CLEANUP.sql` after.

## Background

`make-screenshots.ps1` now takes `-Bg`, with previews:

```bash
powershell -ExecutionPolicy Bypass -File scripts/make-screenshots.ps1 -Bg paper -PreviewCount 2
```

- `brand` — the current red→orange
- `ember` — burnt orange into charcoal; brand-adjacent, stops shouting
- `graphite` — warm near-black; matches the app, risks reading as one dark blob
  at tile size
- `paper` — the light theme's off-white with dark caption ink; the highest
  contrast against a dark-UI capture, so it pops hardest in a results grid

Preview frames land in `store/screenshots/preview/<scheme>/` and are not
uploaded. Once a scheme is chosen, run without `-PreviewCount` to build all
three size sets, then change the default in the `param()` block so nobody has to
remember the flag.

## Running it

```bash
powershell -ExecutionPolicy Bypass -File scripts/make-screenshots.ps1
```

Raw captures go in `store/screenshots/raw/` named `01.png` … `08.png` in the
order above. Output:

- `store/screenshots/appstore/` → 1320×2868, the only iPhone size Apple needs
  (it scales down for smaller devices). No iPad set: `supportsTablet` is false.
- `store/screenshots/play/` → 1080×1920 phone
- `store/screenshots/tablet/` → 1440×2560, covering both of Play's tablet slots

A landscape source is written into a landscape frame automatically, so shot 2
just works.

## Two things worth more than the screenshots

- **An App Preview video (iOS) / promo video (Play).** Play autoplays it at the
  top of the listing, above every screenshot. Thirty seconds of the reel viewer
  and Laybell TV would carry more than all eight frames.
- **The subtitle and keyword field.** Nobody scrolls a screenshot they never saw
  because the listing never surfaced. Section 1 of `STORE_LISTING.md` holds the
  current copy; it is worth a pass in the same sitting.

## Store mechanics

- **Play** takes a listing change any time, independently of a release.
- **App Store** ties screenshots to a version, so these ride along with the
  1.0.1 submission. That is convenient timing rather than a constraint — but it
  does mean a reshoot after 1.0.1 ships waits for 1.0.2.
