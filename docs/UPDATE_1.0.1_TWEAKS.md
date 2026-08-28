# 1.0.1 — tweak list

Running list of cosmetic and behavioural changes for 1.0.1. Add anything here; nothing in this
file touches the released app until a **production** build is submitted.

**How to add one:** screenshot the screen on your phone, say what bothers you. "The like count
sits too close to the avatar" is enough — precise pixel direction is my job, not yours.

---

## How this gets tested

`expo-dev-client` is installed, so tweaks do **not** need a build each:

1. **Once:** build and install a development client on your iPhone.
   ```
   npx eas-cli build --profile development --platform ios
   ```
   (If it asks to register the device, say yes — internal distribution needs it.)

2. **Every time after:** start the dev server and open the app.
   ```
   npx expo start --dev-client
   ```
   Every JS/TS change appears on your phone in seconds. Change, look, say "no, more", repeat.

**What still needs a fresh dev build:** anything native — a new dependency, an `app.json` plugin
change, a permission string, an icon. Almost nothing cosmetic is native.

---

## What is safe, and the one thing that is not

**Client code is a sealed sandbox.** Everything in `app/`, `components/`, `lib/`, `contexts/`,
and `app.json` is frozen into the binary at build time. There is no OTA on this project, so the
App Store copy of 1.0.0 build 4 physically cannot change no matter what happens here. It is
tagged `v1.0.0-build4`. Tweak as aggressively as you like.

🚨 **Server-side is NOT gated. It is live surgery on the shipped app.**

| Change | Reaches the live App Store app |
|---|---|
| `app/`, `components/`, `lib/`, `contexts/`, `app.json` | ❌ never, until a production build ships |
| `supabase/sql/*` run against production | ✅ **instantly** |
| `supabase/functions/*` deployed | ✅ **instantly** |
| `web/*` pushed (laybell.app, legal pages, share pages) | ✅ **instantly** |

Most cosmetic tweaks are pure client. If one needs a database column, an RPC, or an edge
function, **I will say so before doing it** — that is the line where "safe to experiment"
stops.

---

## Tweaks

| # | Screen | Change | Type | Status |
|---|---|---|---|---|
| 1 | Bottom nav, condensed state (iOS) | Feed showing between the floating chips competed with the icons — added a soft ground under the row | Cosmetic | ✅ done, needs a look on device |
| 2 | Login + Signup | Log in / Create account buttons now carry the Listen-mode gradient instead of flat orange | Cosmetic | ✅ done |
| 3 | Signup | ToS + Privacy links neutral (white, underlined) instead of orange | Cosmetic | ✅ done |
| 4 | Login + Signup | The ~2s freeze after a successful sign-in that looked like the tap failed | Functional | ✅ done |
| 5 | Login + Signup | Logo mark now draws itself in, using the brand animation | Cosmetic | ✅ done |
| 6 | All 4 auth screens | Keyboard now dismisses on tap-outside, on drag, and on submit | Functional | ✅ done |
| 8 | All 4 auth screens | Slow warm brand bloom behind the form, so the screen is not flat | Cosmetic | ✅ done, tuned |
| 9 | Login + Signup | Sheen sweep on the primary button, like the Listen pill | Cosmetic | ✅ done |
| 10 | Login + Signup | Text fields given an edge and a real focus state | Cosmetic | ✅ done |
| 11 | All 4 auth screens | The form leaping when the keyboard opens — worst on login | Functional | ✅ done |
| 12 | Signup | Logo sat hard against the Dynamic Island | Cosmetic | ✅ done |
| 13 | Sign-in handoff | The auth screen visibly **reset itself** before the feed appeared | Functional | ✅ done |

### 13 · The "freeze" after a successful login was a remount

Reported as *"a split second where the page looks like it freezes/glitches — the spinner stops
and the bell logo animates"*. The screen recording shows something worse than a rough transition:
**the login form resets.** Fields blank, logo replaying from frame one, button back to idle — and
only then the feed.

**Cause:** `app/_layout.tsx` keys the entire per-user tree on the user id. On sign-in that key
goes `'signed-out'` → the id, so React tears the subtree down and rebuilds it — **including the
sign-in screen the user is still looking at.** It looks exactly like a failed submit, which is
why the instinct is to tap again.

**That key stays.** It is preventing a real defect: without it, a second account signing in on the
same device inherits the previous one's cached profile, stories and now-playing for a beat. The
fix is to cover the handoff, not remove the cause.

`components/AuthHandoff.tsx` is a branded cover from the moment the session lands to the moment
routing completes. The ~2s wait (profile fetch, deleted-account and geo-block checks) was always
there; this makes it read as **the app opening** rather than as the form failing.

**What it shows — the owner's call, and the better one.** The first version was a small icon
scaling in over the warm gradient; he asked for the orange to fill the screen and suggested using
the brand animation itself. That is right, and it resolves an earlier decision rather than
contradicting it: every objection to that video as a sign-in *background* (a form unreadable on
saturated orange, its LAYBELL wordmark colliding with the screen's own, a hard loop seam) **only
applied because there was a form and it looped.** Here there is neither. What was wrong behind a
login is exactly right as the moment after one.

The asset is the original trimmed to 5.6s and run 1.5× faster — note, bell drawing itself, ring,
settle, resolve to the wordmark. **3.77s and 433 KB**, because a flat gradient compresses to
nearly nothing even at high quality.

**Three defects in the first cut of this, all worth recording:**

1. **It never left.** The timer marking the animation complete lived in the raise-effect's
   **cleanup**. `visible` flips false the moment routing finishes — about two seconds in, well
   before the animation ends — which re-ran the effect, cleared the pending timer, and left the
   completion flag false forever. Cleanup now happens on unmount only. *A cleanup that cancels
   the thing it is waiting for is an easy shape to write and a hard one to see.*
2. **"The audio is still attached and delayed."** It is not — both assets are video-only, checked
   with ffprobe. What he heard was **the feed**: holding the cover so the app loads behind it
   means a video post mounts and **autoplays** under the animation. Fixed with
   `MediaSuspendContext`, which already existed for exactly this (full-screen takeovers pausing
   background media) and which every video component plus `PostMusicContext` honours. The
   suspender has to live *inside* the keyed tree, where the ref-counted provider is.
3. **Low resolution.** The first encode was CRF 23 at 1080×1920 — and a phone is *taller* than
   9:16, so `cover` upscales ~1.33× before cropping. Smooth gradients also band badly at that
   bitrate, which reads as "low res" more than softness does. Re-encoded at CRF 15,
   lanczos-scaled to 1242×2208, `aq-mode=3`.

**The fade-in also went away.** It exists to hide a remount that happens in the *same React
commit* that raises it, so any fade-in is a window straight onto the thing being hidden. It now
appears opaque; the cut from a light screen to brand red reads as "here we go".

**The minimum hold is a feature.** It waits for the animation to finish *and* for routing,
whichever is later. Sign-in resolves in about two seconds, so the remainder is the feed mounting
and fetching behind the cover — the owner's own point: the user watches something deliberate
instead of a spinner, and lands on a feed with a head start. The dead time existed either way;
this spends it.

Total tap-to-feed is now ~4.2s. If that feels long, `VIDEO_MS` and the asset's trim are the two
dials — but shortening it hands the time back to the feed's own loading skeletons.

Details that matter:

- **Rendered as a sibling AFTER the keyed view.** Inside it, the remount would destroy the very
  thing covering the remount. After it, it paints on top without depending on `zIndex`. The
  `EmailVerifiedToast` directly above it sits there for the same reason.
- **Raised only on a genuine sign-in** — `SIGNED_IN` *and* a previous user id of `null`. A token
  refresh or the cold-start `INITIAL_SESSION` would otherwise put a splash in front of someone
  who never left.
- **Lowered in a `finally`**, not at each return. The early exits (deleted account, geo-block)
  sign back out and never navigate, and the next person adding a branch there will not remember
  to add the call.
- **A 9s hard ceiling** on top of that. An offline profile fetch can hang for the client's full
  deadline, and a permanent splash is worse than the glitch it replaced.

### 12 · Why the signup logo was jammed under the island

Not a padding oversight — a consequence of the same property behind tweak 11.

Signup's content **overflows the viewport**: five fields, the consent row, the button and two
social buttons. `justifyContent: 'center'` only does something when there is slack, so with none
the content simply starts at `y=0`, hard against the status bar. Login has two fields, centres
happily, and never showed it.

Fixed with `paddingTop: insets.top + SPACING.xxl` — the **real** safe-area inset plus the
existing rhythm. A fixed number cannot be right across devices, since the inset differs between
a Dynamic Island, a notch and neither.

The base style now sets `paddingBottom` rather than `paddingVertical`, deliberately: a shorthand
there plus a longhand `paddingTop` in the inline override resolves by array order, and would
quietly stop working the day someone reorders the styles.

### 11 · Why the form "glitched into place", and why signup was better

The owner's clue was the whole answer again: *"the create account screen seems to do a better job
at not glitching."*

`KeyboardAvoidingView` with `behavior="padding"` **shrinks the container**. The content container
is `justifyContent: 'center'`, so a shorter box re-centres everything and the whole form leaps.
**Sign-up barely showed it because five fields nearly fill the viewport** — almost no slack left
to re-centre within. Sign-in has two fields and a screen full of slack, so it jumped hard. Visible
in the 2026-08-28 screen recording: the logo and button sit in completely different places before
and after focus.

**Fix:** iOS uses `automaticallyAdjustKeyboardInsets` on the ScrollView, which adjusts the scroll
view's `contentInset` instead of resizing it. The layout never recomputes, so nothing re-centres,
and iOS scrolls the focused field into view itself. `KeyboardAvoidingView` is switched **off on
iOS** and kept for Android, which has no equivalent.

Note this was not the field styling — the border is 1px in both states precisely so focus cannot
shift layout. It was the container all along.

**Still on the old inline fields:** `verify-email.tsx` and `reset-password.tsx`. They got the
keyboard and backdrop work but not `AuthField`/`AuthSubmitButton`, so their inputs have no focus
state and their buttons no gradient. Worth finishing for consistency.

### 10 · What was actually wrong with the text fields

The owner could not name it — *"something about them just doesn't seem like it's at its full
potential"* — so it was worth diagnosing rather than restyling at random. Three things:

1. **No focus state at all.** Tapping a field changed nothing: same fill, same edge, same icon.
   The keyboard appearing was the only evidence anything had happened. **This is the big one.**
   Every field a person trusts with a password should tell them which field they are in.
2. **No edge.** A filled box with no border on a dark ground has no defined shape — it reads as a
   slightly lighter smudge rather than a control.
3. **The icon was `textTertiary`** (`#484848` on dark), *dimmer than the placeholder beside it*.
   It sat there as grey furniture instead of labelling the field.

`components/AuthField.tsx` gives the field a hairline that turns brand-warm on focus, a fill that
lifts one step up the surface ramp, and an icon that goes from muted to full brand when live.

**Deliberately not animated.** Focus happens at exactly the moment the keyboard is animating up,
and a JS-driven colour interpolation competing with that is how you get a stutter on the first
interaction anyone has with the app. Native fields snap too, and the instant change is clearer
feedback than a fade.

### 8b · Making the bloom actually visible, and 9b · sequencing it after the logo

Two rounds later, both worth recording because the first fix was in the wrong dimension.

**The bloom read as wallpaper because only the HUE moved.** Two layers cross-fading gold against
red keeps *total* strength near-constant, and a constant wash stops being seen within seconds —
raising the alphas (which is what the first "stronger" pass did) does not fix that, it just makes
a brighter constant. The owner's phrasing named the missing dimension exactly: *"fade more into
orange, and back to white."*

So there is now a second, independent loop: an **intensity pulse** taking the whole bloom from
28% to full and back. It runs on a **deliberately different period** (5.2s vs the hue's 7.5s) —
two loops on one clock lock together and read as a single mechanical pulse, while drifting ones
never repeat the same combination twice in a row.

Peaks were raised alongside it (`0.46/0.54` top), but these are now the top of a breath rather
than a constant, so the average on screen is lower than the numbers suggest. Reach extended to
84% and the light-theme damping softened from 0.55 to 0.76, since the owner runs Light and asked
for more.

⚠️ **Do not push the last stop past ~0.85.** Below that the fields start sitting *on* the bloom
instead of in front of it, and legibility is the one thing here that is not negotiable.

**The sheen now waits for the logo.** Owner: a button flashing while the bell is still ringing is
overstimulating. Correct — two animations at once on the first screen of the app means the eye has
nowhere to settle and neither lands. `AuthLogoMark` exports `MARK_ANIMATION_MS` (the asset's real
duration) and `AuthSubmitButton` holds its first sweep until that plus a beat, so re-cutting the
video cannot silently desynchronise them. Sequenced, it reads as one arrival: the mark draws, it
settles, then the thing you are meant to press catches the light.

### 8c · The screen warms as the form fills in

Owner's idea, and a good one — on a five-field sign-up it turns filling in a form into something
with momentum, and it says *"you are nearly there"* without a progress bar or a word of copy. The
colour is doing work rather than decoration.

**Built as a separate layer, not by changing the base alphas.** The gradient colours are computed
in JS, so feeding progress into them would re-render two `LinearGradient`s on **every keystroke**.
As its own layer the whole effect is one opacity on the native driver — no re-render, no JS work
while someone is typing. That constraint is the entire reason for the shape of this.

**Counted in fields, not characters.** A value that moved per keystroke would shimmer, and
"another field done" is the unit that actually means something to the person filling it in.

**Sign-up counts six steps, not five** — the consent checkbox is included. Leaving it out would
let the screen reach full warmth while the Create account button was still disabled, which is the
one thing this mechanic must never say. Full colour and a live button arrive together.

The layer sits *inside* the pulse wrapper, so a completed form still breathes with the rest of
the screen rather than becoming a flat slab. Its stops run deeper than the base pair (0.94 vs
0.84), so completion spreads the warmth down as well as strengthening it. That is past the floor
the base layers respect, and is only acceptable because this layer is at full strength solely
when the form is **complete** — at which point the next thing the user does is press the button,
not read.

Wired on login (2 fields), sign-up (6), and reset-password (2). Verify-email has no form to fill.

**Progress also stills the breathing** (owner, after seeing it: *"don't make the effect fade in
and out after it gets stronger — this may be too overstimulating"*). It reads better than either
state alone: an empty form gets a **restless** screen, a completed one gets **steady, strong,
calm** colour. Motion while there is something to do, none once there is not.

Done as one expression — `pulse + (1 - pulse) * boost` — which lifts the pulse's *troughs* toward
full as progress rises, so the breathing flattens out rather than speeding up or stopping
abruptly. Still one value on the native driver, and no second animation to keep in sync.

### 9 · Sheen on the primary button

Same idea and the same timings as the Listen-mode pill, on request — a 1.4s sweep, then a long
rest. **The rest is the important half:** a highlight crossing continuously would be a
distraction under a password field, while one that crosses briefly reads as a material catching
the light.

It respects **Reduce Motion** (someone who asked the OS to stop animations asked for this too),
and it stops while `loading` is true — during the wait the spinner *is* the message, and a sheen
crossing behind it adds noise at the one moment the button most needs to say a single thing.

Both screens now share `AuthSubmitButton`, so the gradient, sheen, spinner and disabled state
exist once rather than in three copies that would drift within a release.

### 8 · Animated background — built, but not the version asked for

The ask was a background **fading from white into the Laybell gradient**. The intent is right —
that screen is flat — but that execution fights the screen three ways:

- **The app is dark-first.** Starting white and landing in a dark app is a jolt at the exact
  moment a new user is forming their impression.
- **The form is white text on dark inputs.** There is no point along a white → orange sweep where
  white text is legible, so the text and inputs would have to animate too. That is a lot of
  moving parts on the first screen anyone sees.
- **It would run against the logo animation** added in tweak 5. Two motions competing makes both
  read cheaper than either alone.

`components/AuthBackdrop.tsx` keeps the dark ground and puts the brand *into* it: a warm glow
from the top edge, behind the logo, breathing slowly between a gold-led and a red-led mix — the
same colours, the same feeling, and the form stays perfectly legible because the bloom is gone by
72% down, above the inputs on every handset.

**Pace is the whole point: 7.5 seconds a cycle, eased in and out.** Slow enough to be felt rather
than watched, which is the only acceptable speed next to a password field. It also eases in on
mount rather than snapping on.

Cheap: two static gradients and one opacity on the native driver. No layout, no re-render, no
image to decode. Light theme runs at 55% strength — the same alphas on a near-white ground read
as a stain rather than a glow.

**Tuned on device, 2026-08-28.** First pass was 11s at `0.20`/`0.24`; the owner asked for a little
stronger and faster, so it is now **7.5s** at `0.29 / 0.11` gold and `0.34 / 0.12` red. All five
numbers are named constants at the top of `AuthBackdrop.tsx` — this is plainly a dial that gets
turned, not a decision made once, and it was already scattered through the JSX after a single
round of feedback.

The 72% cutoff was left alone on purpose. It is what keeps the form off colour, and raising the
strength is exactly when that guarantee starts to matter.

⚠️ **Do not take the cycle much below ~6s.** That is not taste — the motion has to stay
felt-rather-than-watched next to a password field, which is the entire reason it is slow.

Owner verdict on the whole auth pass: *"everything feels and looks a lot better."*
| 7 | Rest of the app (41 files) | Same keyboard sweep everywhere else | Functional | ⬜ **not started** |

### 6 · Why the keyboard behaved on sign-up but not sign-in

The owner's own observation split this open: *"for the login screen it isn't consistent but the
signup screen works pretty well."* That is exactly right, and the reason is one prop.

**Sign-up** wraps its form in a `ScrollView` with `keyboardShouldPersistTaps="handled"` — which
means a tap on empty space closes the keyboard while a tap a control handles still fires.
**Sign-in had no `ScrollView` at all**, just a plain `View`, so nothing could dismiss anything.
Same for verify-email and reset-password.

All four now share the same recipe:

- `ScrollView` + `keyboardShouldPersistTaps="handled"` — tap-outside closes, buttons still work.
  Without `"handled"` the first tap anywhere is swallowed merely closing the keyboard.
- `Keyboard.dismiss()` on submit, placed **after** the validation guards. Tapping a button should
  close the keyboard, but "fill in all fields" should not — that user has to go straight back
  into a field. It also uncovers the button, which matters now that the spinner keeps running
  (tweak 4): a spinner behind a keyboard communicates nothing.

**Taps only.** `keyboardDismissMode="on-drag"` shipped in the first pass and was removed on the
owner's call: *"for scrolls and drags, I don't want it to exit the keyboard, only on taps."* He is
right — scrolling a form while the keyboard is up is a normal thing to want (checking a field
further down before submitting), and closing the keyboard out from under that is a fight rather
than a help. Dismissal should be something you *did*, not something that happened to you.

Two things worth knowing for the sweep:

- `flexGrow: 1`, **not** `flex: 1`, on a ScrollView's `contentContainerStyle`. `flex: 1` pins
  content to the viewport and silently kills scrolling. `flexGrow` keeps the form centred while
  it fits and lets it scroll when it does not — which is a real second win on a small screen with
  the keyboard up.
- `reset-password.tsx` has **two** blocks using `styles.inner`, and the first is the success
  screen, which has no inputs. A blind find-and-replace converted the wrong one and broke the
  build. **Check for early returns before converting a screen.**

### 7 · The remaining sweep — deliberately not done yet

45 files contain a `TextInput`. Today 33 set `keyboardShouldPersistTaps`, 10 set
`keyboardDismissMode`, and 26 call `Keyboard.dismiss` somewhere — so the app is not unhandled,
it is *inconsistently* handled, which is why it feels random.

Doing all 41 remaining files in one pass is a wide blast radius on screens that cannot be
typechecked into correctness — the reset-password near-miss above happened on file three of four.
Worth doing, worth doing in reviewable batches, and worth the owner spot-checking each batch on
the dev client. Suggested order by how often they are touched: comments → messages → composer →
edit-profile → search surfaces → everything else.

### 4 · The login "hitch" was not a slow network

Worth writing down because the cause was not where it looked.

`handleLogin` never navigates. It signs in, and the root auth listener in `app/_layout.tsx` then
fetches the profile, checks account state (deleted, geo-blocked) and only *then* routes to
`/(tabs)` or `/onboarding`. But `setLoading(false)` ran **unconditionally**, including on success —
so the spinner stopped and the button went back to a normal, idle **Log in** for that whole ~2s
window while the app was still working. It looked like the tap had been ignored. Same bug in
`handleSignup`.

**Fix:** on success the spinner keeps running until the screen unmounts, which is the moment the
work is actually finished. Error paths clear it as before — including the verify-email branch,
which is a `push`, so coming back must not find a dead button.

⚠️ **The old unconditional clear was protecting something real** — two comments in those files
say so explicitly ("can never leave the button stuck disabled"). Not every post-login path
navigates: a geo-blocked or deleted account signs straight back out and lands here again, and an
offline profile fetch can hang. So an 8s safety timer now backs the spinner, cleared on unmount.
The property is kept; only the hitch is gone.

### 5 · The logo draws itself in — and why not as a background

The ask was the brand animation (`#LogoAnimation_03-Vertical.MP4`) looping full-screen behind the
sign-in form. I pulled frames before building it, and the source argues against that use:

- It is a **saturated red-to-orange gradient, edge to edge**. The form is white text over dark
  inputs, so it would need darkening to roughly a quarter brightness to stay readable — paying a
  video's cost to display a dark orange smudge.
- It **ends on the LAYBELL wordmark**, which would land directly behind the "Laybell" wordmark
  the screen already renders. Two wordmarks stacked.
- It ends on the wordmark and **starts on empty gradient**, so looping is a hard cut every 7
  seconds, on the first screen a new user ever sees.

Contained in the logo tile it has none of those problems and keeps all of the motion. The asset is
the **first 3.8s only** — the bell half, before the wordmark cut — square-cropped and stripped of
audio. **35 KB.**

The crop was measured, not eyeballed: the mark's white pixels were bounding-boxed across the whole
draw-in, and the widest moment is the ring lines at ~2.0s (x 273→786). A 640px square centred on
the bell contains that *and* frames the resting mark at ~55% width — within a few percent of how
`assets/icon.png` frames it, so the tile reads as the app icon coming alive.

**It plays once and holds** rather than looping. Its last frame is very nearly `icon.png`, so it
settles into the logo that was always there. Looping would make the mark vanish and redraw every
3.8s beside someone typing a password: a logo that draws itself on arrival reads as craft, one
that keeps redrawing reads as a GIF. `loop = true` in `components/AuthLogoMark.tsx` is the whole
change if that turns out to be wrong.

The still icon renders **underneath** the video at identical size and framing. That is the
fallback, not decoration — if the video fails to decode or is still loading, what is left is
exactly the logo this screen showed before, never a hole.

### 1 · Condensed nav had no floor

Spotted 2026-08-28 in the Stripe review screenshots, on **both** the feed and Explore, so not one
screen's problem. Owner confirmed it looks the same in the app.

**My first read was wrong and worth recording.** I guessed the blur was too weak or not mounting.
It is neither: the bar has two states, and the screenshots caught the second one. At rest it is a
frosted panel; once you scroll, `feedChrome` dissolves that panel and the icons become floating
chips over the feed — deliberate, and the chips themselves are a near-solid wash
(`rgba(9,9,9,0.9)` on iOS dark). Nothing shows through a chip.

What showed through were **the gaps between chips**. With the panel fully gone, raw feed ran right
up to the icons — a post header and a **Follow** button threaded between them on the feed,
"@laybell" and "RAP" on Explore. Busy content in those gaps competes with the icons instead of
sitting behind them.

**Fix:** a dedicated scrim layer that fades in on `chip` — the same gradient as the panel at about
half strength, so the row always has a floor. The rest state is untouched (the two layers are
never both visible), and content still shows through, just knocked back.

It deliberately does **not** ride `panelSink`. The panel sinks 46px as it fades, which is what
sells the detach — but the icons *drop* on that same gesture, so sinking the floor too would
slide it out from under the thing it exists to support.

iOS only. Android already draws its chips on an opaque base, for reasons recorded in
`app/(tabs)/_layout.tsx` (other pager scenes were compositing into the band on a Samsung).

⚠️ **Alpha values are a first guess** — `0 / 0.05 / 0.18 / 0.32 / 0.42`. Look at it on the dev
client and say lighter or heavier; it is one line to tune.

---

## Store screenshots

The pipeline already exists and produced the shipped set.

1. Take fresh phone screenshots — the feed has real content now, so these will look far better
   than the launch set did.
2. Drop them in `store/screenshots/raw/` named `01.png` … `08.png`. Order is the gallery order.
   Any size; the script fits them.
3. Captions are at `scripts/make-screenshots.ps1:53` — edit in place, one per shot.
4. Run it:
   ```
   powershell -ExecutionPolicy Bypass -File scripts/make-screenshots.ps1
   ```

That writes all three store-ready sets: `appstore/` (1320×2868), `play/` (1080×1920), and
`tablet/` (1440×2560), alpha flattened, ready to upload in filename order. A landscape source is
written landscape automatically, keeping its number.

**When you can actually upload them:**

- **Apple** — screenshots are version-specific and cannot be changed on a live version. They go
  up with the 1.0.1 submission and are reviewed alongside it. (The only field editable on a live
  version without review is Promotional Text.)
- **Play** — the store listing updates independently of any release, but **the app is still in
  review right now.** Do not touch the listing until v1 publishes; changing it mid-review is the
  kind of self-inflicted state that already cost four days on Apple.
