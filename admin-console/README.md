# Laybell Moderation Console

A standalone web console for Laybell owners + moderators. It is **not** part of the
React Native app bundle — it's a separate static page that signs in with Supabase Auth
and calls the admin-gated `admin_*` RPCs + the `admin-actions` edge function.

Full architecture + run book: [`../docs/ADMIN_CONSOLE.md`](../docs/ADMIN_CONSOLE.md).

## Run it

```bash
node admin-console/serve.mjs      # → http://localhost:5599
```

…or just **double-click `index.html`** (it's self-contained; loads `supabase-js` from a CDN).

## Sign in

- **Real:** your Laybell account email + password. You must have a row in
  `public.laybell_admins` (see the run book) or it signs you back out.
- **Preview:** leave the email **blank** and click *Sign in* to explore the UI with
  **sample data** — nothing is read from or written to the database. Write actions in
  this mode say "sign in for real to make changes."

## Security

- Holds only the **public anon key** (identical to the one already in `lib/supabase.ts`).
  It contains **no service-role key** — every privileged action is enforced server-side
  by `laybell_admins` role checks in the RPCs / edge function, so this page being public
  is fine. Security rests on Supabase Auth + roles, not on hiding the page.
- Not deployed anywhere yet. Before putting it in front of other moderators, decide the
  hosting origin (public URL relying on the login/role gate, vs. an access-controlled
  host) — see the run book.

## Files

- `index.html` — the whole console (login gate, queue, case drawer, user investigator, audit log).
- `serve.mjs` — a zero-dependency static server (Node built-ins only).
