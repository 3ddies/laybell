# Laybell Admin / Moderation Console

The private tool for the owner + moderators to **monitor, regulate, moderate,
investigate, and manage** Laybell. This doc is the architecture + run book.

Status: **Phase 1 (backend) built** — SQL + edge function in this repo, awaiting a
manual run. Phases 2–4 (the UI + legal hardening) are scoped below.

---

## The core decision — why a *separate*, service-role surface

Laybell's schema was deliberately built anticipating "a future admin tool" (see the
note at the bottom of `supabase/sql/moderation_preservation.sql`): the six report
tables carry tamper-proof snapshots, `legal_hold` preserves evidence, and **none of
the report tables has a client read policy** — they are meant to be read only by a
trusted, service-role surface.

That settles the big question: **the moderation tool must NOT be code shipped inside
the consumer app.** The app bundle only holds the public anon key and is bound by
RLS; it cannot (and must never) hold the service-role key. So the console is a
**separate web surface** that authenticates as a Supabase user and calls a new,
admin-gated backend.

### Three layers

1. **Admin-gated Postgres RPCs** (`SECURITY DEFINER`, guarded by
   `has_admin_role(auth.uid(), …)`). These do the *bulk* of the work — the unified
   queue, evidence reads, resolve, warn/suspend/shadow-ban, hide account/content,
   legal-hold, escalate, blocklist, audit reads, roster management. **No service-role
   key is involved**; the console calls them with the admin's normal session via
   `supabase.rpc(...)`.
2. **One `admin-actions` edge function** (service role) for the *only* things RPCs
   can't do: the auth-plane operations (`ban` / `unban` / `hard_delete`) and reading
   `auth.users` (`auth_info`). The service-role key stays inside Supabase infra.
3. **The console UI** (Phase 2) — a separate web app that holds no secrets and no
   privileged data at rest.

```
 ┌────────────────────┐   supabase.rpc()      ┌──────────────────────────────┐
 │  Console (web UI)  │ ────────────────────▶ │  admin_* RPCs (SECURITY       │
 │  Supabase Auth     │                       │  DEFINER, role-guarded)       │
 │  (admin's session) │ ── fetch() ─────────▶ │  admin-actions edge fn        │
 └────────────────────┘   Bearer JWT          │  (service role, owner-only)   │
        no service role                       └──────────────────────────────┘
```

---

## What Phase 1 ships (in this repo)

| File | What it does |
|------|--------------|
| `supabase/sql/admin_console.sql` | Upgrades `laybell_admins` to graded roles; adds `is_laybell_admin()` / `has_admin_role()` / `current_admin_role()`; creates `admin_audit_log` (append-only), `moderation_cases`, `user_sanctions`, `content_takedowns`; backfills `resolved_at` + snapshots + FK fixes on the report tables; adds the server-side **enforcement RLS**. |
| `supabase/sql/admin_console_rpcs.sql` | Every admin RPC (queue, case detail, user detail, resolve, warn/suspend/shadow-ban/hide, content takedown/restore, legal-hold, escalate, blocklist, audit, roster). |
| `supabase/functions/admin-actions/index.ts` | The owner-only edge function: `ban`, `unban`, `hard_delete`, `auth_info`. |

Everything is **idempotent**, **additive**, and **OTA-safe** (no app rebuild). Every
new enforcement rule is keyed on a table that starts **empty**, so running the SQL
changes nothing users see until a moderator acts.

---

## Run book

### 1. Run the SQL (Supabase Dashboard → SQL Editor)

```
1. Paste + run  supabase/sql/admin_console.sql
2. Paste + run  supabase/sql/admin_console_rpcs.sql
```

Prereqs: `laybell_communities.sql`, `post_reports.sql`, `user_reports.sql`,
`conversation_reports.sql`, `shop.sql`, `ad_ecosystem.sql`, `link_safety.sql`,
`group_chats.sql`, `moderation_preservation.sql`, `account_hidden.sql`. Section 0 of
`admin_console.sql` checks **all** of them at once and raises a single list of exactly
what to run — so run `admin_console.sql` first and it will tell you if anything is
missing. (`account_deletion_sweep.sql` is *not* required.)

> **Your current run hit this:** `moderation_preservation.sql` hasn't been applied
> yet. Run it (it's idempotent and safe), plus anything else Section 0 lists, then
> re-run `admin_console.sql`.

### 2. Promote yourself to `owner`

Everyone in `laybell_admins` defaults to the lowest tier (`reviewer`) until promoted.

```sql
select id, email from auth.users where email = 'you@example.com';

insert into public.laybell_admins (user_id, role)
  values ('<YOUR-AUTH-USER-ID>', 'owner')
  on conflict (user_id) do update set role = 'owner', disabled_at = null;
```

### 3. Deploy the edge function

```
supabase functions deploy admin-actions
```

`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are injected automatically. Keep the
default `verify_jwt = true` so only signed-in callers reach it — the owner-role check
inside is the real gate.

### 4. Smoke-test the live app as a NORMAL user

The enforcement RLS touches the live read **and** write path. With the tables empty
nothing should change, but confirm:

- Browse the feed / a profile → content still shows.
- Create a post, a comment, and send a DM → all still succeed.

If any of those break, the culprit is the Section 7 policies in `admin_console.sql`
— drop the offending `restrictive` policy and file it.

### 5. Try the backend (before the UI exists)

As your owner user, from any Supabase client / the SQL editor's RPC caller:

```sql
select * from public.admin_list_queue();                 -- the moderation queue
select public.admin_get_case('user', '<uuid>');          -- one case's evidence
select public.admin_warn_user('<uuid>', 'spam in comments');
select public.admin_suspend_user('<uuid>', 1440, 'harassment');   -- 24h
```

`ban` / `unban` / `hard_delete` / `auth_info` go through the edge function:

```
POST https://<ref>.functions.supabase.co/admin-actions
Authorization: Bearer <your session JWT>
{ "action": "ban", "user_id": "<uuid>", "reason": "…" }
```

---

## Roles

| Role | Can |
|------|-----|
| **reviewer** | Read the queue, case evidence, user detail (no email), and the audit log. |
| **moderator** | reviewer + resolve, warn, suspend, shadow-ban, hide account/content, **set** legal-hold, escalate, manage the link blocklist. |
| **owner** | moderator + **release** legal-hold, de-anonymize reporters, read `auth.users` email/ban, **ban / unban / hard-delete**, grant/revoke admins. |

## Action catalog (all audited to `admin_audit_log`)

`view_queue` · `view_evidence` · `resolve_report` / `update_case` · `warn` ·
`suspend` · `shadow_ban` · `hide_account` · `hide_content` / `restore` ·
`legal_hold_set` (mod) / `legal_hold_release` (owner) · `escalate` (auto-holds the
subject) · `blocklist_add` / `blocklist_remove` · `ban` / `unban` / `hard_delete`
(owner, edge fn) · `grant_role` / `revoke_admin` (owner).

---

## Security model — the rules that must hold

- **The service-role key never enters the app or the console bundle.** It lives only
  in the `admin-actions` edge function's injected env. A build check should grep-fail
  if `SERVICE_ROLE` ever appears in web output.
- **Reporter anonymity.** `reporter_id` is stripped from the queue and from case
  evidence for everyone below `owner`; RLS already hides it from the reported party.
- **Least privilege.** `reviewer` never sees `auth.users` email or DM contents. There
  is **no** admin read path into 1:1 message bodies — the Privacy Policy promises they
  are private; do not add one casually.
- **Append-only audit.** `admin_audit_log` blocks UPDATE/DELETE via trigger, even for
  the service role. It is the legal record of who did what.
- **Preserve, don't destroy.** `legal_hold` freezes evidence; `hard_delete` refuses on
  a held account. Takedowns are reversible soft-removes that keep the row + snapshot.

---

## Roadmap

- **Phase 2 + 3 — the console (BUILT).** `admin-console/index.html` — a standalone
  single-file web app (holds only the public anon key; **not** part of the RN app
  bundle). Login → `current_admin_role()` gate → **Queue** (`admin_list_queue`) →
  **case drawer** with the full action catalog (resolve/dismiss, warn, suspend,
  shadow-ban, hide account, hide/restore content, legal-hold, escalate, blocklist) →
  **User investigator** (`admin_user_detail`) → **Audit log**. Owner-only ban / unban /
  auth-info / hard-delete route through the `admin-actions` edge fn.
  **Run it:** double-click `admin-console/index.html`, or `node admin-console/serve.mjs`
  → http://localhost:5599 (also wired as the "AdminConsole" launch config). *Open
  decision remaining:* where to host it for other moderators (see below) — it is not
  deployed anywhere yet.
- **Phase 4 — legal / retention hardening.** The explicit TODOs from
  `moderation_preservation.sql`: the NCMEC/CyberTipline escalation workflow (a binding
  18 U.S.C. §2258A duty once CSAM is encountered), a locked media-retention bucket
  (snapshots keep only dead URLs today, not the bytes), and scheduled retention-window
  purges per Privacy Policy §9. Plus `comment_reports`, a scoped appeals flow, and
  turning on RLS for `public.comments` so comment takedown enforces.

## Open decisions for the owner (Phase 2)

1. **Frontend.** Recommended: **Expo web** (`react-native-web`, already a dep) exported
   as a static SPA — reuses the existing stack, the `lib/supabase.ts` client, and any
   existing web deploy pipeline; holds no secrets. Runner-up: a **Next.js/Vercel** app
   with a real server tier (nicer for heavy evidence views) at the cost of a new hosting
   tier + a service-role secret one misconfig from the browser.
2. **Hosting origin.** A static SPA on a public host (e.g. GitHub Pages) is reachable by
   anyone — all security then rests on Supabase Auth + the `laybell_admins` role checks
   (which is the design). If a public origin is unacceptable, host the frontend behind
   access control (Vercel/EAS Hosting with auth); the RPC + edge-fn backend is identical
   either way.
