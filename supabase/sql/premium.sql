-- Laybell Premium — server-side entitlement mirror (RevenueCat)
-- Run in the Supabase Dashboard → SQL Editor.
--
-- profiles.premium_until mirrors the user's RevenueCat subscription expiry so a
-- "Premium supporter" badge can show on ANY profile (others can't see a client's
-- RevenueCat status). It is written ONLY by the revenuecat-webhook Edge Function
-- (service role). A protect trigger stops a normal client from setting it on their
-- own profile update — otherwise anyone could grant themselves Premium for free.
--
-- Entitlements are still primarily client-driven via RevenueCat customer info; this
-- column is the cross-user mirror + a server-truth hook for future enforcement.

alter table public.profiles
  add column if not exists premium_until timestamptz;

-- Premium is active when premium_until is in the future.
create or replace function public.is_premium(p_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select premium_until from public.profiles where id = p_id) > now(), false);
$$;
grant execute on function public.is_premium(uuid) to authenticated;

-- Guard: only the service role (auth.uid() is null in the webhook's context) may
-- change premium_until. A normal authenticated update keeps the old value, so a
-- client can never self-grant Premium even if it sends premium_until in the payload.
create or replace function public.protect_premium_until()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and new.premium_until is distinct from old.premium_until then
    new.premium_until := old.premium_until;
  end if;
  return new;
end; $$;

drop trigger if exists profiles_protect_premium on public.profiles;
create trigger profiles_protect_premium
  before update on public.profiles
  for each row execute function public.protect_premium_until();
