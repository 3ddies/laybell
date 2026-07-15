#!/usr/bin/env node
// Drives the stream-backfill edge function in rounds until every legacy MP4
// video post has been migrated to Cloudflare Stream (HLS). Safe to kill and
// re-run at any time — all state lives in the posts table.
//
// Prereqs (one-time):
//   1. Run supabase/sql/stream_backfill.sql in the SQL editor
//   2. supabase secrets set STREAM_BACKFILL_SECRET=<long random string>
//   3. supabase functions deploy stream-backfill
//
// Usage:
//   STREAM_BACKFILL_SECRET=<secret> node scripts/stream-backfill.mjs
//   node scripts/stream-backfill.mjs --secret=<secret> --dry-run   # counts only
//
// Flags:
//   --secret=S      backfill secret (or env STREAM_BACKFILL_SECRET)
//   --batch=N       copies requested per round (1-50, default 10)
//   --interval=S    seconds between rounds (default 15 — encoding takes a while,
//                   hammering faster just burns status polls)
//   --dry-run       one round, no writes: reports remaining/in-flight counts
//   --sweep-only    poll encoding + flip ready posts, but start no new copies
//   --once          run a single round and exit
//   --max-rounds=N  safety stop (default 500)
//
// Supabase URL + anon key are read from lib/supabase.ts (override with env
// SUPABASE_URL / SUPABASE_ANON_KEY if ever needed).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);

function fromSupabaseTs(name) {
  try {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'supabase.ts'), 'utf8');
    const m = src.match(new RegExp(`${name}\\s*=\\s*'([^']+)'`));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL || fromSupabaseTs('supabaseUrl');
const ANON_KEY = process.env.SUPABASE_ANON_KEY || fromSupabaseTs('supabaseAnonKey');
const SECRET = args.secret || process.env.STREAM_BACKFILL_SECRET;

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('Could not resolve the Supabase URL / anon key from lib/supabase.ts — set SUPABASE_URL and SUPABASE_ANON_KEY.');
  process.exit(1);
}
if (!SECRET || SECRET === true) {
  console.error('Missing backfill secret. Pass --secret=<value> or set STREAM_BACKFILL_SECRET (must match the function secret).');
  process.exit(1);
}

const batch = Math.min(50, Math.max(1, Number(args.batch) || 10));
const intervalMs = Math.max(2, Number(args.interval) || 15) * 1000;
const maxRounds = Math.max(1, Number(args['max-rounds']) || 500);
const dryRun = !!args['dry-run'];
const sweepOnly = !!args['sweep-only'];
const once = !!args.once || dryRun;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function round() {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/stream-backfill`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ANON_KEY}`,
      apikey: ANON_KEY,
      'x-backfill-secret': String(SECRET),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ batch, dryRun, sweepOnly }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(`stream-backfill ${res.status}: ${body?.error ?? 'unknown error'}`);
  }
  return body;
}

console.log(`stream-backfill → ${SUPABASE_URL}  (batch=${batch}${dryRun ? ', DRY RUN' : ''}${sweepOnly ? ', sweep only' : ''})`);

let totals = { enqueued: 0, readied: 0, errored: 0 };
for (let r = 1; r <= maxRounds; r++) {
  let out;
  try {
    out = await round();
  } catch (err) {
    console.error(`round ${r} failed: ${err.message}`);
    process.exit(1);
  }
  totals.enqueued += out.enqueued;
  totals.readied += out.readied;
  totals.errored += out.errored;
  console.log(
    `round ${r}: +${out.enqueued} enqueued, +${out.readied} ready, +${out.errored} errored | ` +
    `encoding now: ${out.stillProcessing}, not yet started: ${out.remaining}`,
  );
  if (out.done) {
    console.log(`\nDone — every video post is on Cloudflare Stream. Totals: ${totals.enqueued} enqueued, ${totals.readied} flipped to HLS, ${totals.errored} errored.`);
    if (totals.errored > 0) console.log('Errored rows kept their MP4 playback; see the retry recipe in supabase/sql/stream_backfill.sql.');
    process.exit(0);
  }
  if (once) {
    console.log('\nSingle round complete (run without --once/--dry-run to drive it to completion).');
    process.exit(0);
  }
  await sleep(intervalMs);
}
console.error(`Stopped after ${maxRounds} rounds without finishing — re-run to continue (progress is persistent).`);
process.exit(1);
