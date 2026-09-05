-- Does the list actually exclude what it claims to?
select
  (select count(*) from public.profiles)                                as accounts,
  (select count(*) from public.marketing_email_list)                    as mailable,
  (select count(*) from auth.users where email_confirmed_at is null)    as unconfirmed_excluded,
  (select count(*) from public.profiles where coalesce(hidden,false))   as hidden_excluded,
  (select count(*) from public.profiles where coalesce(is_minor,false)) as minors_on_platform,
  (select count(*) from public.profiles p
     where coalesce(p.is_minor,false) and p.marketing_opt_in)           as minors_still_opted_in,
  -- The new default must not have back-filled a consent timestamp onto anyone.
  (select count(*) from public.profiles where marketing_opt_in_at is not null) as explicit_choices;
