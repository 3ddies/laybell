# Storybooks — plan

Persistent, chaptered collections of a user's stories, shown on the profile like
Instagram story highlights — but organized into **titled chapters**, and with an
end-of-month/year **yearbook** that auto-compiles. "A private and fun gallery of
the stories you post," that can be published or kept private.

## v1 scope (decided 2026-11-07)
- **Highlights + chapters.** Manual books with titled chapters. (Auto-yearbooks designed-for but deferred.)
- **Content = your posted stories.** Snapshot from your story archive (expired stories persist, owner-readable; the `stories` bucket is public so snapshots never rot). No fresh uploads in v1.
- **Yearbook = auto-compiled** (when built, a later phase): the app gathers a month's/year's stories into a `kind='yearbook'` book; you choose publish or keep private.
- **Private by default**, publishing is opt-in.
- **Free** for v1 (drives story-posting). Tier-gating is a later option (e.g. book count).

## Data model (`supabase/sql/storybooks.sql` — written)
- `storybooks` — a book: `title, cover_url, is_public, kind('manual'|'yearbook'), period, position`.
- `storybook_chapters` — titled chapters within a book: `title, position`.
- `storybook_items` — a **snapshot** of one story inside a chapter: `story_id` (provenance), `media_url, media_type, thumbnail_url, caption, aspect_ratio, duration_seconds, position`.
- RLS: public book → readable by anyone signed in; chapters/items inherit the book's readability; only the owner writes. Hidden-owner filtering stays the client's job (RLS doesn't cover `profiles.hidden`).

## Build phases
1. **Foundation** — SQL schema (done) + `lib/storybooks.ts` data layer (CRUD, reorder, snapshot-from-story).
2. **Profile shelf** — a horizontal row of book covers under the profile hero (like IG highlights); own profile shows a "+ New" bubble. Tap a cover → viewer.
3. **Viewer** — story-style playback through chapters in order, items within a chapter; chapter title shown as a section header; progress bars; tap/hold/swipe like the story viewer.
4. **Create / edit** — new book (title, cover, public/private) → pick stories from your archive → organize into titled chapters → reorder → publish toggle. Add-to-storybook entry point from the story Archive screen.
5. **Later** — auto monthly/yearly yearbook compilation; optional fresh-media uploads; optional tier-gating.

## Open/implementation notes
- **Media durability:** snapshots reference the public `stories` file; durable through expiry/purge. Only *explicit* story deletion could 404 an item — a later pass can copy the file into a storybook-owned path to fully decouple. Acceptable for v1.
- **No OTA / no native module** — pure JS + these tables; reaches users on the next build.
- Reuses: story viewer patterns, `components/CaptureCamera`/Archive, `tileImageUri`/`feedImageUri`, the story-ring/avatar components.
