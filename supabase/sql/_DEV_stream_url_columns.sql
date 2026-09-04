-- READ ONLY. Find every column in the public schema that actually CONTAINS a
-- Cloudflare Stream URL, by looking at the data rather than guessing from names.
--
--   npx supabase db query --linked -f supabase/sql/_DEV_stream_url_columns.sql
--
-- stream-sweep deletes any Stream asset it cannot find a reference for, so its
-- reference set has to be complete. A uid recorded in a column the sweep does
-- not read is indistinguishable from an abandoned upload — and gets deleted.
--
-- Walks every text/jsonb column and counts rows whose value mentions
-- cloudflarestream.com. Slow, but it runs once and it is the difference between
-- a reference list that is believed and one that is checked.

do $$
declare
  r        record;
  v_count  bigint;
  v_out    text := '';
begin
  create temp table if not exists _stream_cols(tbl text, col text, hits bigint) on commit drop;
  delete from _stream_cols;

  for r in
    select c.table_name, c.column_name, c.data_type
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public'
       and t.table_type = 'BASE TABLE'
       and c.data_type in ('text', 'character varying', 'jsonb', 'json')
  loop
    begin
      execute format(
        'select count(*) from public.%I where %I::text ilike %L',
        r.table_name, r.column_name, '%cloudflarestream.com%'
      ) into v_count;
    exception when others then
      v_count := -1;  -- unreadable column; reported rather than silently skipped
    end;

    if v_count <> 0 then
      insert into _stream_cols values (r.table_name, r.column_name, v_count);
    end if;
  end loop;
end $$;

select tbl as table_name, col as column_name, hits as rows_containing_stream_url
  from _stream_cols
 order by hits desc, tbl, col;
