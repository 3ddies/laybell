-- Manual "feature" pin for the Music tab's Hot/Hottest Albums slot. Normally that
-- slot is ranked purely by summed track streams (app/(tabs)/music.tsx fetchHotAlbums),
-- so a brand-new album can't take the hero. This lets a LAYBELL ADMIN pin one album
-- there regardless of streams. Run manually in the Supabase SQL editor / db query.
--
-- Prereq: laybell_communities.sql (laybell_admins) + admin_console.sql (is_laybell_admin).

alter table public.albums add column if not exists featured boolean not null default false;

-- Pin (p_on=true) / unpin (false) an album. ADMIN ONLY — gated by is_laybell_admin, so
-- the pin can cross account boundaries (an admin pins anyone's album) even though the
-- normal albums RLS is owner-only. Exclusive: pinning one clears any other, so there's
-- a single "Hottest" at a time. SECURITY DEFINER to bypass owner-only RLS; the admin
-- check IS the gate. Anon denied; authenticated may call (the function re-checks admin).
create or replace function public.set_album_featured(p_album_id uuid, p_on boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_laybell_admin(auth.uid()) then
    raise exception 'not authorized';
  end if;
  if p_on then
    update public.albums set featured = false where featured = true and id <> p_album_id;
    update public.albums set featured = true  where id = p_album_id;
  else
    update public.albums set featured = false where id = p_album_id;
  end if;
end;
$$;

revoke all on function public.set_album_featured(uuid, boolean) from public;
revoke all on function public.set_album_featured(uuid, boolean) from anon;
grant execute on function public.set_album_featured(uuid, boolean) to authenticated;
