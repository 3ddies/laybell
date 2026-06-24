# Laybell Offline Music — Implementation Plan

> Status: **Phase A BUILT (OTA, type-checks clean) — pending the manual SQL run + device testing.**
> Scope decided with product: layered model (Layers 0 + 1 now, paid Premium later),
> sandbox storage + per-song artist opt-out, single-uploader ownership for v1.
> This plan reflects an adversarial review (3 independent reviewers) that corrected
> several blocker-level assumptions in the first sketch.

## Build status (Phase A)

**Done & type-checking:**
- Engine `lib/offline.ts` (legacy file API, `.part`→atomic rename, free-space floor,
  3 GB byte cap, in-use eviction lock, drift/opt-out resolve guard, startup reconcile,
  online reconcile-purge), `lib/offlineManifest` logic folded into the engine
  (single-writer debounced persist), `lib/streamOutbox.ts`, `lib/offlinePrefs.ts`.
- Player: `contexts/AudioContext.tsx` resolves local file → falls back to remote,
  marks/clears the in-use lock, and routes stream credit through the offline outbox.
- `contexts/OfflineContext.tsx` + `OfflineProvider` wired into `app/_layout.tsx`;
  inits per-user, flushes the outbox + reconciles on launch and every foreground.
- Entitlement: `OFFLINE_PIN_LIMIT` / baseline in `lib/badges.ts`; enforced at download
  time only (never revoked on demotion).
- UX hook `hooks/useDownloadAction.ts` (one place, localized alerts).
- Surfaces: 3-dot menu Download/Remove + owner "Allow downloads" toggle
  (`PostOptionsContext`, lazy-fetches `media_url`/`downloadable`), NowPlaying button,
  TrackRow offline indicator (opt-in props), Downloads screen `app/downloads.tsx`
  (+ route), Settings "Offline music" entry.
- SQL `supabase/sql/offline_downloads.sql`; English i18n keys.

**Polish — DONE:**
- `TrackRow` wired at all 6 consumers (12 usages) → list-level offline indicator + inline download button render in music/feed/profile/explore/playlist.
- es/fr/de/pt/it translations added for all `offline.*` keys (160 entries).
- `supabase/sql/offline_downloads.sql` — **run by the user.** ✅

**Hardening fixes (post-review correctness pass):**
- **Purge-on-offline data loss (critical):** `reconcileOnline` now only purges
  "missing" tracks on a *confirmed successful* server response — a failed query
  (offline/flaky) no longer wipes downloads.
- **Cross-user leak/deletion (shared device):** the in-memory manifest is cleared
  synchronously on account switch, and files are namespaced per-uid
  (`offline/<uid>/pinned|auto`) so the orphan-prune can't delete another account's
  downloads.
- **Blank titles:** menu-pinned songs now fetch their caption so the Downloads list
  shows real titles.
- `pinTrack` guards against a null-uid path; in-use lock cleared on account switch.

**Opt-out semantics (`posts.downloadable`):** enforced at the 3-dot menu (fetches the
flag, blocks the pin), at `resolveLocalUri` (won't serve an opted-out file), and via
reconcile-purge on foreground. The inline TrackRow/NowPlaying buttons are best-effort
(download proceeds, reconcile cleans up) — consistent with "courtesy, not DRM."

**Phase B — BUILT (ships with the next native rebuild):**
- `lib/network.ts` — NetInfo wrapper, dynamic-import + graceful fallback (dormant until
  the binary includes the module; never reports a false "offline").
- Layer-0 auto-cache: `autoCache()` + LRU `evictAuto()` in `lib/offline.ts` (cache dir,
  10-track / 200 MB budget, free-space floor, in-use lock, honors opt-out via the
  player's owner-row fetch — no extra query). Fired from `AudioContext` after load.
- `offlinePrefs` default flipped to autoCache ON + wifiOnly ON.
- `OfflineContext` exposes `isOffline`, `prefs`, `setPref`; Settings gains
  "Auto-download recent songs" + "Download on Wi-Fi only" toggles; Downloads screen
  shows an offline chip. `@react-native-community/netinfo@11.4.1` installed.
- app.json: deduped the doubled `UIBackgroundModes: audio`.

**ToS — DONE:** offline-cache clauses added to `lib/legal/terms.json` (Section 5
"Offline Downloads and On-Device Caching" + Section 6 "Offline Playback Is Use Within
the Service"); JSON validated. Consider bumping the effective date + re-presenting for
consent before launch.

**Still remaining:**
- **Native rebuild required for Phase B**: NetInfo is installed but needs a new
  dev-client / store build before auto-cache + the offline indicator actually run.
- Device testing (offline playback / download / auto-cache / purge) — not exercisable
  in web preview.
- Phase C: paid Premium via IAP (RevenueCat / expo-in-app-purchases). Decided perks:
  unlimited offline (byte-capped), ad-free, higher-quality audio, profile/badge perks.
- Type-check: clean across the whole app (only pre-existing Deno edge-function errors remain).

**expo-av → expo-audio migration — DONE (audio players):**
- `contexts/AudioContext.tsx` + `contexts/PostMusicContext.tsx` migrated off the
  SDK-54-deprecated `expo-av` to `expo-audio` (`createAudioPlayer` + `addListener
  ('playbackStatusUpdate')`, `setAudioModeAsync`, seconds↔ms converted at the status
  boundary, `remove()` lifecycle with a deferred-release helper so we never free a
  player inside its own callback, an ad-load watchdog since expo-audio doesn't throw
  on load failure, and an unmount cleanup). `expo-audio` installed + plugin added.
- **Still on expo-av (separate migration to fully drop it):** the feed `Video` in
  `app/(tabs)/index.tsx` → `expo-video`, and the one-shot audio-duration probe in
  `app/ad-manager/create.tsx`. expo-av stays installed until those move.
- Needs the **same native rebuild** as Phase B (expo-audio is native).

---

## 1. Why offline is cheap to add here

Three facts make this far less work than for a typical app:

1. **The player already plays local files.** Playback runs through `expo-av`
   `Audio.Sound.createAsync({ uri })` in `contexts/AudioContext.tsx:685`. That API
   plays a local `file://` path identically to a remote URL. Offline playback is a
   **single URI-resolution swap** at that one call site — the queue, scrubber,
   lock-screen controls, ad scheduler and stream accounting are untouched.
2. **The download primitive is installed.** `expo-file-system ~19.0.23` is already a
   dependency, used via the **legacy** entrypoint in `lib/upload.ts:1` and
   `app/privacy-center.tsx:7`. No new native module is needed for the core path.
3. **Entitlement infra already exists.** `rawTier()`, `tierRank()`, `isUnlocked()`,
   and the `PUBLIC_PLAYLIST_LIMIT` pattern in `lib/badges.ts:198-208` are exactly
   what a tier-gated download allowance reuses.

---

## 2. The layered model

| Layer | Audience | What it does | Ships in |
|---|---|---|---|
| **0 · Offline safety net** | Everyone, automatic | Best-effort foreground cache of the last ~7 played tracks (LRU) so a dead-zone drop doesn't stop the music. Service-scoped, OS-evictable. | Phase B (needs rebuild for responsible Wi-Fi gating) |
| **1 · Pinned downloads** | Tier-gated | Explicitly "download" a song / playlist for keeps; slot count scales by earned badge tier. | **Phase A (OTA, now)** |
| **2 · Laybell Premium** | Paid | Unlimited (byte-capped) offline + ad-free, via IAP. | Phase C (future) |

**Sequencing rationale:** Layer 1 (explicit, user-initiated pins) is fully
OTA-shippable today — no NetInfo, no rebuild. Layer 0's *automatic* caching can't be
done responsibly without connection-type detection (cellular bill-shock / consent),
which needs a native rebuild. So we ship the monetizable/engagement feature first and
fold Layer 0 into the next native build.

---

## 3. Corrections from adversarial review (read before building)

These overturn the first sketch. They are non-negotiable for a working build.

1. **Legacy file API only.** `import * as FileSystem from 'expo-file-system/legacy'`.
   Use `createDownloadResumable(url, fileUri, opts, onProgress)` for
   progress + pause/resume + `.savable()`. The new `File.downloadFileAsync` has none
   of these. Verify `DownloadProgressData` field names
   (`totalBytesWritten` / `totalBytesExpectedToWrite`) against installed types.
2. **No background downloads.** `lib/upload.ts` proves iOS background NSURLSession
   fails on this build (forced foreground). Layer 0 = best-effort while foregrounded;
   resume across foreground sessions via persisted `.savable()` handles. Do **not**
   promise per-play auto-cache completion.
3. **Lazy offline detection, not NetInfo (Phase A).** Resolve URI → if a verified
   local file exists use it, else attempt remote; on `createAsync` network failure
   fall back to any local copy. NetInfo (native, rebuild-gated) is added in Phase B
   only for the real offline indicator + "Wi-Fi only" toggle.
4. **Eviction in-use lock (data-loss fix).** Eviction must NEVER delete the file for
   `currentTrack?.id`, any `postId` referenced by a loaded `soundRef`, or any pinned
   item. Maintain an in-use lock set updated in `play()`/`stop()`; defer eviction of
   the active track until it changes.
5. **Single-uploader `downloadable`; no co-owners.** Audio posts have one
   `posts.user_id`. v1 = `posts.downloadable boolean default true`, toggled by owner.
   For a **host post carrying an attached song** (`song_id`), gate on the *source*
   audio post's `downloadable` flag (join via `song_id`).
6. **Lock-not-delete on tier demotion; no fake grace.** `pageLayout.ts` is a pure
   read-gate — there is no "6h grace" for layouts (that constant is an unrelated
   daily-badge buffer). Tiers are free and volatile, so **never auto-delete a user's
   saved downloads on demotion.** Enforce the slot limit at *download* time; on
   demotion, read-gate the overflow to "locked" (kept on disk, re-enabled when the
   tier is re-earned). Mirrors the playlist slot model exactly.
7. **`cacheDirectory` for auto, `documentDirectory` for pinned.** Invisible Layer-0
   cache goes in `cacheDirectory` (OS can reclaim under pressure — acceptable, it's
   re-downloadable and avoids App Store "large re-downloadable data in Documents"
   flags). Only user-pinned downloads go in `documentDirectory`.
8. **Manifest needs a single-writer mutex.** The AsyncStorage manifest is written by
   auto-cache (every play), pin/unpin, and eviction → read-modify-write races corrupt
   it. Keep the source of truth in memory in `OfflineContext`, serialize all writes
   through one promise queue, persist debounced. Don't rewrite the whole blob to bump
   `lastPlayedAt` on every play.
9. **Offline stream/badge outbox.** `recordStream()` is fire-and-forget
   (`AudioContext.tsx:678`), so offline listens silently lose credit. Add a durable
   outbox (reuse the `STREAM_PROGRESS_KEY` persistence pattern): on RPC failure, queue
   `{postId, deviceId, awardOrdinal, listenedAt}`; flush on reconnect/foreground. Add
   `p_listened_at` to `record_stream` so the server windows by when it happened. Cache
   each track's `owner_id` locally (already present in queue source rows) so badge
   eligibility doesn't need a network call offline.
10. **ToS reconciliation (legal).** Offline playback of *others'* audio while the app
    isn't running is "off the Service" use the current Terms withhold. Add a limited
    device-side offline-cache clause to `lib/legal/terms.json`, and frame
    `downloadable` to creators as a **courtesy, not DRM** (public `media_url` means
    files are rippable regardless).
11. **expo-av deprecation is a separate migration.** Offline works on expo-av today;
    expo-av is removed in SDK 55. The `AudioContext` → `expo-audio` migration is
    orthogonal and larger — do not couple it to this work.
12. **Web guard.** `file://` caching doesn't apply on `react-native-web`. `OfflineContext`
    must no-op on web so nothing crashes there.

---

## 4. Concrete numbers (pinned down)

**Design intent (per product):** offline is a *quality-of-life* improvement to the
streaming experience, not a heavily-gated reward. So **everyone gets a baseline** even
without a badge, tiers escalate generously, and the real cost (device storage + egress)
is bounded by a hard byte cap rather than stingy counts.

```ts
// lib/badges.ts
export const OFFLINE_PIN_BASELINE = 10;                 // everyone, even no badge (QoL)
export const OFFLINE_PIN_LIMIT: Record<Tier, number> =
  { bronze: 30, silver: 75, gold: 150, diamond: 300 };  // generous, never "unlimited"
export function offlinePinLimit(tier: Tier | null): number {
  return tier ? OFFLINE_PIN_LIMIT[tier] : OFFLINE_PIN_BASELINE;
}
```

- **Hard device byte cap (overrides count):** pinned total ≤ **3 GB**; whichever of
  count-limit or byte-cap is hit first wins. This is the real scalability guard — at
  ~8 MB per ≤6-min track, even diamond's 300 lands near the cap, so storage/egress is
  bounded regardless of tier inflation.
- **Layer-0 auto-cache budget:** ≤ **10 tracks AND ≤ 200 MB**, LRU, `cacheDirectory`.
- **Free-space floor:** refuse a download if it would drop free space below **200 MB**
  (`FileSystem.getFreeDiskStorageAsync()` legacy / `Paths.availableDiskSpace` new).
- **Retry:** exponential backoff 2s → 8s → 30s; max 3 attempts (auto) / 5 (pinned,
  user-visible retry). **Stop permanently on 403/404** (deleted or opted-out source).
- **Download concurrency cap:** 2.
- **Manifest:** AsyncStorage JSON, schema `v1`, single-writer mutex. Migrate to
  `expo-sqlite` only if **>150 entries OR blob >256 KB** (deferred; native rebuild).
- **Wi-Fi-only default:** ON for Layer-0 auto-cache (Phase B); pins allow cellular
  with a one-time confirm.

---

## 5. On-device layout

```
${cacheDirectory}offline/auto/<postId>.<ext>        # Layer 0 (OS-evictable)
${documentDirectory}offline/pinned/<postId>.<ext>   # Layer 1 (persists)
<final>.part                                        # in-flight; atomic rename on verify
```

**Manifest record (in-memory + persisted):**
```ts
type OfflineEntry = {
  postId: string;
  path: string;              // resolved local path (source of truth — never reconstruct)
  bytes: number;
  source: 'auto' | 'pinned';
  mediaUrl: string;          // for drift check vs current posts.media_url
  ext: string;               // parsed from media_url (split('?')[0] + ext match)
  downloadable: boolean;     // last confirmed
  checkedAt: number;         // last online verification
  addedAt: number;
  lastPlayedAt: number;      // LRU (tiny separate key / debounced)
  state: 'downloading' | 'ready' | 'failed' | 'locked';
  savable?: string;          // createDownloadResumable resume token
};
```

**Drift / corruption discipline:** write file → verify (200 + Content-Length matches
bytes) → atomic rename `.part`→final → THEN write manifest. At resolve time, `stat`
the file and confirm bytes before returning `file://`; on mismatch, drop entry + partial
and fall back to remote. Run a reconcile sweep on app start (dir ↔ manifest, prune both
ways) — mirrors `resolvableBlocks()` in `lib/pageLayout.ts`.

---

## 6. Files to create

| File | Responsibility |
|---|---|
| `lib/offline.ts` | Core engine on `expo-file-system/legacy`: paths, `downloadTrack()` (createDownloadResumable, `.part`→rename, progress, backoff, free-space check, stop-on-403/404), `removeTrack()`, `getInfo()`, `reconcileSweep()`, LRU eviction with in-use lock. |
| `lib/offlineManifest.ts` | Single-writer mutex over the AsyncStorage manifest; schema-versioned `v1`; debounced persist; corruption-safe parse (fail → rebuild from reconcile). |
| `contexts/OfflineContext.tsx` | App-facing API: `isCached(id)`, `isPinned(id)`, `pin(id)`/`unpin(id)`, `downloadProgress`, `storageUsage`, `pinnedList`, `isOffline` (lazy). Runs reconcile on init. **No-ops on web.** |
| `lib/streamOutbox.ts` | Durable queue for failed `record_stream` / badge events; flush on reconnect/foreground; dedupe by `(postId, awardOrdinal)`. |
| `lib/offlinePrefs.ts` | AsyncStorage prefs: `autoCacheEnabled`, `wifiOnly` (Phase B), `maxStorageBytes`. |
| `app/downloads.tsx` | Management screen (SwipeBackPager route, registered in `app/(tabs)/_layout.tsx:137`): pinned list (unpin), storage meter, manage. Reuses `TrackRow`. |
| `components/DownloadsView.tsx` | The list + storage-meter body (so it can also embed as a Music-tab view if desired). |
| `supabase/sql/offline_downloads.sql` | Migration (see §8). |

## 7. Files to modify

| File | Change |
|---|---|
| `contexts/AudioContext.tsx` | (a) `const src = (await resolveLocalUri(track)) ?? track.uri;` immediately before `createAsync` (`:685`); skip for the ad sound (`:242`). (b) After successful load (`~:694`), trigger Layer-0 cache via OfflineContext (Phase B). (c) Update in-use lock in `play()`/`stop()`. (d) Route `recordStream()` / badge through `streamOutbox` on failure; cache `owner_id` for offline badge eligibility. |
| `lib/badges.ts` | Add `OFFLINE_PIN_LIMIT` + `offlinePinLimit()` beside `PUBLIC_PLAYLIST_LIMIT` (`:205`). |
| `components/TrackRow.tsx` | Add `onDownload` prop + download/cached icon (mirror add-to-playlist button at `:100`); subtle "downloaded" indicator in the meta row. |
| `contexts/PostOptionsContext.tsx` | When `mediaType==='audio'`: add "Download (offline)" / "Remove download" options. Honor source `downloadable` for attached songs. |
| `components/NowPlaying.tsx`, `components/MiniPlayer.tsx` | Small download affordance + cached badge (secondary to TrackRow / 3-dot). |
| `app/settings.tsx` | "Offline Music" section after Display (`~:200`): storage used + Manage, auto-cache toggle, Wi-Fi-only (Phase B). |
| `app/(tabs)/music.tsx` | Wire `onDownload` into TrackRow consumers; pin-limit check at action time mirroring `:504-512` with new i18n keys. |
| Post edit screen (own audio) | `downloadable` opt-out toggle (RLS: owner-only update). |
| `lib/i18n.ts` | New keys (`offline.*`, `music.offlinePinLimit*`) in `en` + author-checked `es/fr/de/pt/it`; count-unit helpers for "N downloads" / "N MB". |
| `app.json` | Dedupe the doubled `UIBackgroundModes: 'audio'` (`:20-23`). Add NetInfo plugin in Phase B. |
| `package.json` | Add `@react-native-community/netinfo` — **Phase B only** (rebuild). |
| `lib/legal/terms.json` | Offline-cache clause — **before launch**. |

---

## 8. SQL migration — `supabase/sql/offline_downloads.sql`

Follows the project's idempotent / graceful-degradation house style
(`post_song.sql`, `badges.sql`, `record_stream_rpc.sql`).

```sql
-- 1) Opt-out flag (backward compatible: missing/NULL treated as downloadable)
alter table public.posts
  add column if not exists downloadable boolean not null default true;

-- 2) Optional analytics + dedup ledger
create table if not exists public.downloads (
  user_id   uuid not null references auth.users(id) on delete cascade,
  post_id   uuid not null references public.posts(id) on delete cascade,
  device_id text,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);
alter table public.downloads enable row level security;
drop policy if exists "Users read own downloads" on public.downloads;
create policy "Users read own downloads" on public.downloads
  for select using (auth.uid() = user_id);
drop policy if exists "Users insert own downloads" on public.downloads;
create policy "Users insert own downloads" on public.downloads
  for insert with check (auth.uid() = user_id);

-- 3) Fire-and-forget analytics RPC (client swallows 404 if not deployed)
create or replace function public.record_download(p_post_id uuid, p_device_id text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.downloads(user_id, post_id, device_id)
  values (auth.uid(), p_post_id, p_device_id)
  on conflict (user_id, post_id) do update set created_at = now();
end; $$;
grant execute on function public.record_download(uuid, text) to authenticated;

-- 4) record_stream gains p_listened_at for offline replay windowing (see §3.9)
--    (extend existing record_stream_rpc.sql signature; default now()).
```

Client treats a missing column/RPC as "feature absent" — offline still works
locally; analytics just no-op. (`select('*')` so an absent `downloadable` reads as
`!== false` → downloadable.)

---

## 9. Phasing & checklist

### Phase A — OTA, no rebuild (Layer 1 + foundation)
- [ ] `offline_downloads.sql` (run manually, per house convention)
- [ ] `lib/offline.ts` + `lib/offlineManifest.ts` (legacy API, `.part`→rename, backoff, free-space, in-use lock, reconcile)
- [ ] `contexts/OfflineContext.tsx` (web-guarded; reconcile on init)
- [ ] `lib/streamOutbox.ts` + AudioContext resolver/outbox/owner-cache wiring
- [ ] `lib/badges.ts` `OFFLINE_PIN_LIMIT` + pin-limit alert in `music.tsx`
- [ ] Pin UI: TrackRow + PostOptions + NowPlaying/MiniPlayer; `downloadable` toggle on own posts
- [ ] `app/downloads.tsx` + storage meter; Settings "Offline Music" section
- [ ] i18n keys (en + es/fr/de/pt/it) + a11y labels on icon-only controls
- [ ] Lazy offline playback fallback (no NetInfo)
- [ ] `lib/legal/terms.json` offline-cache clause

### Phase B — next native rebuild (Layer 0 + NetInfo)
- [ ] Add `@react-native-community/netinfo` (+ plugin), bundle with pending rebuild
- [ ] Layer-0 auto-cache (cacheDirectory, LRU, 7-track/150 MB budget, free-space floor) with Wi-Fi-only default
- [ ] Real offline indicator + Wi-Fi-only pin setting
- [ ] (Optional) `expo-sqlite` manifest if scale crosses the §4 threshold

### Phase C — future (Layer 2 Premium)
- [ ] `entitlement(profile)` seam returns `{ pinLimit, adFree, unlimitedOffline }` —
      today derived purely from earned tier (code comment: paid path is IAP-only)
- [ ] Integrate IAP (RevenueCat or `expo-in-app-purchases`) — **Apple/Google billing,
      never a web-set server flag** (App Store policy)
- [ ] Unlimited-but-byte-capped offline + ad-free

---

## 10. Accepted residual risks (state plainly)
- Public `media_url` means audio is rippable regardless of `downloadable`; the flag is
  a courtesy, not enforcement. Real protection needs signed URLs / private bucket +
  token playback (out of scope).
- Opted-out / deleted tracks already on a device may play once more before the next
  online reconcile purges them (bounded staleness, not a hard guarantee).
- Tier "mass-pin then let it lapse" is mitigated by lock-not-delete + byte cap, not
  eliminated.
