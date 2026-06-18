-- Parental consent for users aged 13–17 (Laybell's minimum age is 13; under-13
-- is blocked entirely). Run once in the Supabase SQL editor.
--
-- Captured during onboarding's "About you" step: when the entered date of birth
-- indicates an age of 13–17, the user must supply a parent/guardian email and
-- check a box attesting that the parent/guardian agreed to the Terms and Privacy
-- Policy on their behalf. The app then writes the columns below.
--
-- IMPORTANT: this records consent INTENT (an in-app attestation). To make the
-- consent "verifiable" (the stronger standard, and what regulators expect for
-- younger minors), add an out-of-band confirmation step — e.g. email the parent
-- a one-time link and set parent_consent_verified = true only when they click
-- it. See the rollout notes. The verified flag defaults to false so you can
-- layer that on later without a schema change.

alter table public.profiles
  add column if not exists is_minor boolean not null default false,
  add column if not exists parent_email text,
  add column if not exists minor_consent_at timestamptz,
  add column if not exists parent_consent_method text,
  add column if not exists parent_consent_verified boolean not null default false;

comment on column public.profiles.is_minor is 'True when the user self-reported an age of 13–17 at onboarding.';
comment on column public.profiles.parent_email is 'Parent/guardian email captured for a minor (private; never shown publicly).';
comment on column public.profiles.minor_consent_at is 'Timestamp the minor attested to parental/guardian consent.';
comment on column public.profiles.parent_consent_method is 'How consent was obtained, e.g. onboarding_attestation.';
comment on column public.profiles.parent_consent_verified is 'True only after out-of-band parent confirmation (e.g. an email link). Defaults false.';
