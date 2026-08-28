# 1.0.1 — tweak list

Running list of cosmetic and behavioural changes for 1.0.1. Add anything here; nothing in this
file touches the released app until a **production** build is submitted.

**How to add one:** screenshot the screen on your phone, say what bothers you. "The like count
sits too close to the avatar" is enough — precise pixel direction is my job, not yours.

---

## How this gets tested

`expo-dev-client` is installed, so tweaks do **not** need a build each:

1. **Once:** build and install a development client on your iPhone.
   ```
   npx eas-cli build --profile development --platform ios
   ```
   (If it asks to register the device, say yes — internal distribution needs it.)

2. **Every time after:** start the dev server and open the app.
   ```
   npx expo start --dev-client
   ```
   Every JS/TS change appears on your phone in seconds. Change, look, say "no, more", repeat.

**What still needs a fresh dev build:** anything native — a new dependency, an `app.json` plugin
change, a permission string, an icon. Almost nothing cosmetic is native.

---

## What is safe, and the one thing that is not

**Client code is a sealed sandbox.** Everything in `app/`, `components/`, `lib/`, `contexts/`,
and `app.json` is frozen into the binary at build time. There is no OTA on this project, so the
App Store copy of 1.0.0 build 4 physically cannot change no matter what happens here. It is
tagged `v1.0.0-build4`. Tweak as aggressively as you like.

🚨 **Server-side is NOT gated. It is live surgery on the shipped app.**

| Change | Reaches the live App Store app |
|---|---|
| `app/`, `components/`, `lib/`, `contexts/`, `app.json` | ❌ never, until a production build ships |
| `supabase/sql/*` run against production | ✅ **instantly** |
| `supabase/functions/*` deployed | ✅ **instantly** |
| `web/*` pushed (laybell.app, legal pages, share pages) | ✅ **instantly** |

Most cosmetic tweaks are pure client. If one needs a database column, an RPC, or an edge
function, **I will say so before doing it** — that is the line where "safe to experiment"
stops.

---

## Tweaks

| # | Screen | Change | Type | Status |
|---|---|---|---|---|
| 1 | Bottom nav, condensed state (iOS) | Feed showing between the floating chips competed with the icons — added a soft ground under the row | Cosmetic | ✅ done, needs a look on device |

### 1 · Condensed nav had no floor

Spotted 2026-08-28 in the Stripe review screenshots, on **both** the feed and Explore, so not one
screen's problem. Owner confirmed it looks the same in the app.

**My first read was wrong and worth recording.** I guessed the blur was too weak or not mounting.
It is neither: the bar has two states, and the screenshots caught the second one. At rest it is a
frosted panel; once you scroll, `feedChrome` dissolves that panel and the icons become floating
chips over the feed — deliberate, and the chips themselves are a near-solid wash
(`rgba(9,9,9,0.9)` on iOS dark). Nothing shows through a chip.

What showed through were **the gaps between chips**. With the panel fully gone, raw feed ran right
up to the icons — a post header and a **Follow** button threaded between them on the feed,
"@laybell" and "RAP" on Explore. Busy content in those gaps competes with the icons instead of
sitting behind them.

**Fix:** a dedicated scrim layer that fades in on `chip` — the same gradient as the panel at about
half strength, so the row always has a floor. The rest state is untouched (the two layers are
never both visible), and content still shows through, just knocked back.

It deliberately does **not** ride `panelSink`. The panel sinks 46px as it fades, which is what
sells the detach — but the icons *drop* on that same gesture, so sinking the floor too would
slide it out from under the thing it exists to support.

iOS only. Android already draws its chips on an opaque base, for reasons recorded in
`app/(tabs)/_layout.tsx` (other pager scenes were compositing into the band on a Samsung).

⚠️ **Alpha values are a first guess** — `0 / 0.05 / 0.18 / 0.32 / 0.42`. Look at it on the dev
client and say lighter or heavier; it is one line to tune.

---

## Store screenshots

The pipeline already exists and produced the shipped set.

1. Take fresh phone screenshots — the feed has real content now, so these will look far better
   than the launch set did.
2. Drop them in `store/screenshots/raw/` named `01.png` … `08.png`. Order is the gallery order.
   Any size; the script fits them.
3. Captions are at `scripts/make-screenshots.ps1:53` — edit in place, one per shot.
4. Run it:
   ```
   powershell -ExecutionPolicy Bypass -File scripts/make-screenshots.ps1
   ```

That writes all three store-ready sets: `appstore/` (1320×2868), `play/` (1080×1920), and
`tablet/` (1440×2560), alpha flattened, ready to upload in filename order. A landscape source is
written landscape automatically, keeping its number.

**When you can actually upload them:**

- **Apple** — screenshots are version-specific and cannot be changed on a live version. They go
  up with the 1.0.1 submission and are reviewed alongside it. (The only field editable on a live
  version without review is Promotional Text.)
- **Play** — the store listing updates independently of any release, but **the app is still in
  review right now.** Do not touch the listing until v1 publishes; changing it mid-review is the
  kind of self-inflicted state that already cost four days on Apple.
