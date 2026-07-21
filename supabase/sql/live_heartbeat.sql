-- Cross-user "ghost livestream" fix.
--
-- A live_streams row is flipped to status='live' when a broadcast starts and back
-- to 'ended' when the host taps End (or the Go Live screen unmounts). If the host's
-- app is force-killed or crashes mid-broadcast that cleanup never runs, so the row
-- stays 'live' forever with no media behind it — every viewer's Live feed then shows
-- it as an un-playable black screen.
--
-- The own-account case is handled purely client-side (endMyStaleLiveStreams reaps
-- your own leftovers at cold start / Go Live / feed open). This column covers the
-- OTHER-user case: while live, the broadcaster pings last_heartbeat_at ~every 15s
-- (lib/live.beatLiveStream). fetchLiveStreams hides any 'live' row whose newest ping
-- is older than 45s (dropStaleLives), so a killed broadcast disappears from everyone
-- else's feed within ~45s.
--
-- Fully backward compatible: the column is nullable and NULL is treated as
-- "always fresh" (never hidden), so old clients that don't ping and rows created
-- before this migration keep showing exactly as before. Safe to run more than once.

alter table public.live_streams
  add column if not exists last_heartbeat_at timestamptz;

-- The feed filters heartbeat staleness in JS after the status='live' fetch (which
-- already uses live_streams_live_idx), so no extra index is required here.
