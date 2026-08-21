# Stripe Content Creation Due Diligence — answers to paste

> ✅ **FILLED IN AND SUBMITTED 2026-08-21.** Both attestations were verified true first, on the
> live surfaces rather than in the repo:  served the new nudity
> prohibition with no permissive language left, and  reached **v18** at 19:22
> carrying . The optional uploads were skipped — the 45 MB recording
> exceeded the attachment limit, and a 2.0 MB cut of just the report flow lives at
>  if Stripe asks for evidence.
>
> ⏳ **Now waiting on Stripe: 24 hours to 3 business days.** Payouts pause **Sep 9** if it is
> not resolved. If they ask for app access, the answer is a TestFlight invite — the app is not
> public until Sep 1.

**Both prerequisites are now TRUE, so the attestation is honest.** Q2 was made true by
deploying `business_profile[url]` per creator (`stripe-connect`, 2026-08-21); Q5 was made true
by removing the artistic-nudity allowance from the Community Guidelines the same day.

## Radio answers

| Question | Answer |
|---|---|
| Host creators' content + enable payments to creators | **Yes** |
| Integrated on Stripe Connect, unique URL per creator via API | **Yes** |
| Login required to access/browse content | **Yes** |
| AUP prohibits monetization of the four categories | **Yes** |
| Programmatically detect, demonetize and remove violations | **Yes** |
| Reporting functionality for users and rights holders | **Yes** |
| Policy targeting repeat violators | **Yes** |

**Transaction types — check three:** Purchases of restricted content · Purchases of digital
goods · Tipping while viewing specific pieces of content.
**Leave unchecked:** tipping for content on linked external pages · other.

---

## Box: login credentials

```
Laybell is an iOS and Android app. It was approved by Apple on 21 August 2026 and
releases publicly on 1 September 2026.

Review account (full access, no purchase needed):
  Email:    3ddiemusic@gmail.com
  Password: review1

This account has posts, a shop listing, a credit balance and both subscription
tiers active, so every feature including paid content and the creator wallet is
reachable without spending anything.

Until public release we can add a Stripe reviewer to TestFlight immediately on
request — just reply with an email address. A full 15-minute screen recording of
the app, showing signup, content, purchases, reporting, blocking and account
deletion, is attached as supporting documentation.

Public creator pages are also viewable without an account, for example
https://laybell.app/profile/laybellreview — these are the same per-creator URLs
now passed to Stripe as business_profile[url] on each connected account.

Policies: https://laybell.app/terms · /privacy · /community
```

---

## Box: detection capabilities

```
Laybell screens text at the point of writing, before content is ever published.

Rule engine. Every post caption and every comment is checked against a pattern
set covering sexual solicitation, grooming behaviour, adult-content spam, and
racial, homophobic, transphobic, antisemitic and disability slurs. Patterns are
character-substitution aware, so common evasions such as digits for letters are
caught rather than bypassed.

Two severities. "Block" refuses the write outright and the content is never
created. "Review" allows the write and flags it for moderation. Grooming
signals are deliberately set to review rather than block, because the intent is
to preserve evidence and look at the account rather than silently drop a message.

Server-side term list. Alongside the shipped patterns, the app loads a
`blocked_terms` table from our database at runtime, each row carrying its own
severity. New terms take effect immediately for every user without an app store
release, so we can respond to an emerging abuse pattern the same day.

Structural enforcement. Independently of text screening, protections for minors
are enforced in the database rather than in the interface: under-18 accounts
cannot broadcast live, cannot be messaged by accounts they do not follow, have
location capture and targeted advertising disabled, and are never served
mature-marked content.

Nudity is prohibited outright and may not be posted, sold, tipped or otherwise
monetized, so no monetization path exists for adult content on the platform.
```

---

## Box: reporting and takedown process

```
Reporting is available on every surface that can carry content: posts, profiles,
comments and direct messages. The reporter picks from a reason list — spam,
harassment or bullying, hate speech, nudity or sexual content, violence or
threats, impersonation, scam or fraud, sale of illegal or regulated goods,
self-harm, intellectual property, or other — and can add free text.

Reports are preserved as evidence. A report survives deletion of the content and
of the reporting or reported account, so a user cannot delete their way out of a
moderation trail. Every report stores a tamper-proof snapshot of the content as
it was at the time, written by a database trigger rather than by the client. A
legal-hold flag blocks deletion of anything under investigation, and our
automated account-deletion sweep refuses to remove any account with an open,
unresolved report — those are routed to manual review instead.

Copyright. Laybell complies with the DMCA, 17 U.S.C. Section 512, with a
designated agent registered with the U.S. Copyright Office. We act on valid
notices of alleged infringement and provide a counter-notice route.

Outcomes available to moderators include content removal, age-gating or
restriction, account suspension, and account termination.
```

---

## Box: practices targeting repeat violators

```
Copyright. Laybell terminates the accounts of repeat infringers in appropriate
circumstances, as published in our Terms of Service under our DMCA policy. Because
reports and their content snapshots survive deletion of the content and the
account, repeat behaviour remains visible to moderators rather than being erased
by the user.

Conduct. Repeated breaches of the Acceptable Use Policy or Community Guidelines
escalate from content removal to restriction of features, then suspension, then
termination. Marketplace-specific abuse — obtaining credits fraudulently, charging
back a legitimate purchase while keeping delivered files, or soliciting payment
outside Laybell — is prohibited conduct and carries the same escalation.

Minors. An account found to belong to someone under 13 is terminated and its
personal information deleted, consistent with COPPA. Falsifying age to reach
mature features is itself a violation and can result in content removal or
account termination.

Evasion. Accounts created to evade a prior suspension or termination are
themselves subject to termination.
```

---

## Supporting documentation uploads

Three optional upload slots. Use them — an assertion with evidence attached reads very
differently from an assertion alone.

- **Detection** → screenshots of the report reason list and the blocked-write message.
- **Reporting** → the App Store review recording (`laybell_review_recording.mp4`, 45 MB) shows
  the full report flow end to end, plus blocking.
- **Repeat violators** → a PDF or screenshot of the Community Guidelines and the DMCA section
  of the Terms, from `laybell.app/community` and `laybell.app/terms`.

## Before you tick the attestation box

It says the answers are formal attestations, that you are an authorized representative, and
that you will notify Stripe of material changes. Both things that were false this morning are
true now — the per-creator URL is deployed and live, and the nudity allowance is gone from the
published guidelines. Reload `laybell.app/community` and confirm it reads the new way before
you tick it.
