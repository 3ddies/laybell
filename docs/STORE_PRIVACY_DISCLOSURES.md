# App Store & Google Play — privacy disclosure cheat‑sheet

Transcribe these answers into **App Store Connect → App Privacy** and **Google Play Console → App content → Data safety**. They match exactly what the app actually collects (see the Privacy Policy). Keeping these accurate is the #1 way to avoid store rejection and regulatory trouble.

Two global truths to select everywhere they're asked:
- **We do NOT use data to track you across other companies' apps/websites** → Apple "Tracking": **No**.
- **We do NOT sell or share data for cross‑context behavioral advertising**, and use **no third‑party ad/analytics/crash SDKs** → Google "Data shared with third parties": **No** (service providers like Supabase/Expo are processors, not third‑party sharing).
- **Encrypted in transit: Yes.** **Users can request deletion in‑app: Yes** (Settings → Privacy & data, and Delete Account).

---

## Apple — App Privacy (per data type: Collected? · Linked to identity? · Used for tracking? · Purposes)

| Data type | Collected | Linked | Tracking | Purpose |
|---|---|---|---|---|
| Email address | Yes | Yes | No | App Functionality (account) |
| Phone number (optional) | Yes | Yes | No | App Functionality (friend‑matching) |
| Name (display name) | Yes | Yes | No | App Functionality |
| User ID / Username | Yes | Yes | No | App Functionality |
| Other user content — Photos/Videos | Yes | Yes | No | App Functionality |
| Audio data (uploaded audio posts) | Yes | Yes | No | App Functionality |
| Other user content — posts, comments, messages | Yes | Yes | No | App Functionality |
| Coarse Location (optional) | Yes | Yes | No | App Functionality (people nearby) |
| Contacts (optional; stored hashed) | Yes | Yes | No | App Functionality (find friends) |
| Sensitive Info (gender, date of birth/age) | Yes | Yes | No | App Functionality (age‑gate, personalization) |
| Product Interaction / Usage Data | Yes | Yes | No | Analytics (first‑party), App Functionality |
| Device ID | Yes | Yes | No | App Functionality (fraud prevention) |
| Customer Support (if you reply to support emails) | Yes | Yes | No | App Functionality |

> Notes: We do **not** collect precise location, browsing history, search history (beyond in‑app), health/financial data, or payment info (payments are in preview). If you later add real payments, add **Purchases / Payment Info**.

---

## Google Play — Data safety

**Data collected (all: collected, processed ephemerally = No, optional where noted, encrypted in transit = Yes, deletable = Yes):**

- **Personal info** → Name, Email address, User IDs, Phone number *(optional)*, Gender *(optional)*, Date of birth, Other info (username). Purpose: Account management, App functionality.
- **Location** → Approximate location *(optional)*. Purpose: App functionality.
- **Photos and videos** → Photos, Videos. Purpose: App functionality.
- **Audio files** → Music files / other audio (user‑uploaded audio posts). Purpose: App functionality.
- **Messages** → Other in‑app messages (direct messages). Purpose: App functionality.
- **Contacts** *(optional)* → Contacts. Purpose: App functionality. *(We upload only salted hashes; raw contacts are never stored.)*
- **App activity** → App interactions, Other user‑generated content. Purpose: App functionality, Analytics.
- **Device or other IDs** → Device or other IDs. Purpose: App functionality, Fraud prevention.

**Data shared with third parties:** **None.** (Supabase and Expo are service providers/processors; Apple/Google handle distribution & push. None of these is third‑party "sharing" under Google's definition, and we don't sell data or use ad networks.)

**Security practices:** Data is encrypted in transit = **Yes**. You provide a way to request data deletion = **Yes** (in‑app: Settings → Privacy & data → Download/Delete; or email privacy@laybell.app). Committed to Google Play's Families/Designed‑for‑Families policy only if you opt into a child‑directed audience — Laybell is **13+/Teen**, not directed to children.

---

## Store listing settings
- **Privacy policy URL:** `https://laybell.app/privacy` (host the `web/` folder first — see LEGAL_ROLLOUT.md).
- **Apple age rating:** complete the questionnaire honestly → expect **12+** (user‑generated content + social). Enable the **App Store UGC requirements**: a EULA/terms link, in‑app reporting (you have it), blocking (you have it), and a way to filter/act on objectionable content within 24h.
- **Google content rating (IARC):** answer the questionnaire → expect **Teen**. Set **Target audience = 13+** and confirm the app is not designed for children.
- **Account deletion URL (Google requirement):** you can point to `https://laybell.app/privacy` (which documents in‑app deletion) plus the in‑app Delete Account flow.
