# Stripe account verification — "content creation" review

**Raised by Stripe 2026-08-21. Due Sep 9. SUBMIT IMMEDIATELY — do not let this sit.**

## Why this is urgent, in one line

**Payouts pause Sep 9, 2026. Payments pause Oct 9.** Launch is Sep 1. Creator earnings sit on
a 14-day hold, so the first creator becomes eligible to withdraw around **Sep 15** — *after*
the payout rail would already be dead. The window is not "before mid-September" any more; it
is now.

Stripe quotes 24 hours for most reviews, 2–3 business days for complex ones. **Submitting on
Aug 21 leaves 19 days of slack and room for a follow-up question. Submitting in September
leaves none.**

## What Stripe actually said

> "It looks like you may be violating our Terms of Service related to content creation, so we
> need to collect some additional details about your business."

This is their restricted-business screen. Creator platforms trip it routinely — it is a
classification question, not an accusation. The answer is to describe the business precisely.

## The fact that most changes the picture

**Stripe processes no consumer payments for Laybell.** Every consumer purchase — credit packs
and both subscriptions — is processed by Apple's App Store and Google Play as in-app purchase.
Stripe Connect is used *only* to pay creators out to their own bank accounts.

So Stripe is handling **money OUT to a small number of verified creators**, not money IN from
the public, and is not underwriting the sale of user content at all. Lead with this.

## Draft answer — VERIFY EVERY LINE BEFORE SUBMITTING

Everything below is checked against the repo and the published guidelines as of 2026-08-21.
It is still **your** declaration to Stripe: read it, correct anything that has changed, and
submit it in your own words if you prefer.

```
Laybell is a music-focused social platform for independent artists, operated by Laybell LLC
(Maryland, US). Artists post music, video and photos, broadcast live, and sell beats and songs
to other creators.

HOW STRIPE IS USED
Stripe is used only to pay creators out to their own bank accounts via Connect. Laybell does
not process consumer payments through Stripe. All consumer purchases — credit packs and the
two subscription tiers — are processed by Apple's App Store and Google Play as in-app
purchases, and creator earnings are funded from those proceeds. Stripe handles money out to
creators, not money in from the public.

CONTENT POLICY
Laybell is rated 13+ and is not an adult platform. Sexually explicit content is prohibited
outright and removed. Tasteful or artistic nudity is permitted only when the creator marks the
post as mature; such posts are hidden from every account known to be under 18, enforced in the
database rather than only in the interface. Child sexual abuse material is strictly
prohibited and reported to NCMEC. Non-consensual intimate imagery is never permitted.

MODERATION
- Automated filtering of objectionable terms on captions and comments.
- In-app reporting on every post, profile, comment and message, with a reason list.
- Blocking, which removes the blocked user's content and prevents contact.
- Reports survive deletion of the content or the account, each with a tamper-proof snapshot,
  and a legal-hold flag blocks deletion of anything under investigation.
- A DMCA agent registered with the U.S. Copyright Office, and a published repeat-infringer
  termination policy that is enforced.

MINORS
Users under 18 are identified at signup. For them the app disables location capture, disables
targeted advertising, defaults posts to friends-only, restricts incoming direct messages to
accounts they follow, blocks livestream broadcasting, and hides all mature-marked content.
The messaging restriction and the mature-content gate are enforced server-side.

MUSIC LICENSING
Laybell does not license, host or distribute a commercial music catalogue. All audio is
uploaded by users who warrant they own or control the rights. Laybell LLC additionally holds
BMI and ASCAP public-performance licences (ASCAP account 400012723).

AVAILABILITY
United States only.

PUBLISHED POLICIES
laybell.app/terms · laybell.app/privacy · laybell.app/community
```

## The one line Stripe will look hardest at

*"Tasteful or artistic nudity is permitted…"* — do not remove it. It is true, and Stripe
discovering an omission later is far worse than them asking a follow-up now. It sits directly
beside the outright prohibition on sexually explicit content and the server-enforced 18+ gate,
which is the honest shape of the policy.

## If Stripe declines or restricts

Not the end of the app: consumer purchases run through Apple and Google regardless, so the
store, tips and subscriptions all keep working. What breaks is **creator withdrawal**. The
fallback would be another payout rail, which is real work — one more reason to submit early
enough that a "no" arrives with time to react.
