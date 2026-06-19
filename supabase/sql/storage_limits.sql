-- ─── Storage upload size limits ──────────────────────────────────────────────
-- Fixes "exceeded the maximum allowed size" / 413 on perfectly normal short
-- videos. A <30s clip from a modern phone (4K or HEVC) is routinely 100–300 MB,
-- but Supabase's DEFAULT upload cap is only 50 MB, so the raw file is rejected
-- even though it's well under the 3-minute duration rule.
--
-- This raises the PER-BUCKET limit for every media bucket. Run it in the
-- Supabase SQL editor (or via the CLI) against your project.

update storage.buckets
set file_size_limit = 1073741824        -- 1 GB, in bytes
where id in ('posts', 'stories', 'avatars', 'ads');

-- Leave mime types open so a new container/codec is never surprise-rejected.
-- (NULL = allow all; we enforce TYPE via the picker + duration in the app, and
-- SIZE via the limit above — not via a brittle server allowlist.)
update storage.buckets
set allowed_mime_types = null
where id in ('posts', 'stories', 'avatars', 'ads');

-- Verify what each bucket now allows:
--   select id, file_size_limit, allowed_mime_types from storage.buckets;

-- ─── ⚠ REQUIRED MANUAL STEP (cannot be done from SQL) ─────────────────────────
-- A bucket's file_size_limit can NEVER exceed the PROJECT-WIDE global upload
-- limit, which is a dashboard setting:
--
--   Dashboard → Project Settings → Storage → "Upload file size limit"
--   → raise to at least 1 GB (1073741824 bytes), Save.
--
-- That global cap is itself bounded by your billing plan:
--   • Free plan  → 50 MB hard max. On Free you CANNOT raise it; the only way to
--                  fit large clips is on-device compression (the app already
--                  transcodes to ~1080p H.264 before upload once the native
--                  build ships react-native-compressor — see lib/upload.ts).
--   • Pro plan   → up to 50 GB; raise the global limit and these buckets follow.
--
-- So: to "post whatever they want" at full size, the project must be on Pro with
-- the global limit raised. On Free, the compression path keeps typical clips
-- comfortably under 50 MB.
