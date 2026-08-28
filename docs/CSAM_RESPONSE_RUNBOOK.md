# CSAM response runbook

**Status:** required before launch. Free to set up. Roughly a day of work.

This is the procedure Laybell follows when child sexual abuse material (CSAM) is
reported or discovered on the platform. It exists because 18 U.S.C. § 2258A makes
reporting mandatory for any provider, **with no size threshold** — a one-person
company has the same duty as Meta. Section 230 does not shield you here;
§ 230(e)(1) expressly preserves federal criminal law.

This document is informational, not legal advice. Have counsel review it once.

---

## What the law actually requires

**You must report.** On obtaining actual knowledge of apparent child sexual
exploitation, file a CyberTipline report with NCMEC "as soon as reasonably
possible." Penalty for a knowing failure: **$600,000** for a first violation
(providers under 100M monthly users), **$850,000** after.

**You must preserve.** A submitted report is treated as a request to preserve the
reported content for **one year** (§ 2258A(h)). Do not delete it.

**You are NOT required to go looking.** § 2258A(f) is explicit: there is no duty to
monitor users and no duty to affirmatively search, screen, or scan. You do not need
PhotoDNA or any scanning pipeline to be compliant. You are responsible for what you
actually learn about — through reports, or through your own moderation.

That last point matters for a solo founder: the obligation is *reactive and
bounded*, not an engineering programme.

---

## One-time setup

✅ **REGISTRATION IS COMPLETE — approved 2026-08-26.** NCMEC confirmed Laybell LLC is registered
with the CyberTipline and may submit a report from that point forward. The account is under
`laybellapp@gmail.com`; credentials arrived as a **password-protected PDF**, with the password
sent in a separate follow-up email from the analyst (Samuel M. Carducci, Senior Analyst).

**Do these three things now, once:**
1. **Set the account password** from the "Create Password for New Account" email.
2. **Open the PDF and move the credentials into a password manager.** Step 4 below says "not
   only in a browser password manager" — but an email inbox is worse than either. The password
   for that PDF is sitting in a *second* email in the same inbox, so anyone with inbox access
   has both halves.
3. **Confirm `laybellapp@gmail.com` is genuinely monitored.** Step 3 below is not boilerplate:
   this is the address NCMEC and law enforcement use.

### Trusted flaggers — NCMEC asked, 2026-08-27

In the credentials email, Samuel Carducci asked whether Laybell recognises NCMEC or other
hotlines as **trusted flaggers**, and whether there is a workstream for those notifications
separate from the general abuse email.

**The policy, as answered:** NCMEC and established hotlines are treated as trusted reporters.
Their notifications are actioned directly by the owner rather than entering the ordinary
user-report queue, and content can be placed under legal hold, pulled from circulation, and the
account suspended on receipt — no corroborating user report required.

**The channel is `abuse@laybell.app`**, kept separate from general support.

⚠️ **A named channel must be a read channel.** The whole point of a trusted-flagger lane is that
it is faster than the normal one; naming an address nobody reads makes it slower than the normal
one while looking like a commitment. `laybellapp@gmail.com` was explicitly **not** offered for
this reason — it stood at 70 unread on 2026-08-28. If `abuse@` routing ever lapses, tell NCMEC
the new address the same day.

Carducci also offered a walkthrough call on the reporting form, and CC'd Hannah as a second
contact. The team address is `ESPteam@ncmec.org`. The reporting portal is
<https://report.cybertip.org/cybertip/login>; there is also a web-services API for automated
reporting at <https://report.cybertip.org/ispws/documentation/>, which is worth considering only
if report volume ever makes manual filing impractical.

⚠️ **Registration is permission, not process.** Being registered means Laybell *can* file. It
does not file anything by itself. The rest of this runbook — preserve, report, then delete — is
what actually discharges the obligation, and it only works if the moderation queue is read.
Steps 5 and 6 below are the ones with teeth.

1. ~~**Register as an Electronic Service Provider** at
   <https://esp.ncmec.org/registration>. Free. Over 2,000 providers are registered.~~ ✅ done
2. Supply the required contact information: mailing address, phone, email, and a
   **named individual point of contact**. That is you.
3. Use an email address you genuinely monitor. This is the address NCMEC and law
   enforcement will use, and a missed message here is the worst kind of missed
   message.
4. Record the registration date and credentials somewhere durable — not only in a
   browser password manager.
5. Make sure a report button exists on **every** surface that can carry user media:
   posts, comments, direct messages, group chats, stories, and live. Laybell has
   this (see `contexts/PostOptionsContext.tsx`, `components/Comments.tsx`,
   `app/messages/[id].tsx`); confirm nothing new has shipped without it.
6. Check the moderation queue **daily**. A queue nobody reads converts a bounded
   obligation into a knowing failure.

---

## When a credible report arrives

Work in this order. Do not improvise, and do not skip step 1.

### 1. Preserve — before anything else

Do not delete the content. Do not let the uploader delete it either. Preserve:

- the media itself,
- the post/message row and its identifiers,
- the uploader's account details,
- upload timestamps, IP addresses, and device metadata if held,
- the report that surfaced it.

The `legal_hold` flag from `moderation_preservation.sql` is the mechanism for
blocking deletion — set it. Retention runs **one year minimum** from the report.

### 2. Disable access

Take the content out of circulation and suspend the account. Suspension, not
deletion — deleting destroys the evidence you are legally required to keep.

### 3. Report to NCMEC

File through the CyberTipline ESP portal. Include the preserved identifiers,
timestamps, and account information. "As soon as reasonably possible" means hours,
not days.

### 4. Retain, and wait

Keep everything for at least a year. Expect possible follow-up from NCMEC or law
enforcement. Respond promptly.

### 5. Log the decision

Record what was reported, what you preserved, when you filed, and the NCMEC report
number. This log is your evidence that the process was followed.

---

## Hard rules

- **Never forward, copy, share, or re-upload the material** to anyone other than
  NCMEC or law enforcement — including to a lawyer, a contractor, or a colleague
  "for a second opinion." Distribution is itself a serious crime, and good
  intentions are not a defence.
- **Never delete it** before the retention period ends, even at the uploader's
  request or as part of an account-deletion flow. Account deletion must respect
  `legal_hold`.
- **Never investigate by viewing more than necessary.** Confirm enough to report,
  then stop.
- **Do not tip off the uploader** that a report has been filed.

---

## Optional, cheap, and worth it

Automated hash-matching against known CSAM is **not legally required** (§ 2258A(f)),
but it converts a catastrophic risk into a managed one:

- **Cloudflare CSAM Scanning Tool** — free, and Laybell already runs media through
  Cloudflare.
- **Thorn Safer** — discounted for small platforms.

Neither creates a duty to monitor by existing. Adding one is a decision to reduce
your own exposure, not a new obligation.

---

## Related

- `docs/LEGAL_ROLLOUT.md` — the wider legal checklist
- `docs/LAUNCH_CHECKLIST.md` §7.1 — where this sits in the launch sequence
- `supabase/sql/moderation_preservation.sql` — the `legal_hold` mechanism
- `docs/ADMIN_CONSOLE.md` — the moderation console this queue lives in
