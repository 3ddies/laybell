-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICATION — did every 2026-07-28 migration actually land?
-- Read-only. Changes nothing. Safe to run any time.
--
-- A migration that half-applies is worse than one that fails outright: the
-- failure is loud, the half-application is silent until a feature misbehaves
-- weeks later. This checks each object individually rather than trusting that
-- "the script ran without error".
--
-- Every row should read PASS. Anything else names the file to re-run.
-- ════════════════════════════════════════════════════════════════════════════

with expected(kind, obj, source) as (values
  -- ── Tables ───────────────────────────────────────────────────────────────
  ('table', 'blocked_terms',              'content_filter.sql'),
  ('table', 'shop_downloads',             'shop_downloads.sql'),
  ('table', 'access_log',                 'access_log.sql'),
  ('table', 'stream_hours_daily',         'stream_hours.sql'),
  ('table', 'ledger_accounts',            'ledger.sql'),
  ('table', 'ledger_transactions',        'ledger.sql'),
  ('table', 'ledger_entries',             'ledger.sql'),
  ('table', 'copyright_notices',          'copyright_strikes.sql'),
  ('table', 'copyright_strikes',          'copyright_strikes.sql'),
  ('table', 'copyright_counter_notices',  'copyright_strikes.sql'),
  ('table', 'copyright_terminations',     'copyright_strikes.sql'),

  -- ── Functions ────────────────────────────────────────────────────────────
  ('function', 'is_minor',                'minor_safety.sql'),
  ('function', 'ledger_post',             'ledger.sql'),
  ('function', 'ledger_account',          'ledger.sql'),
  ('function', 'my_ledger_balance',       'ledger.sql'),
  ('function', 'ledger_verify',           'ledger.sql'),
  ('function', 'record_listen_seconds',   'stream_hours.sql'),
  ('function', 'bmi_license_usage',       'stream_hours.sql'),
  ('function', 'copyright_action_notice', 'copyright_strikes.sql'),
  ('function', 'copyright_restores_due',  'copyright_strikes.sql'),
  ('function', 'is_terminated_email',     'copyright_strikes.sql'),
  ('function', 'add_business_days',       'copyright_strikes.sql'),
  ('function', 'withdraw_sound',          'sound_optin.sql'),
  ('function', 'allow_sound',             'sound_optin.sql'),
  ('function', 'set_live_replay',         'live_replay.sql'),
  ('function', 'delivered_earnings',      'wallet_earnings.sql'),

  -- ── Columns ──────────────────────────────────────────────────────────────
  ('column', 'posts.copyright_removed_at',         'copyright_strikes.sql'),
  ('column', 'shop_listings.copyright_removed_at', 'copyright_strikes.sql'),
  ('column', 'posts.sound_opt_in',                 'sound_optin.sql'),
  ('column', 'posts.sound_withdrawn_at',           'sound_optin.sql'),
  ('column', 'posts.sound_opt_in_at',              'sound_optin.sql'),
  ('column', 'live_streams.save_replay',           'live_replay.sql'),
  ('column', 'live_streams.replay_attested_at',    'live_replay.sql'),

  -- ── View ─────────────────────────────────────────────────────────────────
  ('view', 'my_ledger_statement',         'ledger.sql')
)
select
  e.source,
  e.kind,
  e.obj,
  case
    when e.kind = 'table' then
      case when to_regclass('public.' || e.obj) is not null then 'PASS' else 'MISSING' end
    when e.kind = 'view' then
      case when exists (select 1 from information_schema.views
                         where table_schema = 'public' and table_name = e.obj)
           then 'PASS' else 'MISSING' end
    when e.kind = 'function' then
      case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                         where n.nspname = 'public' and p.proname = e.obj)
           then 'PASS' else 'MISSING' end
    when e.kind = 'column' then
      case when exists (select 1 from information_schema.columns
                         where table_schema = 'public'
                           and table_name  = split_part(e.obj, '.', 1)
                           and column_name = split_part(e.obj, '.', 2))
           then 'PASS' else 'MISSING' end
  end as status
from expected e
order by status desc, e.source, e.kind, e.obj;
