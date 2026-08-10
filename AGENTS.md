# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v54.0.0/ before writing any code.

# Launch work? Read the checklist's §0.0 first

`docs/LAUNCH_CHECKLIST.md` **§0.0** is the single source of truth for what is done and
what is left. It is rewritten at the end of each working session.

Everything below §0.0 in that file is history or reference. **§0.1–§0.2b will confidently
describe finished work as "next"** — they are kept for the reasoning, not the status.
The one exception is **§0.3**, which is still live: three fee rates to reverse the day
Apple's Small Business Program approval arrives.

Two habits this project learned the hard way, both on 2026-08-09:

- **Audit before believing.** A schema audit (parse every `supabase/sql/*.sql` for the
  objects it declares, check them against production) and a deploy-drift audit (compare
  `supabase functions list` against the repo) found **six** real problems that no test
  caught — including a production RevenueCat webhook two days stale, which would have
  granted $19.99 Premium+ buyers the $9.99 tier. Re-run both near launch.
- **Always review money code before it runs.** Two adversarial reviews found 11 money
  bugs, 6 of which could mint money.

Also: **no OTA on this project** (no `expo-updates`) — a production build's JavaScript is
frozen at build time, so every JS fix needs a rebuild.
