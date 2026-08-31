# 1.0.1 — release notes

Paste-ready copy for both stores. **The two are different lengths on purpose:**
Google Play caps release notes at **500 characters**, App Store "What's New" at
**4000**. Character counts are asserted by `scripts/check-release-notes.mjs` —
run it after any edit rather than trusting a word processor's count, because
Play rejects at submission time and that is a slow way to find out.

Written for someone deciding whether to open the app, not for the changelog.
Internal names (`RotatingCaption`, `handoffPositionMs`) stay out of both.

---

## Google Play — "What's new" (≤500 chars)

```
Albums are here. Collect your tracks into real releases on your profile, and pin up to 4 things to a Featured shelf.

Tap any cover art for a new full-screen player with a scrubber you can drag anywhere.

Music videos now show the song's artwork — tap it and the track keeps playing from where the video was.

Slideshows gained an Arrange step: reorder, delete and crop before you post.

Plus reel filters, pinch-to-zoom photos, and a lot of smaller fixes.
```

---

## App Store — "What's New in This Version" (≤4000 chars)

```
ALBUMS

Your songs can be a release now, not just a list. Collect tracks into an album, give it cover art, and it appears on your profile with everything else you have put out. Anything not in an album is filed under Singles.

You can also pin up to four things — songs or whole albums — to a Featured shelf at the top of your Music tab, so the first thing a visitor hears is the thing you want heard.

A NEW WAY TO LISTEN

Tap the cover art anywhere in the app for a full-screen player: the artwork fills the screen, and you can scrub by dragging anywhere on it rather than aiming at a thin bar.

MUSIC VIDEOS

A music video now shows the song's artwork in the corner instead of a text pill. Tap it and the song keeps playing in Laybell's player, picking up roughly where the video had reached — so it feels like moving rooms, not starting over. When we cannot be confident about the timing, it starts from the beginning instead.

Films and music videos also take turns showing their title and description, so a long description is no longer cut to one line.

SLIDESHOWS

There is a new Arrange step between choosing your photos and writing the post. Swipe to browse, tap a thumbnail to jump, hold and drag to reorder, and crop to Original, 1:1 or 4:5. Slides publish at the shape they were shot at.

Slideshows now open in the reel viewer too, and double-tap to like works on them again.

REELS

Filter by All, Vertical, Horizontal or Films. Sideways viewing is cleaner — the progress bar leaves with the rest of the controls and comes back on a tap.

EVERYWHERE ELSE

- Pinch to zoom photos in the feed
- Empty screens redrawn to feel like the rest of iOS
- Colour used more sparingly, so the orange means something when you see it
- Better contrast in dark mode
- Keyboard fixes across the app, including Edit Profile, where Save could need a second tap
- Sign-in and password screens now show which field you are typing in, and offer to save a new password to your keychain
```

---

## Where these go

- **App Store Connect** → the 1.0.1 version page → *What's New in This Version*.
- **Play Console** → *Production* → the release → *Release notes* → `en-US`.

Only `en-US` is filled. The other nine locales the app supports are a separate
question from the store listing languages, and the listings are English-only
today — see the i18n note in `docs/LAUNCH_CHECKLIST.md` §0.0.
