# Green screen for React (chroma key) — plan + the one decision

Status: **NOT built.** Deferred on purpose because it needs a native dependency, and
Claude will not add one while the owner is away. This is the ready-to-approve plan.

## Why it can't be pure JS
Green screen = removing the green background from the reactor's video **per pixel, in
real time**, and compositing what's left over the original. That's GPU work (a
fragment shader sampling each video frame). React Native has **no** pure-JS way to do
real-time video chroma key — every workable path is native and needs a rebuild (no OTA
on this project).

## The one decision for the owner
**Approve adding `@shopify/react-native-skia`** (a native module → dev-client + store
rebuild). It's the modern, well-maintained (Shopify) path, config-plugin friendly, and
it also unlocks the deferred **native "bake"** (flattening a reaction to a file) later.

Alternatives considered and rejected:
- **Custom native module** (iOS AVFoundation/Core Image + Android GLSL): more control,
  but a bespoke module to maintain forever. Only worth it if we hit a Skia limit.
- **expo-gl / gl-react**: gl-react is effectively unmaintained; wiring video frames to
  a GL texture in RN is fiddly. Not recommended.

## What ships once Skia is approved (staged, each device-tested)
1. Add `@shopify/react-native-skia` via its Expo config plugin → rebuild the dev client.
2. `components/ChromaKeyVideo` — a Skia node that draws the reactor's video texture
   through an SkSL shader: alpha out pixels near the key colour, with **threshold**,
   **smoothness/feather**, and **spill suppression** (kills the green fringe).
3. New React layout options `green_pip` / `green_pip_flip` / `green_full` alongside the
   existing `pip` / `pip_flip` in the composer + `components/CompositionPlayer`, behind
   a "green screen" toggle. (Matches the note in [[remix-sequencing]]: the current
   pip/pip_flip become the green-screen display options with the effect added.)
4. Key-colour eyedropper (default `#00FF00`) + threshold/smoothness sliders in the
   compose UI.
5. Feed/reel: **badge only**, composes in the post viewer — same idle-loop-safety rule
   the React feature already follows (unattended-video-leak).
6. Later: native bake to a file (Skia offscreen render + encoder) for a flat export.

## Caveats
- Real-time chroma key is GPU-heavy; older devices may need a lower preview resolution
  or a frame cap. Needs device iteration.
- The effect only makes sense when the reactor **filmed against a green backdrop**, so
  the toggle lives at compose time, not on arbitrary posts.

## Effort
Meaningful — on the order of a few days of native work with on-device tuning, not a
JS afternoon. Keep [[unattended-video-leak]] and [[cloudflare-billing]] rules intact
while touching video surfaces.
