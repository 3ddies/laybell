# Laybell — legal & privacy rollout checklist

Everything needed to take the legal/privacy work live. Things marked **[code done]** are already implemented in this repo; the rest need your accounts/credentials. Work top to bottom.

**Progress:** domain ✅ · contact inboxes ✅ · DMCA agent ✅ · mailing address filled ✅ · SQL migrations run ✅ · trademark spec ready ✅ · Privacy + Terms + Community Guidelines + Advertiser Terms built & wired ✅ · Marketplace & Beat Licensing Terms built & wired ✅ **[code done]** (`lib/legal/marketplace.json` → `/marketplace-terms` in-app + `web/marketplace.html`; linked from Settings → About, the shop seller agreement, and every listing page; defines Lease / Exclusive Purchase ("Buy") / Free Claims / Offers, the exclusivity + surviving-leases rule, refund-gated takedowns, and store guidelines — all matching the platform-enforced mechanics in `shop_multi.sql`)
**Remaining — all at/around app‑store submission:** host the web pages (step 7) · store privacy forms (step 8) · one‑time attorney review (step 9). Optional: parent‑consent email (step 2), EU/UK reps (step 6), trademark.

---

## 1. Run the database migrations  **(required — features no‑op without them)**
In the **Supabase dashboard → SQL Editor**, paste & run each file:
- `supabase/sql/storage_cleanup.sql` — lets the app delete media files; auto‑purges a user's storage on account deletion.
- `supabase/sql/minor_consent.sql` — columns for the 13–17 parental‑consent step.
- `supabase/sql/parent_consent_verification.sql` — token table for the parent‑email confirmation (run after `minor_consent.sql`).
- `supabase/sql/posts_update_policy.sql` + `supabase/sql/posts_delete_policy.sql` — owner can edit/delete own posts (without these, archive/edit/delete silently no‑op).
- `supabase/sql/moderation_preservation.sql` — **content moderation safety.** Reports now survive deletion of the post/account (so a user can't delete away the evidence), every report stores a tamper‑proof content snapshot (DB trigger), and a `legal_hold` flag blocks deletion of content under investigation. Run after `post_reports.sql` + `user_reports.sql`; it also (re)creates the posts‑DELETE policy, superseding `posts_delete_policy.sql`.

Also confirm your **other** feature migrations are applied (badges, spotlight, ad_ecosystem, account_hidden, profile_fields, public_playlists, etc.) and that the **`ads` storage bucket** exists.

## 2. Deploy the parent‑consent email (optional but recommended)  **[code done — needs config]**
The in‑app step already records consent. To add the verifiable email round‑trip:
1. `supabase functions deploy parent-consent`
2. `supabase functions deploy parent-consent-verify`
3. Get a sender domain verified with an email provider (e.g. **Resend**), then set secrets:
   ```
   supabase secrets set RESEND_API_KEY=...           # provider API key
   supabase secrets set CONSENT_FROM_EMAIL="Laybell <privacy@laybell.app>"
   supabase secrets set CONSENT_VERIFY_URL="https://<project-ref>.functions.supabase.co/parent-consent-verify"
   ```
Until set, the app still records the in‑app attestation; it just doesn't send the email.

## 3. Fill the placeholders in the documents  **(mailing address ✅ done)**
- `[LAYBELL LLC - MAILING ADDRESS]` → **DONE** — filled with `Laybell LLC, 28 Rivers Edge Ter, Indian Head, MD 20640` across both docs + the web pages.
  - ⚠️ **This is a home address, and it is PUBLIC** (shown in‑app *and* in the federal DMCA directory). Recommended swap before scaling: get a **P.O. box or virtual business address**, then (a) update the DMCA record at dmca.copyright.gov (free), and (b) re‑fill — replace the address in `terms.json` + `privacy.json` and run `node scripts/build-legal-html.mjs`.
- `[EU/UK REPRESENTATIVE …]` / `[EU REPRESENTATIVE …]` / `[UK REPRESENTATIVE …]` → **intentionally left gated** until you appoint reps (see step 6).

## 4. Set up the contact inboxes  **(✅ done)**
**DONE** — `support@`, `privacy@`, `dmca@laybell.app` set up as free **ImprovMX** forwards (MX + SPF records in GoDaddy DNS) to the owner's Gmail; tested and delivering. Optional later upgrade: a real mailbox (e.g. free **Zoho Mail**) so you can also *send* from the branded addresses.

## 5. Register your DMCA designated agent  **(✅ done)**
**DONE** — Laybell LLC is registered in the U.S. Copyright Office DMCA Directory (agent email `dmca@laybell.app`). Renew every 3 years; update within 30 days if the contact info changes. *(If you swap the home address per step 3, update this record too.)* For reference, the values used:
- **Service provider:** Laybell LLC
- **Alternate names:** Laybell, laybell.app
- **Designated agent:** (your name or "Laybell Legal / DMCA Agent")
- **Physical mail, email, phone:** your business address, dmca@laybell.app, a phone number.

## 6. EU / UK go‑live (only when you want EU/UK users)
The documents (correctly) say EU/UK isn't offered until these are done:
- Appoint a named **EU Article 27 representative** (in an EU country) **and a separate UK representative** — services like **Prighter** or **DataRep** do this for a monthly fee. Put their names/addresses into the placeholders (step 3).
- In **Supabase → account/settings**, accept/sign the **Data Processing Agreement (DPA)** and confirm the **EU Standard Contractual Clauses** cover the US data transfer.

## 7. Host the web copies of the documents  **(do at app‑store submission)**  **[code done]**
The stores require a public privacy‑policy URL. Easiest (no GitHub needed): make a free **Netlify** account → drag the `web/` folder onto their deploys page → live link in ~2 min. Then add the custom domain `laybell.app` in Netlify and add the A/CNAME records it gives you at GoDaddy — this does **not** affect your email (website records and mail/MX records are independent). Final URLs: **laybell.app/privacy** and **laybell.app/terms**.
- **Updating later is easy and keeps the same URL:** edit the JSON → `node scripts/build-legal-html.mjs` → re‑drag the `web/` folder (or `git push` if you connected GitHub).
- Alternatives: `npx netlify deploy --prod` (uses the included `netlify.toml`), or GitHub Pages via the included `.github/workflows/deploy-legal.yml`.

## 8. Fill out the store privacy disclosures
Use `docs/STORE_PRIVACY_DISCLOSURES.md` to complete Apple's **App Privacy** and Google's **Data safety** forms accurately. Add the privacy‑policy URL, set age rating 13+/Teen.

## 9. One‑time attorney review  **(strongly recommended)**
Have a tech/IP attorney review `terms.json` + `privacy.json` — especially the **music/copyright** and **GDPR** sections. You're handing them a finished draft, so it's a cheap review rather than a from‑scratch drafting job.

Add `marketplace.json` to that same review — priority items: the **Lease scope** (§6: perpetual, credit clause, no Content ID enrollment), the **Exclusive Purchase transfer language** (§7: rights transfer subject to surviving prior leases — this must stay aligned with the in-app copy that a sale "transfers ownership"), the **refund/license-termination mechanics** (§9), and the **venue/fee framing** (§3, 15% fee with off-platform settlement).

---

## What's already implemented in the app  **[code done]**
- Privacy Policy & Terms screens, opened from **Settings → About**.
- Sign‑up **clickwrap consent** ("you're 13+ and agree to the Terms/Privacy").
- **Privacy Center** (Settings → Account → "Privacy & data"): read the policies, toggle personalized ads, **Download your data** (JSON export), see parental‑consent status, delete account.
- **Ad personalization is opt‑in** (off by default) — EU‑compliant.
- **13–17 parental‑consent step** in onboarding (+ optional email verification, step 2).
- Paid features (**Spotlight, Ad Manager**) gated to **18+**.
- **Storage cleanup**: deleting a post/story/avatar removes the underlying file; deleting an account purges all of the user's files.
- **Moderation evidence survives deletion**: reports are no longer cascade‑deleted with the post/account, each report keeps a tamper‑proof content snapshot, and a `legal_hold` flag blocks deletion of content under investigation — so a user can't post something illegal and then delete their way out of the moderation/legal trail. *(Still TODO and needing counsel/infra: NCMEC CSAM reporting workflow, copying flagged media into a locked retention bucket, an admin review queue, and counsel‑set retention periods.)*
- **Account deletion = 48‑hour deferred hard delete**: "Delete now" flags the account and signs the user out; a client login guard (`app/_layout.tsx`) blocks any further sign‑in / session‑restore; then the **sweep hard‑deletes it 48 hours later** (which frees the email for a new account). The deletion message tells the user they can reuse the email after 48h. (The `delete-account` Edge Function is now OPTIONAL — kept only as an admin/force‑delete utility; the sweep is the real mechanism, so deletion no longer depends on deploying the function.)
- **Automated deletion sweep** (`supabase/sql/account_deletion_sweep.sql`) — **REQUIRED for deletion to actually happen**: an HOURLY pg_cron job (`sweep_deletable_accounts()`) hard‑deletes deliberate deletions once they're 48h old (and "hide for 3 months" accounts after 3 months inactive), **only if they have ZERO reports** (post/user/ad) and no legal hold. Anything with a report — a reported post, song, video, story, page, or ad — is **left for MANUAL deletion** (a review query is included in the file). Run the SQL after the migrations above + `ad_ecosystem.sql`; it enables pg_cron itself.

## Ongoing obligations (don't skip)
- Honor **DMCA takedowns** promptly and enforce the **repeat‑infringer** termination policy.
- Report **CSAM** to NCMEC (legal requirement).
- Re‑date the documents when you change them (bump the date in the JSON, re‑run the generator, the app + web update together).
- Before adding any **third‑party SDK** (analytics, crash, ads) or a **licensed music catalog**, update the Privacy Policy and (for music) secure the proper licenses (mechanical via the MLC; performance via ASCAP/BMI/SESAC; sync).
- Maintain the **subprocessor list** (Supabase, Expo/Apple/Google) and add any new vendor before it goes live.

## Nice‑to‑have business items
- **"Laybell" trademark — ready to file at USPTO** ([Trademark Center](https://www.uspto.gov), needs a verified USPTO.gov account). Preliminary clearance looked clear (no conflicting "Laybell" tech/app brand; verify on tmsearch.uspto.gov, paying attention to the similar mark "Laylo"). Filing spec:
  - **Mark:** `LAYBELL` (standard‑character wordmark)
  - **Owner:** Laybell LLC, a Maryland LLC — 28 Rivers Edge Ter, Indian Head, MD 20640
  - **Basis:** Intent to Use (Section 1(b))
  - **Classes:** **Class 9 chosen (~$350).** Class 42 is optional and can be added later as a separate application. Use the pre‑approved ID Manual entries to avoid the +$200/class custom‑wording surcharge.
  - **Class 9 (downloadable app):** `Downloadable mobile application software for social networking; downloadable mobile application software for sharing, streaming, and playing music, audio, photographs, and videos; downloadable computer software for creating, uploading, posting, displaying, and sharing user-generated content; downloadable mobile application software for sending and receiving electronic messages, images, and media files.`
  - **Class 42 (optional — add later if you want platform coverage):** `Software as a service (SAAS) services featuring software for social networking and for sharing, streaming, and playing music, audio, photographs, and videos; providing temporary use of online non-downloadable software for creating, uploading, posting, and sharing user-generated content; providing temporary use of online non-downloadable software for sending and receiving electronic messages and media.`
  - **After filing:** ✅ ™ now shown on the in‑app wordmark (home header, login, signup, onboarding). Save your **serial number / filing receipt** (emailed at submission); check status anytime at tsdr.uspto.gov. **Watch the application email and respond to any Office Action within the deadline (~3 months) or the application abandons.** ~8–12+ months to process; after launch, file the **Statement of Use** (~$150/class) with a specimen (e.g., your App Store listing), reusing the exact descriptions above. Switch ™ → ® only once the registration certificate issues.
  - *(A separate logo/design mark can be filed later once the logo is final — the wordmark above is the priority.)*
- Consider **media liability / tech E&O insurance**.
- Keep LLC housekeeping current (registered agent in MD, EIN, business banking, sales‑tax registration once you charge real money).
