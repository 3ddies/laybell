# Laybell 1.0.1 — plan

**Target: land ~2026-09-09.** Planned 2026-08-26, two weeks out.

Scope follows the cadence the owner set at launch: **every update carries improvements and
optimizations, not only fixes.** There is no OTA, so a release costs a full build plus review on
both stores — an update that fixes one bug wastes the cycle it spent. Work is therefore grouped
**by file and subsystem**, so one pass through a file does everything that file needs.

---

## ⛔ Blocking question: Android v1 has not published

`play.google.com/store/apps/details?id=com.laybell.app` returned **404 on 2026-08-26** — five
days after the 08-21 submission. **Play will not accept a new release while one is in review**,
so the Android half of 1.0.1 cannot be submitted until v1 goes live.

**Two ways this resolves:**
- **v1 publishes in the next few days** → both platforms ship 1.0.1 together, plan unchanged.
- **v1 is still stuck** → ship iOS 1.0.1 on schedule and let Android follow once v1 lands.
  iOS is not blocked by Play in any way.

⚠️ **Check our own state before blaming Google.** Apple sat at `Rejected` for four days in August
because a reply had been sent but the resubmit never was. Look at Publishing overview for
anything unsent, and the Production track for a message.

---

## Scope

### A · `lib/badges.ts` — one file, three problems
The highest-value group in the update.

- **Remove `TEST_FORCE_TIER`** (backlog 3b). A block marked *"REMOVE BEFORE RELEASE"* shipped in
  build 4. It matches on **username**, so anyone registering `observer` gets Diamond and with it
  the ability to create communities. Currently blocked at the database by
  `reserved_usernames.sql`; this removes the cause.
- **Repurpose it as a staff list** holding `laybell` and `3ddie` — which grants the owner
  Diamond honestly and **retires `_OWNER_diamond_bridge_6mo.sql`** before it lapses in February.
- **Fix the Premium+ badge freeze** (backlog 3c). It promises *"held badges and the tier/points
  they carry survive"* but only skips deletes; the rollup at `:707` still scores a frozen
  non-qualifying row as zero. **Paying subscribers lose tier despite paying for exactly that not
  to happen.** Add `|| frozen` to the `heldKeys` filter.

**After this ships:** delete the bridge rows, then re-run the health check.

### B · `lib/socialAuth.ts` — sign-in robustness
- **Fall through on error** (backlog 3). Three lines. The native branch returns the Supabase
  error instead of falling through to the browser flow that works. This one change would have
  made the launch-day Google failure invisible.
- **Pass the nonce properly** on both sides, then **turn the Supabase skip back OFF** and re-test
  on a device. That skip is currently disabling replay protection.
- **Check `:152`** — Apple uses the identical no-nonce shape. Verified working 08-21, so it is
  latent rather than live; fix it while the file is open.

### C · Wallet — `lib/wallet.ts`, `app/wallet.tsx`
- **Warn before deleting with a positive balance** (backlog 5). Money is stranded rather than
  destroyed, but the app says nothing.
- **Wire up or delete `payoutsAvailable()`** (backlog 6). It is called nowhere, yet this
  checklist calls it "the kill switch for the payout RAIL" in four places. A documented control
  that does not exist is worse than none, because it gets trusted.

### D · `app/_layout.tsx` — deleted accounts
- **Treat "authenticated but no profile row" as signed out** (backlog 2). Today the app renders a
  broken shell. **This is what every moderated user will experience**, not an edge case.

### E · Free — no code change
- **Stale in-app Community Guidelines** (backlog 1). `lib/legal/community.json` is already
  correct in the repo; the shipped app bundles the old text saying nudity is allowed while
  `laybell.app/community` says it is not. **A rebuild alone fixes it.**

### F · Android build config
- **16 KB memory page sizes** (backlog 4). Bypassed at submission with "Proceed anyway". Needs
  updated native libraries; test on a 16 KB device or emulator image rather than assuming.
- **Set `android.googleServicesFile`** (backlog 8) so native Google sign-in stops falling through
  to the browser. Note the Android OAuth client lapses ~2026-09-25 and will need recreating.

Both are build-level Android changes — do them in the same pass.

### G · Optimization — the audio race family
This is the "improvements" half rather than bug-fixing, and the largest single chunk.
From the deferred polish backlog, **verify each against current code before trusting it** — that
list is from 2026-07-16 and one of its own entries was already found stale.

- `contexts/AudioContext.tsx` — five races: `advanceOrEnd` treating an in-flight
  `appendFromLoader` as dry; no queue-epoch guard in `appendFromLoader`; `advanceTo` skipping to
  an index the engine does not have yet; `pendingStartIndexRef` cleared mid-`startQueue`; the
  near-end pause with no fallback if JS misses the window.
- `contexts/PostMusicContext.tsx` — same-song host transfer aborting the only in-flight
  `replace()`; ambient stream accrual crediting the wrong song; `ambientPlayingRef` desyncing
  after provider-internal stops.

**Scope this to appetite.** All eight is a lot of surface in the most timing-sensitive code in
the app. A sensible cut is the three with user-visible symptoms — stuck buffering, silence, the
wrong song — and leave the accounting-only one.

---

## Deferred, deliberately

- **Reels overlay glitch** (backlog 7). `app/reel/[id].tsx:830-836` records a previous change in
  that exact area that froze the pager mid-scroll and was itself the reported bug. **Not in an
  update that is already touching this much.**
- **iPad** (9) and **trademark** (10) — neither is a code change on the critical path.
- **Hide `laybellreview`** (3d) — server-side, needs no build. Do it once Android v1 publishes,
  and remember it must be **unhidden before every future submission**.

---

## Timeline

| Window | Work |
|---|---|
| **Aug 26 – 30** | Groups A–E. Small, well-understood, all in files with clear boundaries. |
| **Aug 31 – Sep 2** | Group F (Android native), then Group G to appetite. Most regression risk lives here. |
| **Sep 3** | Version bump, EAS build, install and exercise on device. |
| **Sep 4** | Submit both stores — Android only if v1 has published. |
| **Sep 5 – 8** | Review. iOS updates typically clear in 1–2 days; Play updates are faster than a first submission. |
| **Sep 9** | Release. iOS holds for manual release; **Play publishes on approval and cannot be held.** |

**Before submitting, re-run both audits** — schema-vs-prod and function drift. They found six
real problems last time, including a stale webhook that would have given $19.99 buyers the
$9.99 tier.

**Verify by exercising, not by reading.** Every deletion blocker in August was found by probing
the path and none by reading the code.
