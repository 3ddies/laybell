// SCHEMA AUDIT — what the repo DECLARES vs what production actually HAS.
//
// Run it, then run the SQL it writes:
//     node scripts/schema-audit.mjs
//     npx supabase db query --linked -f scripts/.schema-audit.sql
//
// Written after 2026-08-09, when this exact check found three migrations that
// had never been applied — including one that let accounts with open moderation
// reports delete themselves immediately, and one that meant artists were never
// credited for ambient plays. Everything LOOKED fine; nothing user-visible was
// broken. Re-run it before launch, and any time a .sql file is edited after it
// was first run (that is how the drift happened: the file changed, the database
// did not).
//
// It parses every create/alter in supabase/sql for tables, functions, columns,
// triggers and indexes, then asks the database which of them are absent.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../supabase/sql/', import.meta.url));
const files = readdirSync(DIR).filter((f) => f.endsWith('.sql'));

const tables = new Map();   // name -> file
const funcs = new Map();    // name -> file
const columns = new Map();  // "table.col" -> file
const triggers = new Map(); // "table.trigger" -> file
const indexes = new Map();  // name -> file

const add = (map, key, file) => { if (key && !map.has(key)) map.set(key, file); };

for (const f of files) {
  // _VERIFY_* are read-only checks; they create nothing.
  if (f.startsWith('_VERIFY')) continue;
  const sql = readFileSync(DIR + f, 'utf8')
    // strip line comments so commented-out DDL isn't counted
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z0-9_]+)/gi)) add(tables, m[1].toLowerCase(), f);
  for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.([a-z0-9_]+)\s*\(/gi)) add(funcs, m[1].toLowerCase(), f);
  for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?public\.([a-z0-9_]+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)/gi))
    add(columns, `${m[1].toLowerCase()}.${m[2].toLowerCase()}`, f);
  // Deliberately only `on public.X`: triggers on auth.users (e.g.
  // on_auth_user_created) live in another schema, and looking them up in public
  // reported a permanent false positive.
  // \bon — without the boundary this matched the tail of "functiON public.foo"
  // in `execute function public.handle_new_user()`, recording the FUNCTION as
  // the trigger's table and reporting a permanent phantom every run.
  for (const m of sql.matchAll(/create\s+trigger\s+([a-z0-9_]+)[\s\S]{0,120}?\bon\s+public\.([a-z0-9_]+)/gi))
    add(triggers, `${m[2].toLowerCase()}.${m[1].toLowerCase()}`, f);
  for (const m of sql.matchAll(/create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([a-z0-9_]+)\s+on/gi))
    add(indexes, m[1].toLowerCase(), f);
}

const lit = (s) => `'${s.replace(/'/g, "''")}'`;
const values = (map) => [...map.keys()].map((k) => `(${lit(k)})`).join(',');

const sql = `
-- AUDIT: which declared objects are MISSING from the live database?
with
want_t(n) as (values ${values(tables)}),
want_f(n) as (values ${values(funcs)}),
want_c(n) as (values ${values(columns)}),
want_g(n) as (values ${values(triggers)}),
want_i(n) as (values ${values(indexes)})
select json_build_object(
  'counts', json_build_object(
    'tables_declared', (select count(*) from want_t),
    'functions_declared', (select count(*) from want_f),
    'columns_declared', (select count(*) from want_c),
    'triggers_declared', (select count(*) from want_g),
    'indexes_declared', (select count(*) from want_i)
  ),
  'missing_tables', (
    select coalesce(json_agg(n order by n), '[]'::json) from want_t
    where n not in (select tablename from pg_tables where schemaname='public')
      and n not in (select table_name from information_schema.views where table_schema='public')
  ),
  'missing_functions', (
    select coalesce(json_agg(n order by n), '[]'::json) from want_f
    where n not in (select p.proname from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public')
  ),
  'missing_columns', (
    select coalesce(json_agg(n order by n), '[]'::json) from want_c
    where n not in (select table_name||'.'||column_name from information_schema.columns where table_schema='public')
  ),
  'missing_triggers', (
    select coalesce(json_agg(n order by n), '[]'::json) from want_g
    where n not in (
      select c.relname||'.'||t.tgname from pg_trigger t
      join pg_class c on c.oid=t.tgrelid join pg_namespace ns on ns.oid=c.relnamespace
      where ns.nspname='public' and not t.tgisinternal)
  ),
  'missing_indexes', (
    select coalesce(json_agg(n order by n), '[]'::json) from want_i
    where n not in (select indexname from pg_indexes where schemaname='public')
  )
) as audit;
`;

writeFileSync(new URL('.schema-audit.sql', import.meta.url), sql, 'utf8');
console.log(`Parsed ${files.length} files → tables ${tables.size}, functions ${funcs.size}, columns ${columns.size}, triggers ${triggers.size}, indexes ${indexes.size}`);
writeFileSync(new URL('.schema-audit-map.json', import.meta.url),
  JSON.stringify({ tables: [...tables], funcs: [...funcs], columns: [...columns], triggers: [...triggers], indexes: [...indexes] }, null, 1), 'utf8');
