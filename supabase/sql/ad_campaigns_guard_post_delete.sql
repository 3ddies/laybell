-- ───────────────────────────────────────────────────────────────────────────
-- Deleting a spotlighted post failed with "Could not delete the post."
--
-- ad_campaigns.post_id is ON DELETE SET NULL, so removing the post makes
-- Postgres run:
--     UPDATE ONLY ad_campaigns SET post_id = NULL WHERE post_id = <id>
--
-- That update runs with the DELETING USER'S privileges, so promo_trusted() is
-- false and ad_campaigns_guard() hit its `new.post_id is distinct from
-- old.post_id` rule and raised `protected_column` — which aborted the whole
-- delete. The post stayed, and the app reported a generic failure.
--
-- The guard is right to protect post_id: re-pointing a funded campaign at a
-- different post is a real attack. What it can't currently do is tell that
-- system-issued cascade apart from a client re-point.
--
-- THE FIX, and why it does not weaken the guard: post_id may go to NULL ONLY
-- when the post it referenced no longer exists. Inside the FK's cascade the
-- post row is already gone in the same transaction, so this passes there and
-- nowhere else. Every other move still raises:
--     A -> B     (re-point)         blocked
--     NULL -> A  (late attach)      blocked
--     A -> NULL  while A still live blocked
-- To reach the allowed case an attacker must first delete the post, which RLS
-- only permits its owner to do — and detaching a campaign from a post you just
-- deleted is precisely the intent.
--
-- Everything else in the function is byte-identical to
-- money_hardening_2026-07-29.sql. Idempotent; safe to re-run.
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.ad_campaigns_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.promo_trusted() then return new; end if;

  if tg_op = 'INSERT' then
    if new.kind is distinct from 'ad' then raise exception 'spotlight_must_use_rpc'; end if;
    if coalesce(new.status, 'pending') <> 'pending' then raise exception 'must_start_pending'; end if;
    -- A client-chosen end date was frozen as trusted once funded. Cap it.
    if new.ends_at is null or new.ends_at > now() + interval '90 days' then
      raise exception 'bad_schedule';
    end if;
    new.budget_cents_total := null;
    new.spent_cents        := 0;
    new.spent_millicents   := 0;
    new.bid_cpm_cents      := null;
    new.price_cents        := 0;
    new.post_id            := null;   -- ads do not carry a post
    return new;
  end if;

  -- Spend may only ever go UP. record_ad_event accrues on every impression and
  -- knows nothing about the trusted flag; freezing these outright threw on every
  -- ad view. Monotonic targets the actual attack — resetting the meter — while
  -- leaving the budget ceiling immovable.
  if new.spent_millicents < old.spent_millicents
     or new.spent_cents   < old.spent_cents
  then
    raise exception 'protected_column';
  end if;

  if new.budget_cents_total is distinct from old.budget_cents_total
     or new.bid_cpm_cents    is distinct from old.bid_cpm_cents
     or new.price_cents      is distinct from old.price_cents
     or new.weight           is distinct from old.weight
     or new.package_key      is distinct from old.package_key
     or new.duration_days    is distinct from old.duration_days
     or new.ends_at          is distinct from old.ends_at
     or new.starts_at        is distinct from old.starts_at
     or new.kind             is distinct from old.kind
     -- post_id is still frozen, with ONE exception: the ON DELETE SET NULL
     -- cascade from a post the owner just deleted (see the header).
     or (new.post_id is distinct from old.post_id
         and not (
           new.post_id is null
           and old.post_id is not null
           and not exists (select 1 from public.posts where id = old.post_id)
         ))
  then
    raise exception 'protected_column';
  end if;

  if new.status is distinct from old.status
     and not (old.status in ('active', 'paused') and new.status in ('active', 'paused', 'ended'))
     and not (old.status = 'pending' and new.status = 'canceled')
  then
    raise exception 'bad_status_transition';
  end if;

  return new;
end $$;

-- The trigger definition is unchanged; re-asserted so this file stands alone.
drop trigger if exists ad_campaigns_guard_trg on public.ad_campaigns;
create trigger ad_campaigns_guard_trg before insert or update on public.ad_campaigns
  for each row execute function public.ad_campaigns_guard();
