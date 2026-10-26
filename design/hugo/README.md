# Hugo, the mascot

Hugo is the assistant's character: a navy vinyl toy with the Alto compass star
for a tuft, mitten hands, and headphones that say what he is doing.

- **Not working:** headphones around his neck. Poses: `hello` (waving),
  `celebrate`, `coffee`.
- **Working:** headphones on his ears. Poses: `working` (typing at a laptop
  with the Alto logo on the lid), `listening` (mic lit), `thinking`, `reading`,
  `pointing`, `handoff` (passing you to a person).
- **Offline:** greyed out, asleep (`offline`).
- `talking`: answering, mouth moving, a hand gesturing.
- `face`: the close-up for buttons and avatars.

The Figma file has every concept and board: [Alto People — Agents](https://www.figma.com/design/ORAbiUtCOGvrPOKrKzFsAr)
(page "Hugo — mascot concepts").

## In the app

`apps/web/src/components/hugo/HugoMascot.tsx` renders him:

```tsx
<HugoMascot pose="hello" size={56} play={2} />
```

- The still image paints first, at its size, so nothing moves.
- The animation strip loads only once the page is idle.
- People who prefer reduced motion see the still and never download the strip.

He appears only where the assistant is still called Hugo (`isHugo`). A tenant
that renamed its assistant keeps the plain icon, so a white-labelled tenant
never shows Alto's mascot or logo.

Where he is today:

| Place | Pose and size |
| --- | --- |
| Top-bar button, on a gold disc (md and up) | `face` 24 |
| Phone launcher, above the tab bar | `face` 42, on a gold disc |
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
| Panel open, idle | `listening` (headphones on, mic glowing, a sway, a blink) | Ready when you are |
| You type, or the cursor is in the box | `listening` | Listening… |
| You tap the microphone | `listening` | I'm listening — go ahead |
| The question is out, first 1.5 s | `reading` (his eyes scan the page) | Reading your records… |
| Still working, or a confirmed action is running | `working` (typing at his laptop) | Working on it… |
| The answer lands | `talking` | Here's what I found |
| Reading the answer aloud | `talking` | Reading it out loud |
| An action is done, or the hand-off was sent | `celebrate` | Done — all set |
| A hand-off is offered | `handoff` | Ready to pass this to a person |
| A minute with no activity | `coffee` (headphones down, sipping) | On a coffee break — ask me anything |
| No connection | `offline` | Reconnecting… |

## Changing him

Everything is generated from `hugo.js`, a Three.js scene. It turns the body
from his 2D outline and builds the rest from shapes: the extruded star, the
headphones, tube arms, the laptop, and the Alto logo emblem drawn from
`apps/web/public/favicon.svg`. Three.js loads from jsDelivr, so the repository
has no new dependency.

```sh
node design/hugo/render.mjs hello,working 1024        # transparent PNGs → design/hugo/renders/ (git-ignored)
node design/hugo/render.mjs working 1024 glb          # …plus a .glb 3D file for a 3D artist (Blender, Spline)
node design/hugo/assets.mjs                           # the app's assets → apps/web/src/assets/hugo (+ exports/hugo-whatsapp.jpg)
```

`assets.mjs` writes four kinds of file:

- **Stills:** 256 px, about 7 KB each.
- **The face:** 128 px, about 4 KB.
- **Animation loops:** 240 px frames, 33–59 KB each, one per pose (blinks built in).
- **A blink pair** for the face.

Each frame is a cold render in headless Chromium (SwiftShader), so a full run
takes about three minutes.

`2d/hugo-v2.mjs` is the flat SVG version the 3D model grew from.

## WhatsApp

`exports/hugo-whatsapp.jpg` (640 × 640, Hugo waving on navy) is the profile
photo for the WhatsApp Business number. WhatsApp crops it to a circle. Set it
in Meta's WhatsApp Manager, under the phone number's profile. Changing it is
visible to everyone who messages the number, so it's the owner's call.
