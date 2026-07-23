-- ============================================================================
-- Scale hardening #2 — indexes for messaging, search, browse-sort, and the
-- monetization lookups. Companion to scale_indexes.sql (which already covered
-- the feed, follow-graph, and notifications).
--
-- ⚠️ REVIEW-ONLY / RUN IT YOURSELF. This file was prepared by an automated
--    scalability audit but has NOT been applied to your database. Read it, then
--    run it in the Supabase SQL editor when you're ready. Nothing here touches
--    app code or changes behavior.
--
-- 100% additive and safe: an index only makes queries faster (or sits unused).
-- `if not exists` = idempotent, so re-running is harmless.
--
-- These target gaps the audit confirmed in the CURRENT schema:
--   • messages: 1:1 DMs are wholly unindexed today — only (conversation_id,
--     created_at) exists, so every DM open, the home unread badge (runs on every
--     home focus AND every realtime message), and mark-as-read seq-scan the
--     whole table.
--   • posts.stream_count: the dominant music/explore browse sort has no index —
--     ~7 section loads each full-scan + top-N sort the whole audio corpus.
--   • text search: every profile/post/community/shop search uses leading-wildcard
--     ILIKE '%term%' with no trigram index → a seq scan per keystroke.
--   • ad_campaigns.post_id / shop_orders: unindexed filters behind the per-profile
--     Spotlight badge check and the wallet/shop counts.
--
-- HOW TO RUN
--   • Early stage / low traffic: paste the whole file into the Supabase SQL
--     editor and run — each statement is near-instant on small tables.
--   • Large / live table under write load: run each statement individually as
--     `create index concurrently ...` so writes are never blocked. CONCURRENTLY
--     cannot run inside a transaction — run one at a time, not in BEGIN/COMMIT.
--     (pg_trgm's CREATE EXTENSION should run first, on its own.)
--
-- AUDIT FIRST (optional, read-only) — see what already exists so you can trim any
-- redundant line before running:
--   select tablename, indexname, indexdef
--   from pg_indexes
--   where schemaname = 'public'
--     and tablename in ('messages','posts','profiles','communities',
--                       'shop_listings','ad_campaigns','shop_orders')
--   order by tablename, indexname;
-- ============================================================================


-- ── messages: 1:1 DM access (the biggest risk/reward item) ──────────────────
-- Powers the unread badge's `receiver_id = me and read = false`, the thread
-- fetch's `or(sender.eq/receiver.eq)`, and mark-as-read. The partial unread
-- index stays tiny (only unread rows).
create index if not exists messages_receiver_unread_idx
  on public.messages (receiver_id) where read = false;
create index if not exists messages_sender_receiver_idx
  on public.messages (sender_id, receiver_id, created_at);
create index if not exists messages_receiver_sender_idx
  on public.messages (receiver_id, sender_id, created_at);


-- ── posts.stream_count: the music/explore browse sort ───────────────────────
-- Partial index matches the exact filter those queries use, so it stays small
-- and serves `order by stream_count desc` without a full-corpus scan.
create index if not exists posts_audio_streams_idx
  on public.posts (stream_count desc)
  where is_public and type = 'audio' and archived_at is null;


-- ── trigram search: stop seq-scanning on every keystroke ────────────────────
-- pg_trgm lets a GIN index serve leading-wildcard ILIKE '%term%'. One extension
-- + one index per searched text column.
create extension if not exists pg_trgm;
create index if not exists profiles_username_trgm
  on public.profiles using gin (username gin_trgm_ops);
create index if not exists profiles_display_trgm
  on public.profiles using gin (display_name gin_trgm_ops);
create index if not exists posts_caption_trgm
  on public.posts using gin (caption gin_trgm_ops);
create index if not exists communities_name_trgm
  on public.communities using gin (name gin_trgm_ops);
create index if not exists shop_listings_title_trgm
  on public.shop_listings using gin (title gin_trgm_ops);
-- Optional — only if you search listing descriptions too:
-- create index if not exists shop_listings_desc_trgm
--   on public.shop_listings using gin (description gin_trgm_ops);


-- ── monetization lookups ────────────────────────────────────────────────────
-- ad_campaigns.post_id: the per-profile Spotlight-badge `in(post_id, gridIds)`
-- check and the pre-delete `eq(post_id)` check.
create index if not exists ad_campaigns_post_idx
  on public.ad_campaigns (post_id);

-- shop_orders: the seller/listing count filters behind the wallet + shop UI.
create index if not exists shop_orders_seller_status_idx
  on public.shop_orders (seller_id, status);
create index if not exists shop_orders_listing_status_idx
  on public.shop_orders (listing_id, status);
