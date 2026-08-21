// One-off orphan purge after the 2026-08-21 fresh-start reset.
//
// Deletes every storage object EXCEPT the survivor's, across all five buckets.
// Runs against the Storage API because Supabase's protect_delete trigger blocks
// direct DELETE from storage.objects — the same wall that made
// purge_profile_storage() swallow its errors and leave all 248 files behind.
//
// The service_role key arrives on stdin and is never printed or written to disk.
//
//   npx supabase projects api-keys --project-ref <ref> --output json | node storage_purge.mjs [--apply]

const REF      = 'wawpaokvtptfmuygjnns';
const SURVIVOR = '8a88a85f-e01c-426d-9611-4e286f7eb6e5';
const BUCKETS  = ['posts', 'avatars', 'stories', 'shop', 'shop-files'];
const APPLY    = process.argv.includes('--apply');
const BASE     = `https://${REF}.supabase.co/storage/v1`;

let stdin = '';
process.stdin.on('data', (c) => (stdin += c));
process.stdin.on('end', async () => {
  let key;
  try {
    key = JSON.parse(stdin).find((k) => k.name === 'service_role')?.api_key;
  } catch { /* fall through */ }
  if (!key) { console.error('could not read service_role key from stdin'); process.exit(1); }

  const H = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  async function list(bucket, prefix) {
    const r = await fetch(`${BASE}/object/list/${bucket}`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ prefix, limit: 1000, offset: 0 }),
    });
    if (!r.ok) throw new Error(`list ${bucket}/${prefix}: ${r.status} ${await r.text()}`);
    return r.json();
  }

  // Recurse: shop/shop-files nest as <user>/<listing>/<file>, so a single level
  // of listing silently returned nothing for them and 16 objects were missed.
  async function collect(bucket, prefix, out) {
    for (const e of await list(bucket, prefix)) {
      const full = prefix ? `${prefix}${e.name}` : e.name;
      if (e.id === null) await collect(bucket, `${full}/`, out);  // folder
      else out.push(full);                                        // file
    }
  }

  let grand = 0, kept = 0;
  for (const bucket of BUCKETS) {
    const roots = await list(bucket, '');
    const paths = [];
    for (const entry of roots) {
      if (entry.id === null) {
        if (entry.name === SURVIVOR) { kept++; continue; }   // never touch the survivor
        await collect(bucket, `${entry.name}/`, paths);
      } else {
        paths.push(entry.name);
      }
    }
    if (!paths.length) { console.log(`${bucket}: nothing to remove`); continue; }

    if (!APPLY) {
      console.log(`${bucket}: WOULD delete ${paths.length}`);
      grand += paths.length;
      continue;
    }
    // The API takes prefixes in batches; keep them modest so one failure is legible.
    let done = 0;
    for (let i = 0; i < paths.length; i += 100) {
      const chunk = paths.slice(i, i + 100);
      const r = await fetch(`${BASE}/object/${bucket}`, {
        method: 'DELETE', headers: H, body: JSON.stringify({ prefixes: chunk }),
      });
      if (!r.ok) { console.error(`${bucket} delete failed: ${r.status} ${await r.text()}`); process.exit(1); }
      done += (await r.json()).length;
    }
    console.log(`${bucket}: deleted ${done}`);
    grand += done;
  }
  console.log(`${APPLY ? 'DELETED' : 'WOULD DELETE'} ${grand} objects; survivor folders kept: ${kept}`);
});
