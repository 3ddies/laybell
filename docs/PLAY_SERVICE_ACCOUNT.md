# Letting `eas submit` reach Google Play

One-time setup. After it, shipping Android is `eas submit --platform android`
instead of downloading an `.aab` and uploading it by hand.

**You have to do this part yourself.** It produces a private key that can upload
releases to your Play account, and handing that to anyone — including me — is not
something to do casually. The steps are short.

## What is already done

- `eas.json` → `submit.production.android` is configured and waiting for the key.
- `.gitignore` already blocks `*service-account*.json`, so the file cannot be
  committed by accident once it is named as below.

## What you do

**1. Make the service account** — Google Cloud Console, in the project linked to
your Play account.

- IAM & Admin → Service Accounts → **Create service account**
- Name it something obvious: `eas-play-publisher`
- **Skip** the optional "grant this service account access to the project" step.
  It needs no Google Cloud roles at all; its power comes from Play, granted in
  step 3. Adding project roles here only widens what a leaked key could touch.
- Open the new account → **Keys** → Add key → Create new key → **JSON** → Create.
  The file downloads once. Google will not show it again.

**2. Put it where EAS expects it**

Rename the downloaded file to exactly:

```
play-service-account.json
```

and put it in the repo root (`C:\Users\3ddie\laybell\`). The `.gitignore` rule
matches that name, so `git status` will not offer it and a commit cannot pick it
up. **Check that** before going further — `git status --porcelain` should not
mention it.

**3. Give it access in Play Console**

- Play Console → **Users and permissions** → Invite new user
- Paste the service account's email (it looks like
  `eas-play-publisher@<project>.iam.gserviceaccount.com`)
- App permissions: add **Laybell**
- Grant only what publishing needs:
  - *View app information and download bulk reports*
  - *Manage production releases* (and testing tracks if you want internal builds)
  - **Not** the financial or user-data permissions. This key only needs to push
    a build.
- Invite, then let it sit a few minutes — Google takes a little while to
  propagate a new grant, and a submit tried immediately can fail with a
  permission error that fixes itself.

**4. Tell me, and I will run the submit.**

## Why `releaseStatus` is "draft"

Play has **no manual-release hold** for an app that is already published, so a
normal submission goes live the moment review passes. `"draft"` makes EAS create
the release as a *draft* instead — the bundle is uploaded and sitting in Play
Console, and nothing reaches users until you roll it out yourself.

That is the same shape as the 1.0.0 launch, where the unsent draft WAS the hold.

If you would rather one command shipped it outright, change `releaseStatus` to
`"completed"` — just be clear that then approval means live, with no further
step from you.

## If a submit fails later

- *"The caller does not have permission"* — the Play grant in step 3 is missing,
  scoped to the wrong app, or has not propagated yet.
- *"APK/AAB signed with the wrong key"* — unrelated to this; that is the upload
  key, which EAS already holds.
- *Version code already used* — Play rejects a versionCode it has seen.
  `autoIncrement` handles this, so it usually means a build was uploaded by hand
  and EAS's counter is behind.
