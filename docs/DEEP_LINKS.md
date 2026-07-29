# Deep links — what's built, what's blocked

Tapping a Laybell link should open the app, not the website. That's "universal
links" on iOS and "app links" on Android. Both work the same way: the app
declares which domain it owns, the domain serves a file proving it back, and the
OS verifies the pair. Neither side works alone.

The app side is done. The domain side is not, and it's blocked on one thing —
where `laybell.app` is hosted.

---

## The files

| File | Serves at | Proves |
|---|---|---|
| `web/.well-known/apple-app-site-association` | `https://laybell.app/.well-known/apple-app-site-association` | iOS: this domain authorises this app |
| `web/.well-known/assetlinks.json` | `https://laybell.app/.well-known/assetlinks.json` | Android: same |
| `app.json` → `ios.associatedDomains` | — | app side of the iOS pair (`applinks:laybell.app`) |
| `app.json` → `android.intentFilters` | — | app side of the Android pair |

Paths covered on both platforms: `/post` `/reel` `/profile` `/playlist`
`/communities` `/shop` `/story`, plus `/open.html` on iOS.

The legal pages (`/privacy.html`, `/terms.html`, `/community.html`,
`/advertising.html`, `/marketplace.html`) are explicitly **excluded**. Someone
who taps a privacy-policy link wants to read the policy — bouncing them into the
app is hostile, and App Review follows those links from your listing.

---

## Three identifiers are still blank

```bash
node scripts/set-store-ids.mjs --check
```

| Placeholder | Where to get it |
|---|---|
| `id000000000` | App Store Connect → your app → App Information → **Apple ID** (numeric). Exists as soon as you create the app record — you don't have to be live. |
| `TEAMID` | developer.apple.com → Membership → Team ID. Ten characters. |
| `ANDROID_SHA256_FINGERPRINT` | Play Console → Test and release → App integrity → App signing → **SHA-256 certificate fingerprint**. |

Set them with one command each:

```bash
node scripts/set-store-ids.mjs --app-store-id 6478123456
node scripts/set-store-ids.mjs --team-id A1B2C3D4E5
node scripts/set-store-ids.mjs --android-sha256 AB:CD:...:EF
```

> **The Android fingerprint is the one people get wrong.** With Play App Signing,
> Google re-signs your upload with *their* key. The fingerprint that verifies
> your links is Google's **app signing** key, not your **upload** key. Both are
> on the same Play Console page, a few lines apart. Using the upload key makes
> verification fail silently — links just open the browser, with no error
> anywhere.

---

## The blocker: where laybell.app is hosted

`.well-known/` files must be served **from the domain root, over HTTPS, with no
redirects.** That rules out two things that look like they'd work:

- **GoDaddy Website Builder** (where `laybell.app` points today) gives you no way
  to upload an arbitrary file at an arbitrary path. This is why
  `lib/appLinks.ts` currently routes QR codes through
  `3ddies.github.io/laybell` instead of your own domain.
- **GitHub Pages at a project subpath** serves at
  `3ddies.github.io/laybell/.well-known/…`, which is not the domain root. iOS
  and Android will never look there.

### The fix, cheapest first

**Option A — point `laybell.app` at GitHub Pages (free).**
The repo already publishes `web/` via `.github/workflows/deploy-legal.yml`. Add
`laybell.app` as the custom domain in repo Settings → Pages, update the DNS at
GoDaddy, and everything in `web/` serves at the root — legal pages, `open.html`,
and `.well-known/`. One caveat below.

**Option B — Cloudflare Pages (also free, and strictly more capable).**
Same idea, but Cloudflare lets you set response headers via `web/_headers`
(already written). That solves the caveat.

> **The caveat.** Apple requires `apple-app-site-association` to be served as
> `application/json`. The file deliberately has no extension, and GitHub Pages
> serves unknown extensions as `application/octet-stream` — it has no mechanism
> for custom headers, so `web/_headers` is ignored there. Modern iOS is often
> tolerant of this, but "often" isn't a launch plan. **If iOS universal links
> refuse to open the app after everything else checks out, this is the cause,
> and Option B is the fix.** Android has no equivalent problem — `assetlinks.json`
> has a `.json` extension and gets the right type automatically.

---

## Publishing

The Pages workflow only fires on pushes to **`dev`**. Nothing in `web/` reaches
the internet from a feature branch. Merge first, then verify.

---

## Verifying it actually works

Do these in order — each one rules out a different failure.

**1. The files are reachable and correctly typed**

```bash
curl -sI https://laybell.app/.well-known/apple-app-site-association
curl -sI https://laybell.app/.well-known/assetlinks.json
```

Want: `200`, no `301`/`302` anywhere in the chain, and `content-type:
application/json` on both.

**2. Apple's CDN has picked it up** — iOS fetches through Apple's cache, not from
you directly, so your server being right isn't sufficient:

```bash
curl -s "https://app-site-association.cdn-apple.com/a/v1/laybell.app"
```

Empty means Apple hasn't fetched yet. It can take a day or so after the file
first appears.

**3. Google's verifier agrees:**

```bash
curl -s "https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://laybell.app&relation=delegate_permission/common.handle_all_urls"
```

**4. On a real device** (a simulator won't prove this): put a link in a Note or
a DM to yourself and tap it. Do **not** type it into the browser address bar —
typed URLs deliberately don't trigger universal links, which is the single most
common false alarm.

**5. Android verification status**, after installing the build:

```bash
adb shell pm get-app-links com.laybell.app
```

Want `verified`. `legacy_failure` almost always means the wrong signing key
(see the warning above).

---

## Order of operations

1. Create the App Store Connect record → get the Apple ID and Team ID
2. Upload one Android build → get the app-signing fingerprint
3. `node scripts/set-store-ids.mjs` for all three
4. Merge to `dev` so Pages publishes
5. Move the domain (Option A or B)
6. Work through the verification list above

Steps 1–3 can happen now. Step 5 is independent of the app entirely and is worth
doing early, because DNS changes and Apple's CDN both take time to propagate.
