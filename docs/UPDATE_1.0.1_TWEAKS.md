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

*(empty — add them as they come up)*

| # | Screen | Change | Type | Status |
|---|---|---|---|---|
| | | | | |

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
