-- Storage cleanup for deleted content & accounts. Run once in the Supabase SQL
-- editor. Two parts:
--
--   1) Per-user DELETE policies on storage.objects, so a signed-in user can
--      remove their OWN files in the posts / avatars / stories buckets. The app
--      deletes a post's or story's media client-side, and deletes a replaced
--      avatar, but Supabase Storage blocks those deletes until these policies
--      exist. Objects are stored under "<user-id>/<timestamp>.<ext>", so the
--      first path segment is the owner's id.
--
--   2) A trigger that purges ALL of a user's Storage objects when their profile
--      row is deleted. Deleting an account = "delete from auth.users where id =
--      '<uid>'", which cascades to profiles and fires this trigger — so no
--      orphaned public files survive an account deletion, no matter how the
--      content was created. This is the server-side backstop for part (1).
--
-- Note: deleting rows from storage.objects removes the files from the bucket
-- listing and the public URL stops resolving. If you later want belt-and-braces
-- cleanup of the backing store, a scheduled Storage "empty bucket of orphans"
-- job or an Edge Function using the service role can sweep anything missed.

-- 1) Per-user DELETE policies --------------------------------------------------
drop policy if exists "Users can delete own post media" on storage.objects;
create policy "Users can delete own post media"
  on storage.objects for delete to authenticated
  using (bucket_id = 'posts' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users can delete own avatar media" on storage.objects;
create policy "Users can delete own avatar media"
  on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users can delete own story media" on storage.objects;
create policy "Users can delete own story media"
  on storage.objects for delete to authenticated
  using (bucket_id = 'stories' and (storage.foldername(name))[1] = auth.uid()::text);

-- 2) Purge a user's Storage objects when their profile is deleted --------------
create or replace function public.purge_profile_storage()
returns trigger
language plpgsql
security definer
set search_path = public, storage
as $$
begin
  delete from storage.objects
  where bucket_id in ('posts', 'avatars', 'stories')
    and (storage.foldername(name))[1] = old.id::text;
  return old;
end;
$$;

drop trigger if exists trg_purge_profile_storage on public.profiles;
create trigger trg_purge_profile_storage
  before delete on public.profiles
  for each row execute function public.purge_profile_storage();
