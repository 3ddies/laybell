# Fresh-start reset — wipe test data before launch

**Requested by the owner 2026-08-03. NOT YET RUN. Do not run without an explicit
go-ahead in the moment — this is irreversible.**

Goal: after testing is finished, remove every account, post and test artefact so
Laybell launches clean, **keeping only `laybellreview`** (the seeded store-review
account Apple and Google both sign in with).

---

## Decisions needed from the owner BEFORE writing the script

1. **Does `laybellreview` keep its posts?** "Kill every account, post and test
   item except the laybellreview account" is ambiguous on this. Reviewers need
   to see a working app, and an empty demo account is itself a rejection risk —
   so the default assumption is **keep its content**, but confirm.
2. **Keep the owner's own account(s)?** `@observer` / `@rachaelhall` are real
   accounts with real posts. Deleting them is the literal reading; keeping one
   as founder account may be what's actually wanted.
3. **Timing vs. the store review.** If Apple or Google are mid-review when this
   runs, reviewers hit an app that just changed under them. Run it *before*
   submitting, or *after* approval — not during.

---

## The three hazards that are not obvious

**1. The ledger cannot be deleted from.** `ledger_entries` has an append-only
trigger (`ledger_immutable`, supabase/sql/ledger.sql) that raises on UPDATE **and
DELETE** — by design, so money history can't be rewritten. A wipe therefore has
to either drop/recreate the trigger around a truncate, or truncate the ledger
tables outright and re-seed. Whichever we choose, `laybellreview`'s $500 credit
grant must be **re-run afterwards** (`supabase/sql/seed_review_account.sql`), or
the demo account is left with Premium but no credits and the "full access"
declaration on Play becomes false.

**2. Deleting rows does NOT delete the media.** Two separate stores keep billing
and serving after the database forgets them:
   - **Supabase Storage** — buckets `posts`, `avatars`, `stories`, `shop`,
     `shop-files`. Files stay downloadable by URL after their rows vanish.
   - **Cloudflare Stream** — every single-video post lives there, and the DB only
     keeps the HLS manifest URL. Nothing in the schema stores the Stream UID as
     its own column, so the UIDs have to be parsed back out of `media_url`
     (`customer-*.cloudflarestream.com/<uid>/manifest/video.m3u8`) *before* the
     rows are deleted, or they become unreachable orphans that bill monthly.
     **Collect the UID list first; delete rows second.**

**3. Auth users are the root.** Deleting from `auth.users` cascades widely, which
is what we want, but it means the order is: gather media references → delete
auth users (cascade) → sweep storage → sweep Cloudflare → re-seed the review
account → verify.

---

## Scope — what a full reset touches

Content and social graph: `posts`, `comments`, `likes`, `saves`, `follows`,
`stories`, `playlists`, `playlist_tracks`, `messages`, `conversations`,
`conversation_members`, `message_reactions`, `notifications`, `push_tokens`,
`blocks`, `reports`, `follow_events`.

Commerce: `shop_listings`, `shop_orders`, `donations`, ledger tables,
`spotlight`/ad tables, `ad_*`.

Live/studio: `studio_sessions`, `studio_session_members`, `live_*`.

Communities and badges: `communities`, membership tables, badge rollups.

Auth/profile: `profiles`, then `auth.users`.

---

## Verification after the run

- `laybellreview` still signs in, still Premium, credits back to 50000
- `select count(*) from auth.users` = expected survivors only
- `select * from ledger_verify()` returns **zero rows** (the ledger still balances)
- Storage buckets empty except the review account's files
- Cloudflare Stream dashboard shows no orphaned videos
- The app opens on a fresh install with an empty feed and no errors

---

## When it runs

Write the script **at that moment**, against the schema as it then stands — not
now. 123 migrations exist and more will land; a reset script written today would
silently miss whatever tables arrive between now and then. The value of this
document is the hazards and the ordering, which don't change.
