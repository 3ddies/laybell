# Laybell's email list

Built 2026-09-05. **The consent plumbing is done and live. Nothing sends yet.**

## What exists

| Piece | Where |
|---|---|
| `marketing_opt_in` + `marketing_opt_in_at` on `profiles` | `supabase/sql/email_marketing_optin.sql` — **applied to production** |
| Signup checkbox, ticked by default | `app/(auth)/signup.tsx` |
| Off automatically for minors | `app/onboarding.tsx` (fires when the date of birth says under 18) |
| In-app off switch | Settings → Notifications → "Emails from Laybell" |
| Who may be mailed | `public.marketing_email_list` view |
| One-click unsubscribe | `supabase/functions/unsubscribe` — **deployed**, `UNSUBSCRIBE_SECRET` set |
| Link + header builder for the sender | `scripts/unsubscribe-token.mjs` |
| Policy disclosure | `lib/legal/privacy.json` §19, HTML regenerated |

Read the list — never a hand-written query. It already excludes opt-outs, hidden
accounts, unconfirmed addresses and minors, and it is the only place those rules
live:

```sql
select * from public.marketing_email_list;
```

## Before the first send

1. **Every message needs the unsubscribe link and the postal address.**
   `scripts/unsubscribe-token.mjs` gives both the URL and the RFC 8058 headers.
   Address: `Laybell LLC, 28 Rivers Edge Ter, Indian Head, MD 20640`.
2. **App Store Connect → App Privacy.** Contact Info → Email Address currently
   declares App Functionality. Add **Developer's Marketing** as a purpose. This is
   a form, not a build — it can be done without shipping.
   Google Play → Data safety needs the same purpose adding.
3. **Send yourself one first**, click the unsubscribe link, and confirm the
   Settings switch has flipped. The whole path was tested end to end on
   2026-09-05 against a real account (and restored afterwards), but that was
   before any actual mail existed.

## The rule that will change

The checkbox is ticked by default because **Laybell is United States only** and
CAN-SPAM is an opt-OUT regime — prior consent is not required, a working
unsubscribe is.

**The day Laybell ships to another country this must flip.** A pre-ticked box is
expressly not consent under the GDPR (the CJEU settled it in *Planet49*), and
Canada's CASL wants express consent too. Then:

- `marketing_opt_in` defaults to `false`
- the signup checkbox ships unticked
- accounts created before the change keep whatever they have —
  `marketing_opt_in_at` is null for everyone who took the default, which is
  exactly the set that cannot be treated as having consented

That column is the reason the switch is a one-day job rather than a rebuild of
the list.

## Things deliberately NOT done

- **No sender.** No template, no schedule, no Resend integration for marketing.
  `RESEND_API_KEY` exists and is used for transactional mail (verification,
  parent consent); marketing should use its own from-address so a deliverability
  problem with one cannot take down the other.
- **No bounce or complaint handling.** Repeatedly mailing a dead address, or one
  that has marked you spam, is how a sending domain's reputation dies. Worth a
  Resend webhook that flips `marketing_opt_in` off on hard bounce and on
  complaint, before volume makes it matter.
