-- ============================================================================
-- Scale hardening #1 — indexes for the hottest read paths.
--
-- 100% additive and safe: an index only makes queries faster (or is unused).
-- No app code changes, no behavior changes. `if not exists` = idempotent, so
-- re-running is harmless.
--
-- These target gaps found in the current schema:
--   • the feed's ORDER BY created_at DESC LIMIT
--   • the per-post likes(count) / comments(count) aggregates every feed load runs
--   • the follow-graph lookups (who I follow / my followers)
--   • profile pages (a user's posts, newest first)
--
-- HOW TO RUN
--   • Early stage / low traffic: paste the whole file into the Supabase SQL
--     editor and run — each CREATE INDEX is near-instant on small tables.
--   • Large / live table under write load: run each statement individually as
--     `create index concurrently ...` (shown commented per line) so writes are
--     never blocked. CONCURRENTLY cannot run inside a transaction — run one at a
--     time, not wrapped in BEGIN/COMMIT.
--
-- AUDIT FIRST (optional, read-only): see what already exists so you can trim any
-- line that's redundant with a unique constraint on these tables:
--   select tablename, indexname, indexdef
--   from pg_indexes
--   where schemaname = 'public'
--     and tablename in ('posts','likes','saves','comments','follows')
--   order by tablename, indexname;
-- ============================================================================

-- posts: global feed order, profile (user's posts newest-first), and the
-- type/public-filtered reel & song-queue queries.
create index if not exists posts_created_at_idx          on public.posts (created_at desc);
create index if not exists posts_user_created_idx         on public.posts (user_id, created_at desc);
create index if not exists posts_type_public_created_idx  on public.posts (type, is_public, created_at desc);

-- likes/saves/comments by post_id: powers the likes(count)/comments(count)
-- aggregates and per-post lookups. (The user_id direction is normally already
-- covered by a UNIQUE(user_id, post_id) constraint — skip it if the audit shows
-- one; add `create index if not exists likes_user_id_idx on public.likes (user_id);`
-- etc. only if it's missing.)
create index if not exists likes_post_id_idx     on public.likes (post_id);
create index if not exists saves_post_id_idx     on public.saves (post_id);
create index if not exists comments_post_id_idx  on public.comments (post_id);

-- follow graph: "my followers" / friends (following_id) — the follower_id
-- direction is usually covered by a UNIQUE(follower_id, following_id) constraint.
create index if not exists follows_following_idx on public.follows (following_id);

-- notifications: the per-user list (newest first) and the unread-badge count,
-- both run often. The partial index only covers unread rows, so it stays tiny.
create index if not exists notifications_user_created_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_user_unread_idx  on public.notifications (user_id) where read = false;
