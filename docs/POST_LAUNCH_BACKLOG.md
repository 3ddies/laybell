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
