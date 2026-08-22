# Post-launch backlog — optional, deliberately deferred

Things that are **not** launch blockers and were consciously pushed past v1.0. Each entry says
why it was safe to defer, so a future reader can tell a real decision from an oversight.

**This file is for OPTIONAL work.** Anything that must happen belongs in
`LAUNCH_CHECKLIST.md` §0.0, not here.

**Ordered by priority, highest first.** Items 1–3 are the case for shipping 1.0.1 promptly;
everything from 5 down can wait for a quiet week.

| # | Item | Why it waits |
|---|---|---|
| 1 | In-app Community Guidelines are stale | free to fix, but knowingly wrong today |
| 2 | Deleted account leaves the app glitchy | this is what moderation looks like |
| 3 | iOS Google sign-in — close the loop | working via a server-side skip that disables replay protection |
| 4 | Android 16 KB memory page sizes | bypassed at submission; device population is growing |
| 5 | Warn before deleting with a positive balance | becomes real the first time a creator earns |
| 6 | `payoutsAvailable()` is dead code | a documented control that does not exist |
| 7 | Reels overlay glitch | cosmetic, and the area has bitten before |
| 8 | Native Google sign-in on Android | the browser flow works |
| 9 | iPad / Apple Watch | untested surface |
| 10 | `LAYBELL` trademark | nice-to-have |

---

## 1. ⚠️ The in-app Community Guidelines are STALE
*Created 2026-08-21 by the Stripe-driven policy change. Needs a rebuild, so it cannot ship
before 1.0.1.*

`app/community-guidelines.tsx` does `import community from '../lib/legal/community.json'` —
**bundled at build time.** Build 4 is approved and staged on both stores, so the shipped app
shows users the OLD text saying *"tasteful and artistic nudity is allowed"*, while
`laybell.app/community` — the version Stripe read and Laybell attested to — says nudity is
prohibited and non-monetizable.

**The risk is a user relying on what the app told them**, posting in good faith, and being
moderated under a stricter rule they never saw. Low volume at launch, and such content would
likely have been moderated anyway under the 13+ rating, but it is a knowingly wrong state.

**The fix is free** — the JSON is already correct in the repo, so 1.0.1 picks it up with no code
change at all. It just needs a build.

*(A remote-fetched legal screen would prevent this class of drift entirely, and is worth
considering while touching this — the web pages already regenerate on push.)*

---

## 2. A deleted account leaves the app glitchy instead of signing out
*Found 2026-08-21 the hard way — the owner was signed in when their test account was deleted
server-side. Needs a rebuild.*

The Supabase JWT stays valid until it expires, so the client keeps a working session for a user
that no longer exists. Every query returns empty and the UI renders a broken shell rather than
logging the person out.

**This is not an edge case — it is what moderation looks like.** The Community Guidelines say
repeat violators are terminated, and every one of them signed in at the time gets this instead
of a clear "your account has been removed" screen.

**The fix:** treat "authenticated but no profile row" as a signed-out state — on a profile fetch
returning nothing for a live session, sign out and route to login with an explanation.
`app/_layout.tsx` already guards accounts *flagged* for deletion; this is the same idea one step
later, for accounts already gone.

**Workaround meanwhile:** sign out and back in, or reinstall.

---

## 3. iOS Google sign-in — working via a server-side skip; close the loop
*Broken and fixed 2026-08-21. No longer user-facing, so this is hygiene rather than urgency.*

Tapping **Continue with Google** returned `Passed nonce and nonce in id_token should either both
exist or not.` `lib/socialAuth.ts:79` calls `signInWithIdToken({ provider: 'google', token:
idToken })` with **no nonce**, while `@react-native-google-signin` on iOS mints an id_token that
contains one.

✅ **Unblocked by enabling the nonce-check skip on the Supabase Google provider** — server-side,
applied to the already-shipped build, verified working.

**Why it still belongs here.** The skip disables a real protection: the nonce binds a token to
the request that asked for it, which is what stops a captured token being replayed. The
remaining bar is high — a validly signed, unexpired token carrying Laybell's own audience — but
the three steps below let the check be turned back **on**.

**1. Make the fallback actually work (3 lines, and the robust half).** The browser flow
underneath is fine; the native branch never reaches it because it returns the error:

```ts
if (idToken) {
  const { error } = await supabase.auth.signInWithIdToken({ provider: 'google', token: idToken });
  if (!error) return {};
  // Native path failed (nonce mismatch, provider config, anything) — the web
  // flow below still works, so fall through rather than dead-ending the user.
}
```

**2. Handle the nonce properly.** Generate a raw nonce, pass its SHA-256 to the Google SDK, and
pass the raw value to `signInWithIdToken({ provider, token, nonce })`, so both sides carry it.

**3. Then turn the skip back OFF** — the step most likely to be forgotten, because by then
nothing looks broken. Supabase → Authentication → Sign In / Providers → Google, then **re-test
on a real device**: this path only fails where it is exercised.

⚠️ **Check `socialAuth.ts:152` at the same time** — Apple uses the identical no-nonce shape.
✅ Apple sign-in was **verified working 2026-08-21** (account created via a
`privaterelay.appleid.com` address), so it is latent rather than live. Fix it while this code is
already open.

### Two lessons worth keeping
- **A native-first path with a working fallback must fail INTO the fallback.** Returning the
  error instead of falling through turned a recoverable hiccup into a launch defect.
- **Try a console toggle before a rebuild.** Twice on 2026-08-21 a server-side setting fixed
  what looked like it needed a new binary — this, and the earlier `redirect_uri` registration.

---

## 3b. 🔒 Remove TEST_FORCE_TIER — it shipped, and it is a claimable privilege
*Found 2026-08-21. Blocked server-side the same day; the real fix needs a rebuild.*

`lib/badges.ts:628` still carries a block marked **"TEMP TESTING OVERRIDE — REMOVE BEFORE
RELEASE"**, and it is compiled into build 4:

```ts
const TEST_FORCE_TIER: Record<string, Tier> = {
  observer: 'diamond',
  rachaelhall: 'gold',
};
```

`evaluateBadges()` matches it on **username, not user id**, and short-circuits the normal
recompute — so whoever holds one of those names is handed the tier. The fresh-start reset
deleted both accounts and thereby **freed the names**, turning a testing shortcut into a
claimable privilege: `observer` grants Diamond, and Diamond gates creating communities.

✅ **Blocked server-side** by `supabase/sql/reserved_usernames.sql` — a small reserved-name
table plus a trigger, effective immediately on the shipped build. Proven by exercise:
attempting the rename raises `username_unavailable`.

**The 1.0.1 fix solves two problems at once.** Rename the map to a staff list, drop the test
names, and put `laybell` and `3ddie` in it. That removes the exploit *and* gives the official
accounts their Diamond honestly — today it comes from a badge titled "Log in 90 days in a row",
which is the only permanent diamond the shipped catalog has. See
`supabase/sql/_OWNER_official_accounts.sql`, which includes the revert block.

---

## 3c. 🐛 Premium+ "badge freeze" does not preserve tier — it only preserves rows
*Found 2026-08-21. Affects paying subscribers, not just the owner. Needs a rebuild.*

The freeze is sold as: *"while frozen, lapse-driven drops are skipped entirely — held badges
**and the tier/points they carry** survive with no maintenance"* (`lib/badges.ts:685`).

Only the first half is true. `:687` skips lapse-driven **deletes** while frozen, so the rows
stay in `user_badges`. But the point rollup at `:707` counts only
`isPerm(r) || qKeys.has(r.badge_key)` — a frozen row that no longer qualifies **scores zero**.

**So a Premium+ subscriber who stops posting keeps their badge rows and still loses tier**,
which is precisely what the feature promises will not happen. Confirmed in production: two
accounts holding nine badge rows each computed `gold`, because only the two catalogue-permanent
ones counted (8 + 4 = 12, and diamond needs 16).

**The fix:** include frozen rows in `heldKeys`, not just spare them from deletion — i.e. add
`|| frozen` to that filter so the freeze covers scoring as well as retention.

**Fix this in the same change as 3b** — both live in `evaluateBadges()`, and 3b's staff map
also removes the owner's need for the temporary bridge in
`supabase/sql/_OWNER_diamond_bridge_6mo.sql`.

---

## 4. Android: 16 KB memory page sizes not supported
*Flagged by Play at submission 2026-08-21. Bypassed with "Proceed anyway". Needs a rebuild.*

Play raised it as an error with an explicit bypass, so bundle 4 ships without support. Some
Android 15 devices — Pixel 9 class and newer — run **16 KB memory pages**, and native libraries
built for 4 KB pages can misbehave there. The population is small today and growing, and the
bypass will not be offered forever.

**The fix is a rebuild with updated native libraries.** Not done for launch because a new bundle
means a new Play review with the date four days out. Test on a 16 KB device or emulator image
rather than assuming.

*(A deobfuscation-file warning was also raised and ignored — it only affects crash-report
readability. Worth attaching in a future build for better triage.)*

---

## 5. Warn before deleting an account with a positive balance
*Deferred 2026-08-21 by the owner. Product change, needs a rebuild.*

A user who deletes with unspent credits or unwithdrawn earnings leaves that money in an
**unclaimable anonymised ledger account**. Nothing is lost by the ledger — the entries survive
and it still balances — but the person cannot reach it afterwards.

That is correct accounting rather than a bug: deleting the entries would unbalance the ledger,
which `fix_ledger_blocks_deletion.sql` deliberately refuses to do. The gap is that the app says
nothing about it.

**The fix:** before the delete confirmation, read the balance and refuse or warn while
`available_cents > 0`. The deletion sheet already has a two-step confirm, so this is one more
branch on an existing screen.

**Safe to defer because** nobody has real earnings pre-launch and the money is stranded rather
than destroyed — but it becomes real the first time a creator with a balance deletes.

---

## 6. Wire up `payoutsAvailable()` — or delete it
*Found 2026-08-21 while auditing Phase 2. Needs a rebuild.*

`lib/wallet.ts:126` defines `payoutsAvailable()`, and `LAUNCH_CHECKLIST.md` calls it "the kill
switch for the payout RAIL" in four separate places. **Nothing calls it.** The Transfer button at
`app/wallet.tsx:206` is gated on `total <= 0` and nothing else, so the rail is always on and the
switch controls nothing.

Survivable at launch only because Stripe going live is server-side and earnings sit on a 14-day
hold. But **a documented safety control that does not exist is worse than no control, because it
gets trusted.** Either gate the Transfer button on it, or delete the function and its four
references so nobody plans around a switch that was never wired.

---

## 7. The reels overlay glitch (landscape pager)
*Deferred 2026-08-13 by the owner. Cosmetic, needs a rebuild.*

Mid-swipe in the landscape reels pager, the outgoing post's caption and song card linger over
the incoming video for a few frames, with the video's left edge briefly unfilled. Diagnosed at
46.9s of the Android recording.

**Cause:** `app/reel/[id].tsx:822` layers one overlay bar *on top of* the pager rather than
inside its items — deliberately, so bottom touches cannot reach the FlatList — and its identity
updates on settle (`:1053`). Same JS on iOS; a slower device just holds the window open longer,
which is the whole of "Android is worse than iOS".

🚫 **Read `:830-836` before touching this.** A previous change in this exact area froze the pager
mid-scroll between two posts, and that was itself the reported glitch.

**The fix, if ever wanted:** fade the overlay's contents while `overlayDraggingRef.current` is
true. Additive; touches neither the pager nor the video pipeline.

---

## 8. Native Google sign-in on Android
*Deferred 2026-08-13. Needs a rebuild.*

`android.googleServicesFile` is unset, so the build has no `default_web_client_id` and native
Google sign-in falls through to the browser. **The browser flow works and is verified**, so this
is polish, not function.

---

## 9. iPad and Apple Watch
Screenshots exist for iPad in App Store Connect but the app was never tested there. Either test
it or drop iPad from the supported device families in a future version.

---

## 10. Trademark — `LAYBELL` wordmark
Filing spec is ready in `LAUNCH_CHECKLIST.md` (Class 9, Intent to Use, ~$350). Preliminary
clearance looked clear. Nice-to-have; the ™ is already shown in-app.
