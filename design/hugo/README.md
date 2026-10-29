# Hugo, the mascot

Hugo is the assistant's character: a plush toy with a furry hood, a cream
face, glossy bead eyes, rosy cheeks, a fluffy collar and stubby arms and legs.
The owner's reference images are in `sources/` (`hugo-blue.png`,
`hugo-gold.png`).

**Two colourways, one per theme** (2026-10-28):

| Colourway | Theme | Fur | Collar | Ears |
| --- | --- | --- | --- | --- |
| `blue` | light | `#1f63b3` | gold `#e9a81f` | two round ears |
| `gold` | dark | `#dea526` | navy `#1f4780` | none, a round hood |

Each stands out on the background it's made for. The colours are sampled from
the reference images.

**The Alto lanyard means he's at work:** a navy strap, a clip, and a white
card with the Alto mark. It replaces the old headphones.

- **Off duty:** no lanyard. Poses: `hello` (waving), `celebrate`, `coffee`.
- **At work:** lanyard on. Poses: `working` (typing at a laptop with the Alto
  logo on the lid), `listening` (a hand to his ear, sound coming in),
  `thinking`, `reading`, `pointing`, `handoff` (passing you to a person),
  `talking`.
- **Offline:** greyed out, asleep (`offline`).
- `face`: the close-up for buttons and avatars.

The Figma file has every concept and board: [Alto People — Agents](https://www.figma.com/design/ORAbiUtCOGvrPOKrKzFsAr)
(page "Hugo — mascot concepts").

## In the app

`apps/web/src/components/hugo/HugoMascot.tsx` renders him:

```tsx
<HugoMascot pose="hello" size={56} play={2} />
<HugoMascot pose="face" size={26} variant="gold" />   // a fixed colourway, for a background that doesn't follow the theme
```

- The colourway follows `<html data-theme>`: blue on light, gold on dark (`useHugoVariant`).

- The still image paints first, at its size, so nothing moves.
- The animation strip loads only once the page is idle.
- People who prefer reduced motion see the still and never download the strip.

He appears only where the assistant is still called Hugo (`isHugo`). A tenant
that renamed its assistant keeps the plain icon, so a white-labelled tenant
never shows Alto's mascot or logo.

Where he is today:

| Place | Pose and size |
| --- | --- |
| Top-bar button (md and up) | `face` 26 |
| Phone launcher, above the tab bar | `face` 44 |
| Assistant panel header | his live state, 52 |
| Assistant panel, empty state | `hello`, then his live state, 128 |
| Next to each of his answers | `face` 28 |
| Home card (HugoSeat) | `hello` 56 |
| Birthday and anniversary banner | `celebrate` 56, with a bounce |

### In the panel he acts out what he is doing

`AssistantPane` maps the agent's state to a pose and a status line. All of
them are loops at 240 px frames, preloaded as the panel opens or as you start
typing.

| State | Pose | Status line |
| --- | --- | --- |
| Panel open, idle | `listening` (lanyard on, a hand to his ear, sound coming in, a sway, a blink) | Ready when you are |
| You type, or the cursor is in the box | `listening` | Listening… |
| You tap the microphone | `listening` | I'm listening — go ahead |
| The question is out, first 1.5 s | `reading` (his eyes scan the page) | Reading your records… |
| Still working, or a confirmed action is running | `working` (typing at his laptop) | Working on it… |
| The answer lands | `talking` | Here's what I found |
| Reading the answer aloud | `talking` | Reading it out loud |
| An action is done, or the hand-off was sent | `celebrate` | Done — all set |
| A hand-off is offered | `handoff` | Ready to pass this to a person |
| A minute with no activity | `coffee` (off duty, no lanyard, sipping) | On a coffee break — ask me anything |
| No connection | `offline` | Reconnecting… |

## Changing him

Everything is generated from `hugo.js`, a Three.js scene (`?v=blue|gold`
picks the colourway). He's built from soft shapes: ellipsoids for the head and
belly, a torus for the collar, capsules for the legs, and tubes for the arms.
The fur is **shell texturing**: each furry part is drawn again in thin shells
pushed out along its normals, and each shell keeps only the strands that reach
it. That makes the edges go soft, as in the reference images. All the shells
share one shader program. The lanyard card and the laptop lid carry the Alto
logo emblem, drawn from `apps/web/public/favicon.svg`. Three.js loads from
jsDelivr, so the repository has no new dependency.

```sh
node design/hugo/render.mjs hello,working 1024        # transparent PNGs, both colourways → design/hugo/renders/<pose>-<v>.png (git-ignored)
node design/hugo/render.mjs working 1024 gold glb     # one colourway, plus a .glb 3D file for a 3D artist (Blender, Spline)
node design/hugo/assets.mjs                           # the app's assets → apps/web/src/assets/hugo/{blue,gold}/ (+ exports/hugo-whatsapp.jpg)
node design/hugo/assets.mjs --stills blue             # a quick look: one colourway's stills only
```

`assets.mjs` writes four kinds of file, in each colourway's folder:

- **Stills:** 256 px, about 7 KB each.
- **The face:** 128 px, about 4 KB.
- **Animation loops:** 240 px frames, 33–59 KB each, one per pose (blinks built in).
- **A blink pair** for the face.

Each frame is a cold render in headless Chromium (SwiftShader), about 2–3 s
each, so a full run of both colourways takes about ten minutes.

`2d/hugo-v2.mjs` is the flat SVG version of the first (vinyl) Hugo. The vinyl
model itself is in git history before 2026-10-28.

## WhatsApp

`exports/hugo-whatsapp.jpg` (640 × 640, the gold Hugo waving on navy) is the profile
photo for the WhatsApp Business number. WhatsApp crops it to a circle. Set it
in Meta's WhatsApp Manager, under the phone number's profile. Changing it is
visible to everyone who messages the number, so it's the owner's call.
