-- One-time tokens for the parent-consent email round-trip. Run AFTER
-- minor_consent.sql. Used only by the parent-consent / parent-consent-verify
-- Edge Functions (service role) — no client access, so RLS is on with no
-- policies, which locks the table to the service role.

create table if not exists public.parent_consent_tokens (
  token uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  parent_email text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed boolean not null default false
);

alter table public.parent_consent_tokens enable row level security;

create index if not exists parent_consent_tokens_user_idx
  on public.parent_consent_tokens(user_id);
