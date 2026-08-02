# Performance-rights coverage: decisions and deferrals

A dated record of which performing-rights organisations Laybell licensed before
launch, which it deliberately did not, and why. Deferring is defensible; deferring
by accident is not. This document is the difference.

Update it whenever the position changes.

---

## Position as of 2026-07-28

| PRO | Status | Detail |
|---|---|---|
| **BMI** | ✅ Licensed | Digital Multi-Use Performance License Agreement, signed and paid 2026-07-28. **$385, Tier 1, one-year term, no reporting requirements.** Customer number 61346887. ⚠️ **Tier 1 ceiling: $18,500 revenue / 59,000 stream hours — §8 auto-terminates 20% over.** Metered by `stream_hours.sql`. No auto-renewal: re-apply before the End Date. |
| **ASCAP** | ❌ **NOT licensed — action required** | An **email** was sent to weblicense@ascap.com 2026-07-28 requesting the Experimental License Agreement for Interactive Services. It was never a filing: email produces no confirmation and no ticket, so the silence since is uninformative, and **nothing is in force**. Corrected route (verified 2026-08-02): buy the Website & Mobile App licence through the self-serve form at <https://licensing.ascap.com/?type=digital>, exactly as BMI was done. Pre-revenue is explicitly fine ("good faith estimate"). See `PRO_LICENSING_PACK.md` Step 1. |
| **SESAC** | ⏸ Deferred | See below. |
| **GMR** | ⏸ Deferred | See below. |
| **MLC** (mechanical) | ⏸ Open | Separate from performance rights. Decision pending — see `docs/PRO_LICENSING_PACK.md`. |

---

## Why SESAC and GMR are deferred

**The decision.** Laybell is launching without licences from SESAC or Global Music
Rights. This is a considered choice, taken with knowledge of the exposure, not an
oversight.

**The reasoning.**

1. **Neither is obtainable on a self-serve basis.** Both are invite-only, publish
   no rate schedules, and require direct negotiation. There is no application form
   equivalent to BMI's. GMR in particular is not constrained by a consent decree,
   which historically means less pricing discipline for a small licensee.

2. **The repertoire slice is small.** ASCAP and BMI together represent the large
   majority of US songwriters. SESAC and GMR are meaningful but comparatively
   narrow.

3. **Laybell's catalogue is entirely user-uploaded original work by independent
   artists.** Independent writers affiliate overwhelmingly with ASCAP or BMI,
   because that is the default route distributors push. The probability that a
   SESAC or GMR writer's work is performed on the service at launch scale is low —
   though not zero, and that residual is the accepted risk.

4. **Cost and negotiation time are disproportionate at pre-revenue scale.** Both
   would require a negotiation cycle for a service with no users and no revenue.

**What is being accepted.** If a SESAC- or GMR-affiliated writer's work is
performed on Laybell, that performance is unlicensed. The exposure scales directly
with usage, and is near zero at launch.

**Triggers to revisit — whichever comes first:**

- Laybell reaches **$50,000** of gross annual revenue
- A takedown notice, claim, or licensing approach naming SESAC or GMR
- Any deliberate move toward commercial catalogue rather than user-uploaded
  originals
- **Annually**, alongside the BMI renewal

---

## Recurring obligations created by these licences

| Obligation | Cadence | Consequence of missing it |
|---|---|---|
| BMI licence renewal | Annual | Performing BMI repertoire unlicensed |
| ASCAP renewal | Per agreement, once issued | Same, for ASCAP repertoire |
| Review this document | Annual | Deferral stops being a decision and becomes an accident |

---

*Signed:* **Edwin Hall**  *Date:* **7/28/2026**

*Entered on Edwin Hall's express instruction. This is an internal record of a
business decision, not an agreement with a third party — any counterparty document
(the BMI licence included) must be signed by Edwin Hall personally.*
