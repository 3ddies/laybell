-- ───────────────────────────────────────────────────────────────────────────
-- video-staging — the handoff bucket for LONG video uploads.
--
-- WHY THIS EXISTS. Long videos used to be pushed from the phone to Cloudflare
-- with a hand-rolled chunked (tus) uploader: hundreds of JavaScript-driven
-- requests, each carrying byte offsets that had to be reconciled with the
-- server, over a mobile connection. It never worked reliably — six distinct
-- root causes in two days, and the failure mode was always the same shape:
-- an upload that "finished" but left Cloudflare holding an incomplete file.
--
-- The replacement inverts the transfer:
--   1. the phone makes ONE native upload into this bucket (the same
--      expo-file-system upload task that has carried audio and images
--      reliably since launch — the OS manages it, not JS);
--   2. the server hands Cloudflare a short-lived SIGNED URL;
--   3. Cloudflare fetches the file itself, datacenter to datacenter;
--   4. the staged object is deleted once Stream has it.
--
-- No chunking, no offsets, no resume bookkeeping, nothing to reconcile.
--
-- PRIVATE on purpose: nothing here is ever served to viewers. Cloudflare
-- reaches it through a signed URL that expires, so the raw master is never
-- publicly addressable.
--
-- Idempotent; safe to re-run.
-- ───────────────────────────────────────────────────────────────────────────

-- 5 GB ceiling: comfortably past a 3-hour 1080p master while still bounding
-- what a single upload can cost.
-- NOTE: a bucket can never exceed the PROJECT-WIDE upload limit
-- (Dashboard → Settings → Storage → "Upload file size limit"). On Pro that can
-- go to 50 GB; raise it there if a large film is refused with a 413.
insert into storage.buckets (id, name, public, file_size_limit)
values ('video-staging', 'video-staging', false, 5368709120)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit;

-- Owner-scoped access. Files live under "<user_id>/…", so the first path
-- segment is the owner — the same convention the other media buckets use.
drop policy if exists "video_staging_insert_own" on storage.objects;
create policy "video_staging_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'video-staging' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "video_staging_read_own" on storage.objects;
create policy "video_staging_read_own" on storage.objects
  for select to authenticated
  using (bucket_id = 'video-staging' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "video_staging_delete_own" on storage.objects;
create policy "video_staging_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'video-staging' and (storage.foldername(name))[1] = auth.uid()::text);

-- Safety net: staged masters are TEMPORARY. The client deletes each file once
-- Cloudflare has ingested it, but a crash mid-flight would otherwise leave a
-- multi-GB object billing forever. Anything older than a day has either been
-- ingested or abandoned.
create or replace function public.sweep_video_staging()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  with gone as (
    delete from storage.objects
     where bucket_id = 'video-staging'
       and created_at < now() - interval '24 hours'
    returning 1
  ) select count(*)::int into v_deleted from gone;
  return v_deleted;
end $$;

revoke all on function public.sweep_video_staging() from public;
revoke execute on function public.sweep_video_staging() from anon, authenticated;

do $$
begin
  perform cron.unschedule('sweep-video-staging');
exception when others then null;
end $$;
select cron.schedule('sweep-video-staging', '23 * * * *', 'select public.sweep_video_staging()');

-- Verify.
select id, public, pg_size_pretty(file_size_limit::bigint) as max_file
  from storage.buckets where id = 'video-staging';
select policyname from pg_policies
 where tablename = 'objects' and policyname like 'video_staging%';
select jobname, schedule, active from cron.job where jobname = 'sweep-video-staging';
