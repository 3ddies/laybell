# Insurance & Business Admin — Laybell LLC

**Researched 2026-07-28.** Written for: single-member Maryland LLC, solo founder, no employees, no contractors, pre-revenue, launching now.

> ### ⚠️ This is not legal, tax, or insurance advice
> I am not a lawyer, a CPA, or a licensed insurance producer. This is a research summary with the sources attached so you can check every claim yourself. Where the research is solid I say so. Where I am reasoning rather than quoting, I label it **[inference]**. Where the ground is actively moving, it's in the "Verify yourself" section at the bottom. Insurance policy wording is the only thing that determines what a policy covers — marketing pages don't, and neither does this doc.

---

## The short answer

1. **Buy nothing at launch.** At $0 revenue, with no employees, no investors, and no enterprise contracts requiring certificates of insurance, there is no policy whose expected value beats keeping the cash. Nobody — not Apple, not Google, not Stripe, not Maryland — currently requires you to carry any.
2. **Your real shields are free and you already mostly have them:** the LLC, the DMCA §512 safe harbor, Section 230, and your ToS. Keeping the DMCA safe harbor alive is worth more than any policy you could afford, and it costs $6 every three years.
3. **The one genuine hole is music licensing, not insurance.** BMI + ASCAP cover public performance only. They do not cover reproduction/mechanical, sync, or the sound-recording (master) right — which is exactly what a user uploading someone else's track triggers. No policy fixes this; only licensing + takedown discipline does. **This is the highest-value item in this doc.**
4. **Do the cheap admin now:** Maryland Form 1 by **April 15** ($300), DMCA agent renewal every 3 years ($6), separate business bank account (free–$15/mo), EIN (free). Skip S-corp election, skip accountable plan, skip BOI filing (currently exempt).
5. **Revisit insurance when any of these happen:** you hire someone (→ workers comp becomes mandatory), you raise a priced round (→ investors will require D&O), you sign a B2B contract with an insurance clause, or revenue gets big enough that a $40K defense bill would kill you rather than just hurt. Realistically that's media liability first, around the point where you have real money at stake.

---

## Coverage table

| Coverage | Needed at launch? | Needed at scale? | Rough cost (2026) | What it actually pays for |
|---|---|---|---|---|
| **General liability (CGL)** | **No** | Only if you get an office/lease or a venue asks for a certificate | $180/yr median for startups (Vouch); ~$348–$394/yr for app-dev/media small businesses (Insureon) | Someone trips in your office; you damage a rented space. **Critically: standard ISO CGL wording excludes "personal and advertising injury" for insureds whose business is "an internet search, access, content or service provider," and excludes anything "arising out of an electronic chatroom or bulletin board the insured hosts."** That is Laybell's entire product. A cheap GL policy does *not* cover your core content risk. |
| **Tech/Professional E&O** | **No** | Yes, once you have paying B2B customers or SLAs | $3,700/yr median, $1,300–$12,400 range (Vouch) | You promised a service, it broke, a *customer* lost money and sues over the failure. You have consumers, not enterprise customers — nobody is suing you over an SLA. |
| **Cyber liability / data breach** | **No** — but this is the closest call | Yes, once you hold meaningful user PII at volume | $1,552/yr avg, $400–$8,000 range (Insureon, Apr 2026); $2,968/yr median (Vouch) | Breach response: forensics, legally-required notification letters, credit monitoring, regulatory defense, ransomware. Real value is the **incident-response vendor panel**, not the payout. You don't hold card data (Apple/Google/Stripe do), which strips out the expensive part of a breach. Buy this when your user table is big enough that notifying everyone would bankrupt you. |
| **Media liability** (defamation, IP infringement, right of publicity) | **No at $0 revenue — but it is the *right* policy for this business, and the first one to buy when money exists** | **Yes.** This is the coverage that matches Laybell's actual risk | ~$930/yr for the median small "media business" (Insureon) — **but that figure is for a media business, not a UGC-hosting platform.** Specialty markets look more like **$2,500–$3,000/yr minimum** with a **$5,000 retention**. See the caveat below the table. | Defamation/libel via user posts, copyright & trademark infringement, invasion of privacy, misappropriation of likeness/right of publicity, product disparagement. Pays defense costs — which is the whole point, since most of these claims die on a motion but the motion still costs $15K–$40K. |
| **D&O** | **No.** No outside investors, no board, no one to sue you as a director | Yes — investors will *require* it as a closing condition on a priced round | $6,300/yr median, $3,000–$16,800 range (Vouch) | Claims against *you personally* in your capacity as a manager/director. With one member and no investors there is nobody with standing. Buy it when a term sheet tells you to. |
| **Workers' comp** | **No** — no employees | **Mandatory the day you hire your first W-2 employee** | ~$519/yr for a media small business (Insureon), scales with payroll | Employee injury. Maryland penalty for failing to secure coverage for covered employees: **up to $25,000** (Md. Lab. & Empl. § 9-407). See the Maryland nuance below. |
| **EPLI** | **No** | On hiring | $4,300/yr median (Vouch) | Wrongful termination, discrimination, harassment claims by employees. N/A with zero employees. |

### The media-liability caveat you need to understand before you shop

Media liability is the right product for Laybell, but **UGC hosting is underwritten separately from ordinary media risk**, and the cheap end of the market may not actually cover you:

- **Corgi Insurance** (a startup-focused media-liability writer) sells an *optional endorsement* called **"Expanded Definition of Media Content"** specifically to extend coverage to **"user-generated content hosted on your platform,"** noting "availability may vary by jurisdiction and underwriting." **[verified]** The plain reading: the base policy does not automatically cover content your users post. Its structure is $1M per claim / $2M aggregate / **$5,000 self-insured retention**, claims-made, **defense costs inside the limits**. Corgi does not publish a premium.
- **Beazley** explicitly lists social media channels and social influencers as in-appetite for its media liability product **[verified]** — but it's a Lloyd's specialty market placed through brokers, not a self-serve online quote.
- **Hiscox** multimedia liability is widely cited at a **$3,000 minimum premium / $5,000 minimum retention** — **[unverified: this came from search summaries of a wholesale-broker brochure that could not be read directly. Treat as a ballpark, not a quote.]**
- **No carrier researched publishes a blanket "we don't write UGC platforms" exclusion.** The restriction shows up as *"requires bespoke underwriting / broker placement / a specific endorsement,"* not as a refusal. **[inference from the pattern across ~12 carriers]**
- **Practical consequence:** when you do shop this, do not buy the cheapest thing that says "media liability" on the tin. Ask one question in writing: *"Does this policy cover claims arising from content uploaded by my users, and if so, under which endorsement?"* If the answer is anything other than a clear yes with an endorsement name, the policy is decoration.

### What the cheap policies actually exclude (the most useful finding in this section)

The standard ISO CGL form (CG 00 01) contains these, quoted verbatim from a NAIC *Journal of Insurance Regulation* study that reproduces the form language:

> "'Personal and advertising injury' committed by an insured whose business is: (1) Advertising, broadcasting, publishing or telecasting. (2) Designing or determining content of websites for others. (3) An internet search, access, content or service provider."

> "'Personal and advertising injury' arising out of an electronic chatroom or bulletin board the insured hosts, owns, or over which the insured exercises control."

"Personal and advertising injury" is the bucket that contains libel/slander, violation of a person's right of privacy, and copyright infringement in your advertisement. Courts read the "media and internet businesses" exclusion narrowly — applying it where the excluded activity is the insured's *primary* business (*State Auto v. Travelers*, 343 F.3d 249, 261 (5th Cir. 2003)). For a bakery with a Facebook page, that narrowing helps. **For Laybell, whose primary business is literally hosting user content, DMs, and livestreams, the exclusion lands squarely.** [inference, but a well-supported one]

**So: a $348/yr GL policy would give you a piece of paper and essentially zero protection against the only claims you're actually likely to face.** Don't buy one for the wrong reason.

---

## What the LLC + ToS already protects you from (and what it doesn't)

### The LLC

**Shields:** Md. Code, Corps. & Ass'ns § 4A-301 — *"no member shall be personally liable for the obligations of the limited liability company, whether arising in contract, tort or otherwise, solely by reason of being a member."* **[verified]** That covers company debts, company contracts, and liability for things *other people* did.

**Maryland is one of the hardest states in the country to pierce.** *Hildreth v. Tidewater Equipment Co.*, 378 Md. 724 (2003): shareholders aren't individually liable *"except where it is necessary to prevent fraud or enforce a paramount equity,"* applied *"with great caution and reluctance."* Maryland courts have declined to pierce even where the only formality observed was filing the articles. **[verified for Hildreth; the "only formality" case is secondary-source]** So the "commingling funds pierces the veil" folk wisdom is weaker in Maryland than elsewhere — **but keep the accounts separate anyway**, because commingling is also a bookkeeping disaster and a red flag in any dispute, and it costs you nothing to avoid.

**Does NOT shield:**
- **Your own torts.** Maryland: *"corporate officers or agents are personally liable for those torts which they personally commit, or which they inspire or participate in, even though performed in the name of an artificial body"* (*Tedrow v. Deskin*, 265 Md. 546, 550 (1972); applied to LLCs in *Marycle, LLC v. First Choice Internet*, 166 Md. App. 481, 528 (2006)). If *you* post something defamatory, if *you* personally make the negligent moderation call, the LLC doesn't stand between you and the plaintiff. **[secondary-source verified — law-firm summaries pin-citing the cases]**
- **Statutory penalties that attach by their own terms** — see below.
- **Anything you personally guarantee** (leases, credit lines, some vendor contracts). Don't sign personal guarantees.

### Section 230 — precisely what it does and doesn't do

**Does:** § 230(c)(1) — *"No provider or user of an interactive computer service shall be treated as the publisher or speaker of any information provided by another information content provider."* This is why a user's defamatory post is generally not your problem. § 230(c)(2) also protects good-faith moderation and removal decisions. **[verified]**

**Does NOT cover:**
- **§ 230(e)(1) — federal criminal law.** *"Nothing in this section shall be construed to impair the enforcement of section 223 or 231 of this title, chapter 71 (relating to obscenity) or 110 (relating to sexual exploitation of children) of title 18, or any other Federal criminal statute."* **[verified]**
- **§ 230(e)(2) — intellectual property.** *"Nothing in this section shall be construed to limit or expand any law pertaining to intellectual property."* **This is the big one for a music app.** Section 230 gives you nothing against a copyright claim. The DMCA §512 safe harbor is the separate, and only, shield there. **[verified]**
- **§ 230(e)(4)** — the Electronic Communications Privacy Act and similar state laws (relevant because you run DMs).
- **§ 230(e)(5) — FOSTA/SESTA.** Preserves civil claims under 18 U.S.C. § 1595 where the conduct violates § 1591, plus state criminal charges. **[verified]**
- **Increasingly: your own product-design choices.** *Anderson v. TikTok*, No. 22-3061 (3d Cir. Aug. 27, 2024) held TikTok's recommendation algorithm was *"its own first-party speech"* and § 230 did not bar the claim. **[verified from the official opinion]** The federal social-media MDL (N.D. Cal. MDL 3047) similarly let through claims about missing parental controls and age verification while barring claims about endless-feed design. This is an active circuit split, not settled law — but the direction of travel is that "we just host it" protects the *content* and increasingly does not protect the *features*. Relevant to Laybell's reels/autoplay/notification mechanics. **[verified for Anderson; MDL holdings from secondary sources]**

### DMCA § 512(c) safe harbor — the thing worth protecting most

If intact, § 512(c) means *"A service provider shall not be liable for monetary relief... for infringement of copyright by reason of the storage at the direction of a user"* — and § 512(k)(2) defines monetary relief broadly enough to include damages, costs, **and attorneys' fees**. That turns a potential $150,000-per-work exposure into $0. **[verified]**

**The conditions you must keep meeting:**
1. **Registered designated agent** with the Copyright Office **and** the agent's contact info posted publicly on the service. Registration **expires after 3 years** — see the deadlines section.
2. **§ 512(i)(1)(A): a repeat-infringer termination policy** that you have *"adopted and reasonably implemented"* and that you *inform subscribers and account holders* about.
3. No actual knowledge, and no "red flag" awareness of facts making infringement apparent.
4. No direct financial benefit from infringing activity you have the right and ability to control.
5. Expeditious removal on notice.

**What actually loses it,** from the case law:
- *BMG v. Cox*, 881 F.3d 293 (4th Cir. 2018) — lost. Standard: *"an ISP has not 'reasonably implemented' a repeat infringer policy if the ISP fails to enforce the terms of its policy in any meaningful fashion."* Cox had a 13-strike policy it never actually enforced, reset counters, and blacklisted the sender of the notices. $25M.
- *EMI Christian Music Group v. MP3tunes*, 844 F.3d 79 (2d Cir. 2016) — vacated. Defining "repeat infringer" too narrowly. ~$48M award, including punitive damages **against the CEO personally**.
- *Ventura Content v. Motherless*, 9th Cir. 2018 — **upheld**, and this one is your template: *"the lack of a detailed written policy is not by itself fatal to safe harbor eligibility... Small operations in many industries often do not have written policies because the owners who would formulate the policies are also the ones who execute it."* A one-person operation with an informal but consistently applied process survived.

**[verified from official/hosted opinions]**

**Translation for you:** you don't need a fancy policy. You need a *real* one you actually run — log every takedown, log every strike, and actually terminate accounts when they hit the number you said you'd terminate at. The lethal failure mode is having a written policy you don't follow, which is *worse* than Motherless's informal-but-real approach.

**What §512 does NOT do:** it does not protect Laybell's *own* infringement. If Laybell uses an unlicensed track in a marketing video or an app-store preview, that's direct infringement with no safe harbor (*MP3tunes* rejected the DMCA defense for cover art the platform's own software copied). And § 512(f) creates liability for *knowingly materially misrepresenting* that something is infringing — so don't fire off bogus takedowns either.

### Your ToS — what it's actually worth

- **Limitation of liability & arbitration clause:** genuinely valuable, and the arbitration + class-action waiver is probably the single highest-value clause you have, because it converts "class action over a payout policy" into "one small arbitration." Enforceability against consumers depends on presentation — clickwrap with clear assent beats browsewrap. **[inference; standard doctrine]**
- **Indemnification from users:** near-worthless in practice. Your users are individuals with no assets. It's a deterrent and a signal, not a recovery mechanism.
- **What it can't do:** a ToS cannot waive statutory penalties, cannot bind a *non-user* (the record label suing you never agreed to your ToS), and cannot contract around FTC Act or state privacy enforcement. The people most likely to sue you — rights-holders — are exactly the people your ToS doesn't touch.

### Statutory exposure neither the LLC, the ToS, nor insurance will cover

- **18 U.S.C. § 2258A** (CSAM reporting). A *knowing and willful* failure to report: up to **$600,000** first offense for a provider with under 100M MAU, **$850,000** subsequent. **[verified]** You've registered with NCMEC — the runbook in `docs/CSAM_RESPONSE_RUNBOOK.md` is doing more for you here than any insurer would.
- **COPPA**: **$53,088 per violation** (FTC's 2025 inflation adjustment), counted per affected child. **[secondary-source verified via law-firm alert; the Federal Register page blocked automated fetch]**
- **FTC Act § 5** (15 U.S.C. § 45): no small-business or revenue exemption exists in the statute. **[verified]**
- **Maryland Online Data Privacy Act (MODPA)**, effective **October 1, 2025**. Applicability: ≥35,000 Maryland consumers' personal data per year, or ≥10,000 if >20% of revenue comes from selling personal data. No private right of action; AG enforcement only. **[effective date verified from the official bill page; thresholds from ~6 converging secondary sources including DLA Piper — the enrolled bill PDF would not render]** **Note the trigger is a *data-volume* threshold, not a revenue threshold — you could cross it while still pre-revenue.**
- **Maryland Kids Code (Age-Appropriate Design Code)**: *NetChoice v. Brown* (D. Md.) — motion to dismiss **denied** Nov. 24, 2025, so NetChoice's First Amendment claims proceed, but **the law was not enjoined and remains in effect.** **[secondary-source verified]**

---

## Most likely claims, ranked, and what actually defends against each

**1. Copyright infringement over user-uploaded music — by an order of magnitude the most likely claim.**
Real defense: **DMCA §512(c) safe harbor**, not insurance. Section 230 explicitly does *not* apply (§ 230(e)(2)). Statutory damages are $750–$30,000 per work, up to **$150,000 for willful**, as low as $200 for innocent (17 U.S.C. § 504(c)) — and "per work" against a music catalog compounds fast. An intact safe harbor takes monetary exposure to zero for user-stored content; a broken one is existential. Defense cost if it ever gets litigated: roughly **$50K–$300K** through summary judgment. **[statutory text verified; cost range is a secondary-source estimate, low confidence]**
**→ Action: renew the DMCA agent on schedule, log takedowns, actually terminate repeat infringers. That's the whole defense.**

**1a. The music-licensing gap underneath it — treat as part of claim #1, because it's what makes claim #1 likely.**
BMI's own words: *"BMI only licenses performing rights, and only non-dramatic performing rights at that,"* and *"BMI does not offer synchronization licenses"* and does not license *"the making of phonograph records."* **[verified]** ASCAP says the same about mechanical and sync. Separately, 17 U.S.C. § 114(a) means the **sound recording (master)** right is a wholly different copyright that PROs never touch — and SoundExchange's own site says that for *"an interactive service or on-demand access to certain tracks or artists (e.g., YouTube), the statutory license does not apply, and a direct license must be obtained from the copyright holder."* **[verified]**

Laybell lets users replay specific uploaded tracks on demand. That makes it an interactive service. So:
- **Performance right:** BMI ✓ / ASCAP (applied) ✓
- **Mechanical/reproduction:** ✗ — runs through 17 U.S.C. § 115 / the MLC blanket license, not the PROs
- **Sync** (music attached to user video, which is a core Laybell feature): ✗ — publisher-by-publisher
- **Master/sound recording:** ✗ — **no statutory or blanket path exists for interactive services; direct label deals only**

**This is not an insurance problem and no policy solves it.** What actually manages it in the real world is (a) the DMCA safe harbor absorbing the user-upload case, (b) fast, disciplined takedowns, and (c) not building features that make the platform look like it's *supplying* commercial recordings rather than hosting what users chose to upload. Worth a free consultation with Maryland Volunteer Lawyers for the Arts (link in Sources) before you scale the song-attachment features.

**2. A creator suing over a payout dispute, account termination, or withheld earnings.**
Real defense: **your ToS** — arbitration clause + class-action waiver + clear termination and payout terms. Insurance is largely irrelevant (E&O might respond, but you'd be paying $3,700/yr to cover a $500 dispute). Highest-frequency, lowest-severity claim category. Keep the money flows clean: Stripe Connect holds and moves the funds, you never hold user money in your own account, and the wallet/payout logic matches what the ToS says it does.
**→ Action: make sure the wallet, shop refund, and account-termination flows behave exactly as documented. Most of these disputes are really "the product did something the terms didn't describe."**

**3. Defamation / harassment / right-of-publicity claims over user posts.**
Real defense: **Section 230(c)(1)**, and it's strong. You are generally not the publisher. Cost to win a § 230 motion to dismiss: roughly **$15K–$40K** (up to ~$80K); responding to a demand letter without litigation ~$3K. **[secondary-source, advocacy-org estimate — low-to-moderate confidence]** Media liability insurance would pay those defense costs. That's the honest case *for* buying media liability eventually — not because you'd lose, but because winning still costs a month of runway. Note § 230 does **not** cover right-of-publicity in every circuit (courts split on whether it's an "intellectual property" claim under § 230(e)(2)).

**4. A data breach.**
Real defense: **not holding the sensitive stuff.** You don't touch card data — Apple, Google, and Stripe do. That removes the PCI-fine and card-reissuance layer that makes small-business breaches expensive. What's left is user emails, DMs, and content. Cyber insurance's real product is the incident-response panel (forensics + notification vendor), which matters a lot on day one of a breach and which you cannot assemble yourself at 2am. Buy it when the size of your user table makes notification a five-figure event. Also: MODPA's 35,000-Maryland-consumer threshold is the tripwire to watch.

**5. Product-design / safety claims (addiction, minors, algorithmic harm).**
Real defense: **thin and thinning.** § 230 is losing ground here (*Anderson v. TikTok*; MDL 3047). Worse, insurance is retreating in parallel: in **March 2026 a Delaware court held 20+ insurers including Hartford and Chubb owe Meta no duty to defend** the social-media addiction litigation, because design choices are intentional conduct, not an "accident" triggering CGL coverage. Lockton's analysis says the exposure theory *"extends beyond major platforms to gaming companies, streaming services, app developers."* **[secondary-source verified via trade press]** Low probability for a small app today, but note that this is a risk that is simultaneously getting *more* legally exposed and *less* insurable — so the mitigation is product and policy discipline (age gating, minor-safety controls, the work already in `lib/minors.ts`), not a policy you can buy.

**6. Trademark / brand claims** (a user's shop listing using a label's marks, or someone objecting to "Laybell"). Low frequency, cheap to resolve, handled by takedown. Media liability covers it if you ever have it.

**7. Federal criminal / CSAM-reporting exposure.** Very low probability, catastrophic if it happens, and covered by **nothing** — not § 230 (e)(1), not the LLC, not insurance. Purely a process-discipline item, and you've already built the process.

**Pattern worth internalizing:** for claims 1, 3, and 7 — the three most consequential — the free legal shield is the primary defense and insurance is at most a defense-cost backstop. That is why "no insurance at launch" is a defensible position and not just a budget excuse.

---

## Required by anyone? (Apple / Google / Stripe / Maryland)

**Apple — Developer Program License Agreement: NO standing requirement, but a reserved right.**
Section 6.1 (verified by reading the current PDF directly):

> "You agree to cooperate with Apple in this submission process and to answer questions and provide information and materials reasonably requested by Apple regarding Your submitted Application, **including insurance information You may have** relating to Your Application, the operation of Your business, or Your obligations under this Agreement. **Apple may require You to carry certain levels of insurance for certain types of Applications and name Apple as an additional insured.**"

So: Apple can demand it for certain app categories, but does not require it of developers generally. **[verified]** Two other clauses matter more to you: **§ 10 Indemnification** is broad and uncapped — you indemnify Apple for, among other things, *"any claims that Your Covered Product... violate or infringe any third-party IP Rights."* Meanwhile **§ 13 caps Apple's total liability to you at fifty dollars ($50.00).** The risk allocation is entirely one-directional, and no policy you can afford changes that.

**Google Play — Developer Distribution Agreement (effective Sept 15, 2025): NO insurance requirement.** I fetched the full agreement text and searched it: **zero occurrences of "insurance."** **[verified]** It does have a § 14 Indemnification obligation running from you to Google.

**Stripe: NO insurance requirement for Connect platforms.** I fetched and searched:
- Stripe Services Agreement — General Terms (`stripe.com/legal/ssa`): no insurance obligation. **[verified]**
- Stripe Connected Account Agreement (`stripe.com/legal/connect-account`): no insurance obligation. **[verified]**
- Stripe Services Terms (`stripe.com/legal/connect`): the **only** insurance obligation anywhere is inside the **Stripe Connections** (financial-data) product terms — *"Maintain a level of insurance that is reasonable based on the risk associated with User's collection, use, retention and disclosure of Connections Data"* — and it applies only if you use Stripe Connections. **[verified]** If Laybell doesn't use Stripe Financial Connections, this doesn't apply. If it ever does, note it's a vague reasonableness standard, not a stated limit.

**Maryland: NO insurance mandate for an LLC with no employees.** There is no general business-insurance requirement. Workers' comp is the only candidate and the answer is nuanced:
- Md. Lab. & Empl. **§ 9-206** makes an LLC member a *covered employee* if they *"provide a service for the... limited liability company for monetary compensation."* A member owning **at least 20% of the outstanding interests in profits** may **elect to be exempt**, which requires submitting written notice to the Commission. **[verified from the official Maryland code site]**
- Md. Lab. & Empl. **§ 9-407**: failing to secure compensation for covered employees carries a penalty **up to $25,000**. **[verified from the MD WCC site]**
- **[inference]** As a 100%-owner member who isn't drawing compensation and has no other employees, you are not a practical enforcement target — but the statute's default is that a compensated member *is* covered, so this is not a clean zero. Since August 2023 the LLC-member exclusion is filed through **CompHub** (comphub.wcc.state.md.us). Filing it is free and removes the ambiguity permanently. **The moment you hire a W-2 employee, coverage becomes genuinely mandatory.**

**Nobody else:** no landlord (no lease), no enterprise customer (no B2B contracts), no investor (no round). That's the complete list, and it's empty.

---

## Cheap business-admin items with deadlines

| Item | Deadline | Cost | Status / notes |
|---|---|---|---|
| **Maryland Annual Report + Business Personal Property Return (Form 1)** | **April 15, 2026.** 60-day extension available → **June 15, 2026** (online request only, via SDAT or Maryland Business Express) | **$300** (+ ~3% online convenience fee) | SDAT's own words: *"All domestic and foreign business entities should file their 2026 reports online or by mail, on or before April 15."* **Required every year regardless of revenue or whether you own any personal property.** Missing it → loss of Good Standing → eventually administrative forfeiture of the LLC (which would also blow up your liability shield). **[verified]** |
| **DMCA designated agent renewal** | **Every 3 years from registration** — the Copyright Office emails reminders at 90/60/30/7 days | **$6** | *"A service provider's designation will expire and become invalid three years after it is registered."* Let it lapse and you *"risk losing the safe harbor protections of section 512."* **Put the expiry date in your calendar now — this $6 item protects you more than a $3,000 policy would.** **[verified]** |
| **Maryland resident agent** | Continuous — no grace period if vacant | $0 if it's you at a Maryland street address; ~$50–$150/yr commercial | Must be a physical Maryland street address; **no P.O. boxes**, no DC/VA address. If you use your home address it's public record — that's the trade-off. **[secondary-source verified]** |
| **EIN** | Before opening the business bank account | **$0** | IRS: *"Beware of websites that charge for an EIN. You never have to pay a fee for an EIN."* Issued immediately online; the session times out after 15 min of inactivity. **[verified]** |
| **Separate business bank account** | Do it before the first dollar moves | $0–$15/mo | Maryland is a hard veil-piercing state (*Hildreth*), so commingling is less legally fatal here than the internet claims — **but do it anyway.** It's the difference between a 20-minute tax filing and a nightmare, and it's the first thing any opposing party points at. Stripe payouts and Apple/Google disbursements should land in the LLC's account, never a personal one. |
| **BOI / Corporate Transparency Act** | **Nothing to file** | $0 | See the ⚠️ section — this changed in 2025 and is still not final. |
| **Maryland sales & use tax registration** | Before the first taxable Maryland sale — **see ⚠️ below** | $0 to register (Combined Registration Application) | This is the one tax item with a real trap in it. Read the ⚠️ section. |
| **S-corp election (Form 2553)** | N/A — **skip it** | — | Consensus among tax practitioners: below roughly **$40K–$60K of net profit** the payroll/compliance cost exceeds the SE-tax savings. At pre-revenue it's strictly negative. Revisit at ~$60K+ profit. **[secondary-source consensus, multiple sources]** |
| **Accountable plan** | N/A — **skip it** | — | An accountable plan requires an employer/employee relationship. A single-member LLC is a disregarded entity; you are not your own employee. You just deduct business expenses on Schedule C. **[secondary-source verified]** |
| **Maryland trader's license** | Probably N/A | — | Trader's licenses cover retail sales of *tangible* goods. Digital-only sales shouldn't trigger it, but confirm with the Comptroller if you ever ship anything physical (merch). **[inference]** |
| **Free legal help** | Anytime | $0 | **Maryland Volunteer Lawyers for the Arts** (mdvla.org, 410-752-1633) does pro bono work for Maryland creatives on exactly this stuff — entity maintenance, contracts, copyright. Financially-eligible applicants get free representation; their workshops and Art Law Clinics are open to all Maryland creatives. **Given the music-licensing gap above, this is the single best free resource in this document.** Also: Pro Bono Resource Center of Maryland (probonomd.org), Maryland SBDC, SCORE. |

---

## ⚠️ Verify yourself / changed recently

**1. BOI / Corporate Transparency Act — currently NOTHING to file, but not final.**
FinCEN's own alert, updated March 26, 2025, read directly off fincen.gov:

> "**ALERT [Updated March 26, 2025]:** All entities created in the United States — including those previously known as 'domestic reporting companies' — and their beneficial owners are now exempt from the requirement to report beneficial ownership information (BOI) to FinCEN."

This came from an **interim final rule**, not a final one. FinCEN said it intended to finalize during 2025 and, as of this writing, **has not**. A final rule is expected in 2026 and litigation continues. **[the exemption is verified from the primary source; the "still not finalized" status is from secondary reporting and is the part most likely to change]**
**→ Action: check fincen.gov/boi once a quarter. Do not pay any service that emails you about "mandatory BOI filing" — that's a known scam vector.**

**2. Maryland sales tax on the Shop feature — the real trap in this document.**
Maryland's **Business Tax Tip #29** (Comptroller's own guidance) defines a taxable **digital product** to include *"A work that results from the fixation of a series of sounds that are transferred electronically, including prerecorded or live music or performances."* **A beat or a song sold through Laybell's shop is squarely a taxable digital product at 6%.** **[verified from the primary PDF]**

Worse, the **marketplace facilitator** definition (Md. Tax-Gen. § 11-101(c-2)(1)) is:

> "a person that: (i) facilitates a retail sale by a marketplace seller by listing or advertising for sale in a marketplace tangible personal property, digital code, or a digital product; and (ii) regardless of whether the person receives compensation... collects payment from a buyer and transmits the payment to the marketplace seller."

And: *"A marketplace facilitator shall collect the applicable sales and use tax due on a retail sale... by a marketplace seller to a buyer in Maryland."* **[verified]**

Laybell's shop lists digital products for sale by users and moves the money via Stripe Connect. **On a plain reading that makes Laybell a marketplace facilitator with a collection obligation on sales to Maryland buyers.** **[inference — but a direct one from the statutory text]**

The **$100,000 / 200-transaction threshold does not save you**: Tax Tip #29 places that threshold under *"Out-of-State Vendors."* Laybell is a **Maryland** entity, so it's an in-state vendor and the economic-nexus threshold isn't the applicable test. **[verified]**

Also note: **Apple and Google already handle sales tax on IAP** — they're marketplace facilitators and collect/remit as the retailer. **Stripe does not do this by default** (Stripe Tax is a separate paid product). So the IAP side is fine and the Stripe-Connect shop side is where the exposure sits.
**→ Action: this is a free phone call. Comptroller of Maryland taxpayer services, 1-800-638-2937, or the Business Tax Tip #29 email contact. Ask specifically: "I operate a Maryland-based app where users sell digital music files to each other and I transmit payment through Stripe Connect. Am I a marketplace facilitator, and at what point must I register?" Get the answer before the shop has meaningful volume, not after. At near-zero revenue the dollars are trivial; the registration posture is what you want to get right early.**

**3. Maryland's new 3% "tech tax" — probably doesn't apply to you, but verify.**
HB 352 (signed May 20, 2025, effective July 1, 2025) applies a 3% sales tax to services in **NAICS 518, 519, 5415, and 5132** (data/IT services, software publishing, SaaS for commercial use). A social network / media streaming service is **NAICS 516210**, which is *not* on that list. **[inference — the NAICS classification of Laybell and the list of taxed codes are both verified, but the conclusion that Laybell falls outside is my reasoning, not a ruling.]** The Comptroller issued **Technical Bulletin No. 56** on this. Worth one question in the same phone call as item 2.

**4. Section 230 and product-design claims are actively moving.** *Anderson v. TikTok* (3d Cir. 2024) conflicts with earlier rulings from several other circuits — its own concurrence flags the split. MDL 3047 and the California JCCP are producing new rulings continuously, with a bellwether trial reported in early 2026. **Do not treat § 230 as settled protection for algorithmic or engagement-mechanic design choices.**

**5. Insurance for social platforms is getting harder, not easier.** The March 2026 Delaware ruling that 20+ insurers owe Meta no defense in the addiction litigation is the clearest signal. If you eventually buy coverage, the question to ask in writing is not "am I covered?" but **"is UGC hosted on my platform covered, and under which endorsement?"**

**6. MODPA's 35,000-Maryland-consumer threshold** is a data-volume trigger, not a revenue trigger. Track it. Also, the thresholds themselves are from converging secondary sources, not the enrolled bill text (which wouldn't render) — worth confirming against the statute if you approach the line.

**7. Maryland workers' comp for a compensated single member** is genuinely ambiguous under § 9-206. Filing the exclusion through CompHub is free. Do it if you ever start paying yourself a salary.

**8. The Hiscox $3,000 media-liability minimum, the "combined cyber + Tech E&O $1,500–$4,000" figure, and most defense-cost ranges** in this doc are secondary-source estimates I could not confirm against a primary document. Treat all pricing here as ballpark for budgeting, never as a quote.

---

## Sources

**Insurance pricing & appetite**
- Vouch, Startup Insurance Costs 2026 — https://www.vouch.us/blog/startup-insurance-costs
- Vouch, Media Liability Insurance — https://www.vouch.us/blog/media-liability-insurance
- Insureon, Media & Advertising Liability Insurance Cost (data updated Apr 7, 2025) — https://www.insureon.com/media-business-insurance/cost
- Insureon, Cyber Liability Insurance Cost (updated Apr 24, 2026) — https://www.insureon.com/small-business-insurance/cyber-liability/cost
- Insureon, Mobile App Developer Insurance Cost — https://www.insureon.com/technology-business-insurance/mobile-app-developers/cost
- Corgi Insurance, Media Liability (UGC endorsement language) — https://www.corgi.insure/media-liability
- Corgi Insurance, Media Liability for Startups — https://www.corgi.insure/blog/media-liability-insurance-for-startups
- Beazley, Media Liability (social media in appetite) — https://www.beazley.com/en-US/products/specialty-risk-usa/media-liability/
- Founder Shield, Insurance for Social Media Companies — https://foundershield.com/business-insurance/media/social-media-companies/
- AXIS, Multimedia Company Liability — https://www.axiscapital.com/insurance/cyber-technology-e-o/media-entertainment-liability/multimedia-company-liability
- NAIC *Journal of Insurance Regulation* Vol. 40 No. 4 (2021), "Insurance for Social Media Liability" — reproduces ISO CG 00 01 exclusion text — https://content.naic.org/sites/default/files/Insurance%20for%20social%20media%20liability%20-%202021.pdf
- Insurance Journal, "Meta Loses Insurance for Defense in Major Social Media Addiction Litigation" (Mar 3, 2026) — https://www.insurancejournal.com/news/national/2026/03/03/860193.htm
- Risk & Insurance, "Social Media Addiction Lawsuits Raise New Insurance Coverage Challenges" — https://riskandinsurance.com/social-media-addiction-lawsuits-raise-new-insurance-coverage-challenges/
- Business Insurance, "Insurers shun user-generated content" (2017, dated but on point) — https://www.businessinsurance.com/article/20170501/NEWS06/912313180/Insurers-shun-user-generated-content-news-media

**Platform agreements (all fetched and searched directly)**
- Apple Developer Program License Agreement (PDF, §6.1 insurance, §10 indemnification, §13 $50 cap) — https://developer.apple.com/support/downloads/terms/apple-developer-program/Apple-Developer-Program-License-Agreement-English.pdf
- Google Play Developer Distribution Agreement (eff. Sept 15, 2025 — zero "insurance" mentions) — https://play.google.com/about/developer-distribution-agreement.html
- Stripe Services Agreement, General Terms — https://stripe.com/legal/ssa
- Stripe Services Agreement, Services Terms (Connections insurance clause) — https://stripe.com/legal/connect
- Stripe Connected Account Agreement — https://stripe.com/legal/connect-account

**Statutes & case law**
- 47 U.S.C. § 230 (incl. (e)(1)–(e)(5) exceptions) — https://www.law.cornell.edu/uscode/text/47/230
- 17 U.S.C. § 512 (safe harbor, §512(i) repeat infringer, §512(f)) — https://www.law.cornell.edu/uscode/text/17/512
- 17 U.S.C. § 504(c) (statutory damages) — https://www.law.cornell.edu/uscode/text/17/504
- 17 U.S.C. § 114 (sound recording rights) — https://www.law.cornell.edu/uscode/text/17/114
- 17 U.S.C. § 115 (mechanical / MLC blanket licence) — https://www.law.cornell.edu/uscode/text/17/115
- 18 U.S.C. § 2258A (CSAM reporting penalties) — https://www.law.cornell.edu/uscode/text/18/2258A
- 15 U.S.C. § 45 (FTC Act §5) — https://www.law.cornell.edu/uscode/text/15/45
- Md. Code, Corps. & Ass'ns § 4A-301 (LLC member liability shield) — https://mgaleg.maryland.gov/mgawebsite/Laws/StatuteText?article=gca&section=4A-301&enactments=false
- Md. Code, Lab. & Empl. § 9-206 (LLC members as covered employees; 20% exemption election) — https://mgaleg.maryland.gov/mgawebsite/Laws/StatuteText?article=gle&section=9-206&enactments=false
- *Hildreth v. Tidewater Equipment Co.*, 378 Md. 724 (2003) — https://caselaw.findlaw.com/court/md-court-of-appeals/1239560.html
- *BMG Rights Mgmt. v. Cox Communications*, 881 F.3d 293 (4th Cir. 2018) — https://james.grimmelmann.net/courses/internet2018S/BMGvCox.pdf
- *EMI Christian Music Group v. MP3tunes*, 844 F.3d 79 (2d Cir. 2016) — https://pryorcashman.gjassets.com/content/uploads/2020/03/EMI-Second-Circuit.pdf
- *Ventura Content v. Motherless*, 9th Cir. 2018 — https://cdn.ca9.uscourts.gov/datastore/opinions/2018/03/14/13-56332.pdf
- *Anderson v. TikTok*, No. 22-3061 (3d Cir. 2024) — https://www2.ca3.uscourts.gov/opinarch/223061p.pdf

**Music licensing**
- BMI, "Business Using Music: BMI and Performing Rights" — https://www.bmi.com/licensing/entry/business_using_music_bmi_and_performing_rights
- ASCAP Licensing FAQ — https://www.ascap.com/help/ascap-licensing
- SoundExchange, Licensing 101 (interactive services excluded from statutory licence) — https://www.soundexchange.com/service-provider/licensing-101/
- The MLC FAQs — https://www.themlc.com/faqs/categories/mlc
- U.S. Copyright Office, Music Modernization Act FAQ — https://www.copyright.gov/music-modernization/faq.html

**Maryland & federal admin**
- Maryland SDAT Forms page (2026 Annual Report deadline Apr 15, extension to June 15) — https://dat.maryland.gov/Pages/sdatforms.aspx
- Maryland SDAT Businesses page ($300 Annual Report fee) — https://dat.maryland.gov/businesses/Pages/default.aspx
- MarylandSaves, Claim Your Fee Waiver (**requires employees — not available to you**) — https://www.marylandsaves.org/claim-fee-waiver/
- Maryland WCC, Insurance Compliance & Reporting (§9-407 $25,000 penalty) — https://www.wcc.state.md.us/Gen_Info/ICR.html
- Maryland WCC CompHub (LLC member exclusion filing) — https://comphub.wcc.state.md.us/Web/
- Maryland Comptroller, Business Tax Tip #29 — Sales of Digital Products and Digital Codes (PDF) — https://www.marylandcomptroller.gov/content/dam/mdcomp/tax/legal-publications/tips/business/bustip29.pdf
- FinCEN, Beneficial Ownership Information Reporting (alert updated Mar 26, 2025) — https://www.fincen.gov/boi
- U.S. Copyright Office, DMCA Directory FAQs (3-year expiry, $6 fee, reminder schedule) — https://www.copyright.gov/dmca-directory/faq.html
- IRS, Get an Employer Identification Number (free) — https://www.irs.gov/businesses/small-businesses-self-employed/get-an-employer-identification-number
- Maryland Business Express, Apply for Tax Accounts and Insurance — https://businessexpress.maryland.gov/start/taxes-and-insurance
- Maryland General Assembly, SB541 (MODPA, eff. Oct 1, 2025) — https://mgaleg.maryland.gov/mgawebsite/Legislation/Details/sb0541?ys=2024RS
- Maryland Volunteer Lawyers for the Arts — https://mdvla.org/apply-for-lawyer/
- Pro Bono Resource Center of Maryland — https://probonomd.org/

**Defense-cost estimates (secondary sources, low-to-moderate confidence)**
- Engine, "The Cost of Section 230 Litigation" — https://www.engine.is/news/primer/section230costs
- Institute for Free Speech, cost of fighting a SLAPP — https://www.ifs.org/blog/estimating-the-cost-of-fighting-a-slapp-in-a-state-with-no-anti-slapp-law/
- U.S. Chamber Institute for Legal Reform / Brattle, small-business tort costs — https://instituteforlegalreform.com/blog/the-us-lawsuit-system-costs-americas-small-businesses-160-billion/
