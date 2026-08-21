# Post-launch backlog — optional, deliberately deferred

Things that are **not** launch blockers and were consciously pushed past v1.0. Each entry
says why it was safe to defer, so a future reader can tell a real decision from an oversight.

**This file is for OPTIONAL work.** Anything that must happen belongs in
`LAUNCH_CHECKLIST.md` §0.0, not here.

---

## 1. Warn before deleting an account with a positive balance
*Deferred 2026-08-21 by the owner. Product change, needs a rebuild (no OTA).*

A user who deletes their account with unspent credits or unwithdrawn earnings leaves that
money in an **unclaimable anonymised ledger account**. Nothing is lost by the ledger — the
entries survive and it still balances — but the person cannot get to it afterwards.

This is correct accounting rather than a bug: deleting the entries would unbalance the ledger,
which `fix_ledger_blocks_deletion.sql` deliberately refuses to do. The gap is that the app
says nothing about it.

**The fix:** before the delete confirmation, read the balance and either refuse or warn while
`available_cents > 0` — "You have $X available. Withdraw it before deleting; this cannot be
recovered." The deletion sheet already has a two-step confirm, so this is one more branch on
an existing screen.

**Safe to defer because** nobody has real earnings pre-launch, and the money is not destroyed
— only stranded. It becomes real the first time a creator with a balance deletes, so it should
land in an early update rather than sit here indefinitely.

---

## 2. The reels overlay glitch (landscape pager)
*Deferred 2026-08-13 by the owner. Cosmetic, needs a rebuild.*

Mid-swipe in the landscape reels pager, the outgoing post's caption and song card linger over
the incoming video for a few frames, with the video's left edge briefly unfilled. Diagnosed at
46.9s of the Android recording.

**Cause:** `app/reel/[id].tsx:822` layers one overlay bar *on top of* the pager rather than
inside its items — deliberately, so bottom touches cannot reach the FlatList — and its
identity updates on settle (`:1053`). Same JS on iOS; a slower device just holds the window
open longer, which is the whole of "Android is worse than iOS".

🚫 **Read `:830-836` before touching this.** A previous change in this exact area froze the
pager mid-scroll between two posts, and that was itself the reported glitch. The area has
already traded a worse bug for this one.

**The fix, if ever wanted:** fade the overlay's contents while `overlayDraggingRef.current`
is true. Additive; touches neither the pager nor the video pipeline.

---

## 3. Native Google sign-in on Android
*Deferred 2026-08-13. Needs a rebuild.*

`android.googleServicesFile` is unset, so the build has no `default_web_client_id` and native
Google sign-in falls through to the browser. **The browser flow works and is verified**, so
this is polish, not function.

---

## 4. iPad and Apple Watch
Screenshots exist for iPad in App Store Connect but the app was never tested there. Either
test it or drop iPad from the supported device families in a future version.

---

## 00. iOS Google sign-in — WORKING via a server-side skip; close the loop properly
*Broken and fixed 2026-08-21. No longer user-facing, so this is hygiene rather than urgency.*

Tapping **Continue with Google** returned `Passed nonce and nonce in id_token should either
both exist or not.` `lib/socialAuth.ts:79` calls `signInWithIdToken({ provider: 'google',
token: idToken })` with **no nonce**, while `@react-native-google-signin` on iOS mints an
id_token that contains one.

✅ **Unblocked by enabling the nonce-check skip on the Supabase Google provider** — server-side,
applied to the already-shipped build, verified working.

**Why this still belongs on the list.** The skip disables a real protection: the nonce binds a
token to the request that asked for it, which is what stops a captured token being replayed.
The remaining bar is high — a validly signed, unexpired token carrying Laybell's own audience —
but doing the two fixes below lets the check be turned back **on**.

### The fix — two parts, do both

**1. Make the fallback actually work (3 lines, and it is the robust half).** The browser flow
underneath is fine; the native branch just never reaches it, because it returns the error:

```ts
if (idToken) {
  const { error } = await supabase.auth.signInWithIdToken({ provider: 'google', token: idToken });
  if (!error) return {};
  // Native path failed (nonce mismatch, provider config, anything) — the web
  // flow below still works, so fall through rather than dead-ending the user.
}
```

That one change would have turned this launch defect into an invisible extra second of latency.
**Any native-first path with a working fallback should fail INTO the fallback, never out of it.**

**2. Handle the nonce properly.** Generate a raw nonce, pass its SHA-256 to the Google SDK, and
pass the raw value to `signInWithIdToken({ provider, token, nonce })` — so both sides carry it.

**3. Then turn the skip back OFF.** This is the step that is easy to forget, because by then
nothing will appear broken. Supabase Dashboard → Authentication → Sign In / Providers → Google
→ disable the nonce-check skip, **and re-test sign-in on a real device afterwards** — the whole
point is that this path only fails where it is exercised.

⚠️ **Check `socialAuth.ts:152` at the same time** — Apple uses the identical no-nonce shape, so
it may carry the same latent bug even if it currently works. ✅ **Apple sign-in was verified working on 2026-08-21** (account created through a privaterelay.appleid.com address), so this is latent rather than live — fix it while the Google path is open, not as its own errand.

### Two general lessons worth keeping

- **A native-first path with a working fallback must fail INTO the fallback.** Returning the
  error instead of falling through is what turned a recoverable hiccup into a launch defect.
- **A console toggle is worth trying before a rebuild.** Twice on 2026-08-21 a server-side
  setting fixed something that looked like it needed a new binary — this, and the earlier
  `redirect_uri` registration. Reach for configuration first when the symptom is auth-shaped.

---

## 0. ⚠️ HIGHEST PRIORITY — the in-app Community Guidelines are STALE
*Created 2026-08-21 by the Stripe-driven policy change. Needs a rebuild, so it cannot ship
before 1.0.1.*

`app/community-guidelines.tsx` does `import community from '../lib/legal/community.json'` —
**bundled at build time.** Build 4 is approved and staged on both stores, so the shipped app
will show users the OLD text saying *"tasteful and artistic nudity is allowed"*, while
`laybell.app/community` — the version Stripe read and Laybell attested to — says nudity is
prohibited and non-monetizable.

**The risk is a user relying on what the app told them**, posting nudity in good faith, and
being moderated under a stricter rule they never saw. Low volume at launch, and such content
would likely have been moderated anyway under the 13+ rating, but it is a knowingly wrong
state and should not sit for long.

**The fix is free** — the JSON is already correct in the repo, so 1.0.1 picks it up with no
code change at all. It just needs a build. **Ship 1.0.1 promptly after launch.**

*(A remote-fetched legal screen would prevent this class of drift entirely, and is worth
considering while touching this — the web pages already regenerate on push.)*

---

## 1b. A deleted account leaves the app glitchy instead of signing out
*Found 2026-08-21 the hard way — the owner was signed in when their test account was
deleted server-side. Needs a rebuild.*

The Supabase JWT stays valid until it expires, so the client keeps a working session for a
user that no longer exists. Every query returns empty, and the UI renders a broken shell
rather than logging the person out.

**This is not an edge case — it is what moderation looks like.** The Community Guidelines say
repeat violators are terminated, and every one of them who is signed in at the time gets this
experience instead of a clear "your account has been removed" screen. It is also what any user
sees during the 48-hour window if their own deletion is force-completed.

**The fix:** treat "authenticated but no profile row" as a signed-out state. On profile fetch
returning nothing for a live session, sign out and route to login with an explanatory message.
`app/_layout.tsx` already has a login guard for accounts flagged for deletion — this is the
same idea one step later, for accounts already gone.

**Workaround meanwhile:** sign out and back in. A reinstall also clears it.

---

## 1c. Android: 16 KB memory page sizes not supported
*Flagged by Play at submission 2026-08-21. Bypassed with "Proceed anyway". Needs a rebuild.*

Play raised it as an error with an explicit bypass, so bundle 4 ships without it. Some Android
15 devices — Pixel 9 class and newer — run **16 KB memory pages**, and native libraries built
for 4 KB pages can misbehave there. The affected population is small today and growing, and
Google's tolerance for the bypass will not last.

**The fix is a rebuild with updated native libraries**, which is why it was not done for launch:
a new bundle means a new Play review, and the date was four days out. Do it in 1.0.1, and test
on a 16 KB device or emulator image rather than assuming.

*(A deobfuscation-file warning was also raised and ignored — it only affects how readable crash
reports are, not behaviour. Worth attaching in a future build for better crash triage.)*

---

## 5b. Wire up `payoutsAvailable()` — or delete it
*Found 2026-08-21 while auditing Phase 2. Needs a rebuild (no OTA).*

`lib/wallet.ts:126` defines `payoutsAvailable()`, and `LAUNCH_CHECKLIST.md` calls it "the kill
switch for the payout RAIL" in four separate places. **Nothing calls it.** The Transfer button
at `app/wallet.tsx:206` is gated on `total <= 0` and nothing else, so the rail is always on and
the switch controls nothing.

Survivable at launch only because Stripe going live is server-side and earnings sit on a
14-day hold — see §0.0. But **a documented safety control that does not exist is worse than no
control, because it gets trusted.** Either gate the Transfer button on it, or delete the
function and its four references so nobody plans around a switch that was never wired.

---

## 5. Trademark — `LAYBELL` wordmark
Filing spec is ready in `LAUNCH_CHECKLIST.md` (Class 9, Intent to Use, ~$350). Preliminary
clearance looked clear. Nice-to-have; the ™ is already shown in-app.
