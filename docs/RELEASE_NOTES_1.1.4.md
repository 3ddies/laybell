# Laybell 1.1.4 — release notes

**This is a NATIVE build** (new native module `modules/laybell-subject-lift`). No OTA —
the JavaScript is frozen at build time, so every fix needs a rebuild.

## What's New (store copy)
- **Make a sticker from any photo.** Press and hold almost any image in Laybell — a feed photo, a slideshow, album art, the now-playing cover — and Laybell lifts the subject out into a sticker, right on your phone. Saved stickers show up in **My GIFs**, ready to drop into comments and DMs with a clean, see-through background.
- **Storybooks.** Collect your stories into titled, chaptered highlights on your profile — like a photo album for your stories, with its own full-screen viewer and editor.
- **A tidier archive.** Archive a storybook and it waits in your Stories archive; press and hold it (or an archived story) for options — view, edit, put it back on your shelf, make it public, or delete. Making a storybook public pops it straight back onto your profile.
- Polish throughout.

## What shipped (technical)
- **Subject-lift stickers** — new on-device native module `modules/laybell-subject-lift` (iOS Vision `VNGenerateForegroundInstanceMaskRequest`, iOS 17+; Android counterpart). Point-aware press-and-hold lifts the pressed subject into a transparent PNG. Surfaces wired: feed single-image + slideshow, album-detail cover, Music "Hottest Album" hero, now-playing art, and feed square song posters (`SongSquareCard`). Overlay host `contexts/StickerCaptureContext` (frosted-glass preview, fade in/out, tap-outside to cancel). All local & free — a sticker only leaves the device when the user actually uses it.
- **Stickers → My GIFs** — saving a lifted sticker uploads it to the user's `posts` bucket and indexes it in `user_gifs` as a new **`sticker`** kind, so it appears in the "My GIFs" picker and sends in comments/DMs like any GIF. PNG attachments now render on a transparent backing (`AttachmentView` / `GifPickerModal`) so cut-outs aren't boxed in grey.
- **Storybooks** — chaptered story highlights (`lib/storybooks`, `app/storybook/*`): story-style viewer + editor, auto monthly/yearly recaps. Archive support: `archived_at` soft-hides a book (and forces it private); a shared long-press options sheet (`components/ArchiveOptionsSheet`) drives view / edit / put-back / make-public / delete for archived storybooks and stories; making a book public clears `archived_at` (un-archives). Archive re-syncs on focus; Posts/Stories tabs restyled to plain highlighted words.
- **SQL / functions** — **no new edge functions.** `user_gifs.kind` gains `'sticker'` with **no migration** (existing untyped text column). The storybooks tables + `archived_at` ship via the already-written **`supabase/sql/storybooks.sql`**, which must be **deployed** (owner) for storybooks + the archive menu to work; it degrades to empty if absent.
- Feature work committed `c572e1c` on `feature/subject-lift-stickers` (branch also carries `f5fa11c` storybooks + the sticker commits). **Pending merge to `dev`.**
- **Not included** (separate uncommitted branch): the realtime activity / profile-visit banner — fold that in before building only if desired.

## Pre-build gates
- 🧹 app typecheck: **0** (verified 2026-11-09; the only `tsc` output is the separate `web-app/` Next.js project + Deno globals under `supabase/functions/**`, neither in the mobile bundle).
- 💰 money: **no money code touched this release** — stickers, the GIF-library upload, storybook archiving and the tab restyle are all non-money paths. Re-confirm `global_sum_must_be_0`=0 + **demo money OFF** at submit (standing rule).
- 🗄️ schema: no new objects beyond the pre-existing `storybooks.sql` (deploy it) and the no-migration `user_gifs.kind` value. Re-run `node scripts/schema-audit.mjs` + deploy-drift near build.

## Submit steps
1. **Deploy `supabase/sql/storybooks.sql`** (owner) if not already live; confirm `user_gifs.sql` is live (it backs the existing My GIFs tab).
2. **Merge** `feature/subject-lift-stickers` → `dev` (sequence against the still-pending 1.1.2 first).
3. **Native EAS production build** (iOS + Android) — this release has a native module, so a rebuild is required.
4. **iOS:** App Store Connect (app `6795675871`) → create the **1.1.4** version, select the build, paste What's New, keep the reviewer demo notes, Submit. No new IAPs this release. ⚠️ Confirm demo money OFF.
5. **Android:** `eas submit -p android --profile production` (or upload the `.aab`) → roll out in Play Console.
