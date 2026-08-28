# Stripe due diligence — screenshot request, 2026-08-28

Lis at Stripe Support asked for three things, because they **could not install the app**:

> could you please send screenshots that show the interface of the app, the types of post shown
> on the dashboard and also screenshots of how users can report posts with prohibited content?

The third one is the real question. A payments reviewer asking "show me how prohibited content
gets reported" is checking whether this platform has a working abuse process — not whether the
UI is pretty. The reporting shots matter most; take those carefully.

---

## Shot list — 11 screenshots, in this order

Take them on your phone from the live app. Number them 1–11 so the reply's numbering matches.

### Interface (1–3)
1. **Home feed**, scrolled so several posts are visible.
2. **Explore tab.**
3. **A creator profile** — use one with real content, not an empty account.

### Post types (4–7)
4. **A song post** (audio + artwork).
5. **A video post.**
6. **A photo or slideshow post.**
7. **A Shop listing** — a creator selling a digital file. **This is the surface Stripe actually
   processes money for**, so do not skip it.

### Reporting prohibited content (8–11) — the important sequence
8. **The ⋯ menu on any post**, showing **Report post** and **Report account**.
9. **The reason list**, showing all eleven categories.
10. **The details step** ("Add details" / "Tell us more").
11. **The confirmation** ("Thanks for the report").

⚠️ Report your OWN post so you do not file a real report against another user.

---

## Reply to send

Attach the 11 screenshots, then paste this. Reply in the existing thread —
*Re: Content Creation Due Diligence Correction*.

---

Hi Lis,

Screenshots attached, numbered to match the sections below.

**App interface (1–3)** — the home feed, the Explore tab, and a creator profile.

**Post types (4–7)** — Laybell carries four kinds of post: a song post (audio with artwork), a
video post, a photo/slideshow post, and a Shop listing, where a creator sells a digital file such
as a beat or a finished track. The Shop listing is the surface Stripe processes payments for.

**Reporting prohibited content (8–11)** — the complete flow, end to end. Any post's ⋯ menu offers
**Report post** and **Report account** (8). The reporter picks from eleven categories (9): spam;
harassment or bullying; hate speech or symbols; nudity or sexual content; violence or threats;
impersonation or fake/AI; scam or fraud; sale of illegal or regulated goods; self-harm or
suicide; intellectual property; and something else. They can add detail (10) and get a
confirmation (11).

The same reporting control is present on **every surface that can carry user media** — posts,
comments, direct messages and group chats — not only the main feed.

Two things that may help the review:

**Why the app would not install.** Laybell is currently iOS only and released in the United
States only; the Android build is still in Google Play review. If your reviewer is outside the US
App Store the download will fail regardless of the account credentials. Individual posts are also
viewable in a browser without installing anything, at `https://laybell.app/post/<id>`, if it is
useful to see live content directly.

**Moderation is not only reactive.** Laybell LLC is a registered Electronic Service Provider with
the NCMEC CyberTipline, approved on 26 August 2026, and operates a written response procedure
covering preservation, reporting and one-year retention. Reports land in a moderation queue that
is reviewed daily, and content can be removed from circulation and an account suspended
independently of who reported it.

Please let me know if there is anything else you need.

Best regards,
Edwin Hall
Laybell LLC

---

## Before you send that

The reply says the moderation queue **is reviewed daily**. Make that true. It is the one
sentence in there that describes a habit rather than a fact, and it is the same claim the CSAM
runbook rests on — a queue nobody reads turns a bounded legal obligation into a knowing failure.

Everything else in the reply is verifiable: the eleven report reasons are in `lib/i18n.ts`, the
report controls are in `contexts/PostOptionsContext.tsx`, `components/Comments.tsx` and
`app/messages/[id].tsx`, and the NCMEC approval is dated 2026-08-26.

---

## Deadline

**Payouts pause 2026-09-09** if verification is unresolved. This reply is the last known blocker.
See `docs/STRIPE_VERIFICATION_2026-08-21.md`.
