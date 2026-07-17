# Email verification & deliverability — release setup

The app side is done: signup routes to a "Confirm your email" screen where the
user types the 6-digit code from the email (`app/(auth)/verify-email.tsx`),
with resend + cooldown, spam-folder hint, and login-side recovery for
unconfirmed accounts. **None of that matters if the email itself is throttled
or lands in spam** — that part is Supabase dashboard + DNS config, and it MUST
be done before launch.

## Why the defaults are not launch-ready

- Supabase's built-in SMTP sends from `noreply@mail.app.supabase.io`, is hard
  rate-limited (~2 emails/hour per project), and routinely lands in spam.
  It exists for development only.
- The default "Confirm signup" template contains only a link
  (`{{ .ConfirmationURL }}`). The in-app code screen needs `{{ .Token }}` in
  the template, or users will get an email with no code to type.

## 1. Custom SMTP (required)

Recommended: **Resend** (resend.com — free tier 3,000 emails/mo, simple DNS)
or Postmark (best inbox placement reputation). Either works; steps below are
provider-agnostic.

1. Create the account, add the sending domain `laybell.app`, and verify it.
2. The provider gives you SPF/DKIM DNS records — add them in GoDaddy
   (DNS for laybell.app):
   - **SPF** — TXT on `@` (or merge into an existing SPF record; a domain may
     have only ONE SPF TXT): `v=spf1 include:<provider-spf-host> ~all`
   - **DKIM** — the CNAME(s)/TXT the provider lists, verbatim.
   - **DMARC** — TXT on `_dmarc`:
     `v=DMARC1; p=quarantine; rua=mailto:3ddiehall@gmail.com; fo=1`
     (start with `p=none` for the first week if you want to observe first,
     then move to `quarantine`).
3. Wait for the provider to show the domain as verified (DNS can take up to
   an hour on GoDaddy).
4. Supabase Dashboard → **Project Settings → Auth → SMTP Settings**: enable
   custom SMTP, paste host/port/username/password from the provider.
   - Sender email: `no-reply@laybell.app`
   - Sender name: `Laybell`
5. Same page: raise the email **rate limits** (Auth → Rate Limits) — the
   defaults are sized for the built-in SMTP; something like 30/hour per
   IP is sane for launch.

## 2. Confirm-signup template (required)

Supabase Dashboard → **Auth → Email Templates → Confirm signup**:

- Subject: `Your Laybell code: {{ .Token }}`
  (a concrete subject with the code both helps users find it and avoids
  vague marketing-ish subjects that spam filters dislike)
- Body must include **both** `{{ .Token }}` (the 6-digit code the app's
  verify screen consumes) and `{{ .ConfirmationURL }}` (fallback path).

Suggested body:

```html
<h2>Confirm your email</h2>
<p>Welcome to Laybell! Enter this code in the app to confirm your address:</p>
<p style="font-size:32px;font-weight:bold;letter-spacing:6px">{{ .Token }}</p>
<p>Or confirm with one tap: <a href="{{ .ConfirmationURL }}">Confirm my email</a></p>
<p>This code expires in 1 hour. If you didn't create a Laybell account, you
can ignore this email.</p>
```

Keep the template plain (little imagery, no link shorteners, no ALL-CAPS) —
transactional-looking email has the best inbox placement.

## 3. Auth settings sanity check

Dashboard → **Auth → Providers → Email**:

- **Confirm email: ON** for release (the app fully supports OFF too — signup
  then sessions immediately — but ON is what you want live).
- **OTP expiry**: 3600s (1h) is a good default — matches the template text.
- **Site URL** (Auth → URL Configuration): `https://laybell.app`, so the
  fallback `{{ .ConfirmationURL }}` lands somewhere branded after verifying.
  (Users who tap the link get confirmed in the browser, then just log in
  in the app — the login screen handles this.)

## 4. Pre-launch test checklist

- [ ] Sign up with a **Gmail**, an **Outlook/Hotmail**, and an **iCloud**
      address — email arrives in the **inbox** (not spam) on all three.
- [ ] Send a signup email to the address from **mail-tester.com** — score ≥ 9/10
      (it checks SPF/DKIM/DMARC alignment and content spamminess).
- [ ] Code path: type the 6-digit code in the app → lands in onboarding.
- [ ] Link path: tap the email link instead → browser confirms → log in from
      the app works (no "Email not confirmed" error).
- [ ] Resend: button disabled for 60s, then works; second code verifies.
- [ ] Wrong code: clear error, field resets, can retry.
- [ ] Existing email signup: shows "account already exists", no email sent.

## App-side behavior (for reference)

- `app/(auth)/signup.tsx` — no session after signup → pushes
  `/(auth)/verify-email?email=…`; detects Supabase's obfuscated
  repeat-signup response (user with zero identities) and shows
  "already exists" instead of waiting for an email that won't come.
- `app/(auth)/verify-email.tsx` — 6-digit input (auto-submits, supports
  iOS one-time-code autofill), `verifyOtp` type `signup` with `email`
  fallback, resend with 60s cooldown, spam-folder hint, links back to
  login/signup. On success the session fires the root auth listener →
  onboarding.
- `app/(auth)/login.tsx` — "Email not confirmed" → auto-resends and routes
  to the verify screen; friendly messages for bad credentials/rate limits.
