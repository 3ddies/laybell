-- Offline downloads — Supabase
-- Run in the Supabase Dashboard → SQL Editor (manual, like the other sql/ files).
--
-- Backs the offline-music feature (docs/OFFLINE_STREAMING_PLAN.md). Two pieces:
--   1. posts.downloadable — the creator's per-track opt-out. Default true, so every
--      existing/new track is downloadable unless its owner turns it off. The flag is
--      a COURTESY, not DRM: media_url is a public URL, so audio is fetchable
--      regardless. We honor it in-app (hide the download button, purge on next sync).
--   2. downloads — an OPTIONAL analytics/dedup ledger (who has a track offline).
--      Purely additive: the offline feature works entirely client-side without it.
--      If this file isn't run, the rpc/select calls reject, the client catches, and
--      offline still works — the count just isn't tracked (graceful degradation,
--      same pattern as badges.sql / spotlight.sql).
--
-- NOTE: offline LISTENS are credited by the existing record_stream RPC, replayed
-- from a client-side outbox when connectivity returns (lib/streamOutbox.ts). They
-- count at reconnect time (server `now()` window) — we deliberately do NOT backdate,
-- which would let a client forge stream timestamps. So record_stream is unchanged.

-- ── 1. Per-track opt-out (backward compatible: missing/NULL → downloadable) ──────
alter table public.posts
  add column if not exists downloadable boolean not null default true;

-- ── 2. Optional analytics + per-(user,post) dedup ledger ────────────────────────
create table if not exists public.downloads (
  user_id    uuid not null references auth.users(id) on delete cascade,
  post_id    uuid not null references public.posts(id) on delete cascade,
  device_id  text,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);
create index if not exists downloads_post_idx on public.downloads (post_id);

alter table public.downloads enable row level security;

-- A user can see and manage only their own download rows.
drop policy if exists "Users read own downloads" on public.downloads;
create policy "Users read own downloads" on public.downloads
  for select using (auth.uid() = user_id);

drop policy if exists "Users insert own downloads" on public.downloads;
create policy "Users insert own downloads" on public.downloads
  for insert with check (auth.uid() = user_id);

drop policy if exists "Users delete own downloads" on public.downloads;
create policy "Users delete own downloads" on public.downloads
  for delete using (auth.uid() = user_id);

-- ── 3. Optional denormalized counter on posts (for curator/creator insight) ─────
alter table public.posts
  add column if not exists downloads_count integer not null default 0;

-- Backfill once from any existing ledger rows (no-op on a fresh table).
update public.posts p
   set downloads_count = (select count(*) from public.downloads d where d.post_id = p.id)
 where exists (select 1 from public.downloads d where d.post_id = p.id);

create or replace function public.sync_post_downloads_count()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'INSERT') then
    update public.posts set downloads_count = downloads_count + 1 where id = new.post_id;
  elsif (tg_op = 'DELETE') then
    update public.posts set downloads_count = greatest(downloads_count - 1, 0) where id = old.post_id;
  end if;
  return null;
end; $$;

drop trigger if exists downloads_count_sync on public.downloads;
create trigger downloads_count_sync
  after insert or delete on public.downloads
  for each row execute function public.sync_post_downloads_count();

-- ── 4. Fire-and-forget record/forget RPCs (client swallows 404 if not deployed) ─
create or replace function public.record_download(p_post_id uuid, p_device_id text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  insert into public.downloads (user_id, post_id, device_id)
  values (auth.uid(), p_post_id, p_device_id)
  on conflict (user_id, post_id) do update set created_at = now();
end; $$;
grant execute on function public.record_download(uuid, text) to authenticated;

create or replace function public.forget_download(p_post_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  delete from public.downloads where user_id = auth.uid() and post_id = p_post_id;
end; $$;
grant execute on function public.forget_download(uuid) to authenticated;
