# Laybell — Scale-Hardening Pass (2026-07-23)

Autonomous background pass to find and surgically fix "unseen gaps" for long-term
scale and UX — with a hard constraint that **the app currently works perfectly**,
so every *applied* change is behavior-preserving on the happy path. Riskier or
behavior-changing improvements are written up here as **recommendations**, not
applied.

**All work is on branch `polish/scale-hardening-2026-07-23`** — nothing touched
`dev`. Nothing was pushed, deployed, or run against the database.

---

## How this was done

- **Isolated branch** off `55a4a4f`; **baseline type-check first** (app code was
  already 100% clean — the only `tsc` errors in the repo are the expected Deno
  edge-function ones under `supabase/functions/`, which aren't bundled).
- **Four read-only audits** in parallel: data-layer scalability, memory/lifecycle
  leaks, render hot-paths, resilience/robustness.
- **Type-check gate after every batch** — `tsc` app-code errors stayed at zero
  throughout. (ESLint is not configured in this repo, so `tsc` is the gate.)
- Changes committed in small, reviewable units.

### Headline audit verdicts (reassuring)
- **Memory/lifecycle: exceptionally clean — no significant leaks.** Every realtime
  channel has a matching teardown; native players (video pools, expo-audio,
  TrackPlayer, WebRTC/LiveKit), orientation locks, and all intervals are released
  on unmount. Hot channels even use per-mount name suffixes to dodge
  duplicate-subscribe crashes.
- **Render: already heavily optimized** — per-card subscription stores, pooled
  players, split `PostMusicContext`, memoized `PostCard`/`ReelPage`, stable keys +
  `getItemType`. No "component-defined-in-render" bugs remain.
- **N+1 queries: largely absent** — the codebase consistently batches with `.in(...)`.
- The real scale risks are **missing DB indexes** and **a few unbounded
  lifetime-history queries**, plus **secondary-screen resilience** on bad networks.

---

## What was changed (applied & committed)

All four commits are behavior-preserving on the happy path.

### `aaacdee` — resilience: clear loading skeletons + prevent silent send-drops
- **Infinite-skeleton fix (DM / group DM / comments / inbox):** wrapped each
  `setup()` in `try { … } finally { setLoading(false) }`. Before, a transient
  network *reject* (subway/elevator/flaky signal) threw before the loading flag
  cleared, so the screen spun **forever** with no recovery. Now it always falls
  back to the normal empty/loaded state, recoverable via pull-to-refresh.
- **Silent send-drop fix (messages, group messages, comments):** the input was
  cleared optimistically *before* the insert; on failure there was no restore, so
  the user's text (and staged attachment) vanished while they believed it sent.
  Now the failure branch restores exactly what they typed/attached.
- **Auth entry fix (login, signup):** a thrown network error is captured into the
  same `{ error }` shape the existing branches already handle, so the button
  always re-enables (previously a rejected auth call could leave it stuck
  disabled with a spinner and no way to retry but force-quit).

### `5c5119c` — resilience: recover skeletons/refresh spinners + explore search race
- Extended the same recovery to **profile, own-profile, post, reel, explore** via a
  one-line call-site `.catch` that clears the skeleton/refresh spinner (these
  bodies were left untouched — zero risk to their logic). Also covers the
  pull-to-refresh spinner getting stuck on a rejected refresh.
- **Explore search-as-you-type race:** added a sequence-ref guard so a slow
  earlier query can no longer paint stale results over a newer one (last-issued
  wins, not last-to-resolve). Purely additive — only stale responses are dropped.

### `0f0e3be` — perf: stabilize refs on two hot paths
- **Comments:** memoized `topLevel` (was a fresh array every render → FlatList data
  churn) and precomputed a replies-by-parent `Map`, replacing an **O(n²)**
  `rows.filter` that ran per top-level comment on every render — i.e. **every
  keystroke** while composing.
- **Feed:** `pendingPostIds` now derives from a stable id-signature, so the Set
  (and the `feedData → FlashList data` chain it feeds) only changes identity when
  a post enters/leaves the pending set — **not on every background-upload progress
  tick**, which previously re-reconciled the whole feed while a video uploaded.

### `81ab71f` — docs(sql): `supabase/sql/scale_indexes_2.sql` (REVIEW-ONLY, not applied)
See "Recommendations → DB indexes" below.

### Verification
- `tsc --noEmit` app-code errors: **0** (unchanged from baseline; the ~80
  `supabase/functions/**` Deno errors are pre-existing and not bundled).
- Diff: **14 code files, +134/−59**, plus the review-only SQL file. Small,
  uniform, per-file changes.

---

## Recommendations NOT applied (deliberately) — prioritized

These were left for you because they change behavior, need a product decision, or
sit on the very hottest path where I won't gamble against "works perfectly."

### TIER 1 — biggest scale win, low risk, needs you to run SQL
- **Run `supabase/sql/scale_indexes_2.sql`** (I wrote it; it is *not* applied).
  Additive, idempotent (`if not exists`) indexes for the gaps the audit confirmed:
  - **`messages` 1:1 DMs are entirely unindexed today** (only `(conversation_id,
    created_at)` exists) — every DM open, the home unread badge (runs constantly),
    and mark-as-read seq-scan the whole table. **Highest risk/reward in the app.**
  - **`posts.stream_count`** — the dominant music/explore browse sort has no index
    (~7 section loads full-scan + sort the whole audio corpus).
  - **`pg_trgm` GIN indexes** — every profile/post/community/shop search uses
    leading-wildcard `ILIKE '%term%'` with no trigram index (seq scan per keystroke).
  - **`ad_campaigns.post_id`**, **`shop_orders(seller_id,status)` / `(listing_id,status)`**.
  - Also confirm the earlier `scale_indexes.sql` was applied.

### TIER 2 — real issues to schedule (behavior-affecting → your call)
- **Money-aggregate correctness (fix before real payments + scale).**
  `lib/wallet.ts:25` sums the wallet balance from `fetchMySales`, which is capped
  at `limit(100)` — a seller with >100 delivered orders would see an
  **undercounted balance**. Donation/analytics totals are likewise summed
  client-side over unbounded rows (`lib/donations.ts:129`, `lib/analytics.ts:103`).
  Fix with server-side `sum()` RPCs — the correct pattern already exists as
  `donation_earnings`. (Not urgent today only because payments are simulated.)
- **Unbounded lifetime-history queries on hot paths** (grow with a heavy user's
  lifetime, then render only a slice):
  - Feed/reel fetch the user's **entire** like + save history to build membership
    Sets (`app/(tabs)/index.tsx:1293`, `app/reel/[id].tsx:1134`). Scoping to the
    visible pool is high-value **but** must first be verified against how
    paginated (scroll-loaded) posts get their liked/saved state — otherwise
    later pages could lose it. That verification is why I didn't auto-apply it.
  - Comments load **all** comments for a post (`components/Comments.tsx:143`),
    1:1 chat loads the **entire** thread (`app/messages/[id].tsx:208`), profile
    grid loads **all** of a user's posts with `select('*')`
    (`app/(tabs)/profile.tsx:237`). Each wants pagination/windowing — a UX change.
- **Global realtime "firehoses"** (fine now, scale with concurrent users):
  - Home screen subscribes to **all** `messages` INSERTs with no filter and
    filters in JS (`app/(tabs)/index.tsx:1101`) → every message anywhere streamed
    to every online client. Also `message_reactions` and `live_streams` subscribe
    globally (`event:'*'`, no filter). Move to per-conversation / filtered channels.

### TIER 3 — nice-to-have perf, safe but deferred
- **Split `AudioContext` into selector hooks** (`useCurrentTrack()`/`useIsPlaying()`),
  mirroring `PostMusicContext`. Biggest app-wide render win (today every `useAudio()`
  consumer — e.g. the Explore grid — re-renders on `isBuffering`/`adState`/etc.), but
  it touches many consumers → moderate regression risk. Left for your review.
- **`React.memo(ExploreGrid)` + memoized header/callbacks** — safe, but limited
  benefit until the `AudioContext` split above (the grid re-renders on audio state
  regardless), so best done together.
- **`lib/suggestions.ts:116`** contact-match RPC batches run sequentially. Worth
  parallelizing — but with a concurrency cap, since a huge address book would
  otherwise fire many concurrent RPCs at once (why I didn't apply the naive
  `Promise.all`).
- **Shared explicit column projection** for the `select('*')` posts hot queries so
  new columns (e.g. big `slides`/`captions` jsonb) don't silently inflate every
  feed/reel/music query.

### TIER 4 — cosmetic / no functional impact
- Three untracked one-shot `setTimeout`s (`app/story/[userId].tsx:575,679`,
  `app/reel/[id].tsx:887`) — the memory audit confirmed these are **silent no-ops**
  on RN's current architecture (no setState-after-unmount warning), so I left them
  rather than add churn. Tidy for hygiene only if you like.
- ~8 production `console.*` (all error-path/informational, none log sensitive data).
- A few other screens' `onRefresh` handlers could get the same `try/finally` for
  belt-and-suspenders; low value.

---

## Reviewing / merging this branch
```
git checkout polish/scale-hardening-2026-07-23
git log --oneline 55a4a4f..HEAD      # the 4 commits above
git diff 55a4a4f..HEAD               # full diff (small)
```
Merge into `dev` when you're happy, or cherry-pick individual commits. The SQL
file is inert until you choose to run it. Everything is OTA-safe (no native
changes), so it ships in a normal JS bundle/update.
