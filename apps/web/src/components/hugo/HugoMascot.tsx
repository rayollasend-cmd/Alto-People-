import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { ASSISTANT_PLATFORM_NAME } from '@alto-people/shared';
import { cn } from '@/lib/cn';
import { useMediaQuery } from '@/lib/useViewport';

/**
 * Hugo, the assistant's mascot — a plush 3D character rendered to images
 * (design/hugo has the model and the script that renders these).
 *
 * Two colourways, one per theme: blue with a gold collar on light, gold with
 * a navy collar on dark — each the one that stands out on its background.
 * The Alto lanyard says what he's doing: he wears it at work (working,
 * listening, thinking, reading, handoff, pointing, talking), not off duty
 * (hello, celebrate, coffee); greyed out when offline. His headphones go on
 * at work too, with a boom mic that lights up while he listens or talks;
 * faceWork is the face in them, for a button while he's on a task.
 *
 * Each loop is a moment you'd recognise: he types and nods along, reads
 * three lines and turns the page, lifts his coffee, sips with his eyes shut
 * and sets it down.
 *
 * A still image paints first — sized, so nothing moves — and the motion strip
 * is fetched only once the page is idle, then played as CSS steps over the
 * strip (index.css, .hugo-sprite). Nothing animates, or downloads, for people
 * who ask for reduced motion.
 *
 * Only the platform's own assistant is Hugo: a tenant that renamed its
 * assistant gets its own words and no Alto mascot (isHugo).
 */
export type HugoPose = 'hello' | 'working' | 'listening' | 'thinking' | 'handoff' | 'celebrate' | 'offline' | 'coffee' | 'reading' | 'pointing' | 'talking' | 'face' | 'faceWork';
export type HugoVariant = 'blue' | 'gold';

const POSES: HugoPose[] = ['hello', 'working', 'listening', 'thinking', 'handoff', 'celebrate', 'offline', 'coffee', 'reading', 'pointing', 'talking', 'face', 'faceWork'];

// Every image in both colourways: assets/hugo/<variant>/hugo-<pose>[-loop|-blink].webp.
const FILES = import.meta.glob<string>('../../assets/hugo/*/hugo-*.webp', { eager: true, import: 'default' });
const file = (variant: HugoVariant, name: string): string => FILES[`../../assets/hugo/${variant}/hugo-${name}.webp`];

/** Each pose's motion: a strip of frames, played as a loop or as an occasional blink. */
const MOTION_SPEC: Partial<Record<HugoPose, { name: string; frames: number; kind: 'loop' | 'blink'; seconds: number }>> = {
  hello: { name: 'hello-loop', frames: 16, kind: 'loop', seconds: 1.6 },
  working: { name: 'working-loop', frames: 16, kind: 'loop', seconds: 1.6 },
  listening: { name: 'listening-loop', frames: 16, kind: 'loop', seconds: 2.4 },
  talking: { name: 'talking-loop', frames: 12, kind: 'loop', seconds: 1.2 },
  reading: { name: 'reading-loop', frames: 16, kind: 'loop', seconds: 4 },
  thinking: { name: 'thinking-loop', frames: 12, kind: 'loop', seconds: 2.4 },
  celebrate: { name: 'celebrate-loop', frames: 12, kind: 'loop', seconds: 1.2 },
  handoff: { name: 'handoff-loop', frames: 12, kind: 'loop', seconds: 1.6 },
  offline: { name: 'offline-loop', frames: 10, kind: 'loop', seconds: 3 },
  coffee: { name: 'coffee-loop', frames: 16, kind: 'loop', seconds: 4.8 },
  pointing: { name: 'pointing-loop', frames: 10, kind: 'loop', seconds: 1.4 },
  face: { name: 'face-blink', frames: 2, kind: 'blink', seconds: 5.6 },
  faceWork: { name: 'faceWork-blink', frames: 2, kind: 'blink', seconds: 4.8 },
};

type Motion = { strip: string; frames: number; kind: 'loop' | 'blink'; seconds: number };
const build = (variant: HugoVariant) => ({
  still: Object.fromEntries(POSES.map((p) => [p, file(variant, p)])) as Record<HugoPose, string>,
  motion: Object.fromEntries(
    Object.entries(MOTION_SPEC).map(([p, m]) => [p, { strip: file(variant, m.name), frames: m.frames, kind: m.kind, seconds: m.seconds }]),
  ) as Partial<Record<HugoPose, Motion>>,
});
const ASSETS: Record<HugoVariant, ReturnType<typeof build>> = { blue: build('blue'), gold: build('gold') };

/** The colourway for the theme on <html data-theme>: blue on light, gold on dark (the app's default). */
function readVariant(): HugoVariant {
  if (typeof document === 'undefined') return 'gold';
  return document.documentElement.dataset.theme === 'light' ? 'blue' : 'gold';
}
// Watched on the element itself: the theme provider sets the attribute in its own effect, and
// Hugo also shows outside it (Storybook, tests).
function subscribeTheme(onChange: () => void): () => void {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return () => undefined;
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => mo.disconnect();
}
export function useHugoVariant(): HugoVariant {
  return useSyncExternalStore(subscribeTheme, readVariant, () => 'gold');
}

/** Strips already decoded on this page: a pose switches to one with no flash of the still. */
const decoded = new Set<string>();
function decode(url: string): Promise<void> {
  if (decoded.has(url)) return Promise.resolve();
  const img = new Image();
  img.src = url;
  // decode() where the browser has it (older Safari, jsdom: just the load).
  return (img.decode ? img.decode() : Promise.resolve()).then(() => {
    decoded.add(url);
  });
}

/**
 * Fetch these poses' stills and strips ahead of need — the assistant panel
 * warms the states it is about to show (typing → reading, working, talking).
 * Nothing for people who prefer reduced motion beyond the stills.
 */
export function preloadHugo(poses: HugoPose[]): void {
  if (typeof window === 'undefined') return;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const { still, motion: motions } = ASSETS[readVariant()];
  for (const pose of poses) {
    void decode(still[pose]).catch(() => undefined);
    const motion = motions[pose];
    if (motion && !reduced) void decode(motion.strip).catch(() => undefined);
  }
}

/** Whether the assistant with this name is Hugo (the platform's own), not a tenant's renamed assistant. */
export function isHugo(assistantName: string | null | undefined): boolean {
  return (assistantName ?? ASSISTANT_PLATFORM_NAME) === ASSISTANT_PLATFORM_NAME;
}

interface HugoMascotProps {
  pose: HugoPose;
  /** Rendered size in CSS pixels (square). */
  size: number;
  /** 'loop' keeps moving; a number plays that many times and rests on the first frame; 'still' never moves. */
  play?: 'loop' | number | 'still';
  /** A short celebratory bounce on arrival. */
  bounce?: boolean;
  /** Start the motion now, not when the page goes idle — for the assistant panel, where he is the point. */
  eager?: boolean;
  /** A fixed colourway, for a background that doesn't follow the theme; else the theme's. */
  variant?: HugoVariant;
  className?: string;
}

const whenIdle = (fn: () => void): (() => void) => {
  const w = window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
  if (w.requestIdleCallback) {
    const id = w.requestIdleCallback(fn, { timeout: 2500 });
    return () => w.cancelIdleCallback?.(id);
  }
  const t = window.setTimeout(fn, 600);
  return () => window.clearTimeout(t);
};

export function HugoMascot({ pose, size, play = 'loop', bounce = false, eager = false, variant, className }: HugoMascotProps) {
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const themed = useHugoVariant();
  const assets = ASSETS[variant ?? themed];
  const motion = play === 'still' || reduced ? undefined : assets.motion[pose];
  const [ready, setReady] = useState<string | null>(() => (motion && decoded.has(motion.strip) ? motion.strip : null));

  useEffect(() => {
    if (!motion) return;
    if (decoded.has(motion.strip)) {
      setReady(motion.strip);
      return;
    }
    let live = true;
    const warm = () =>
      decode(motion.strip).then(
        () => live && setReady(motion.strip),
        () => undefined, // stays the still image
      );
    const cancel = eager ? (void warm(), () => undefined) : whenIdle(() => void warm());
    return () => {
      live = false;
      cancel();
    };
  }, [motion, eager]);

  // A strip decoded earlier plays at once — a pose change shows no flash of the still.
  const playing = motion && (ready === motion.strip || decoded.has(motion.strip));
  const style = playing
    ? ({
        '--hugo-end': `-${motion.frames * size}px`,
        '--hugo-blink': `-${size}px`,
        '--hugo-frames': motion.frames,
        '--hugo-seconds': `${motion.seconds}s`,
        '--hugo-iterations': motion.kind === 'blink' || play === 'loop' ? 'infinite' : String(play),
        backgroundImage: `url(${motion.strip})`,
      } as CSSProperties)
    : undefined;

  return (
    <span
      className={cn('relative inline-block shrink-0 select-none', bounce && !reduced && 'hugo-bounce', className)}
      style={{ width: size, height: size }}
      aria-hidden="true"
      data-hugo={pose}
      data-hugo-variant={variant ?? themed}
    >
      <img src={assets.still[pose]} width={size} height={size} alt="" decoding="async" draggable={false} className={cn('h-full w-full', playing && 'invisible')} />
      {playing && <span key={motion.strip} className="hugo-sprite absolute inset-0" data-kind={motion.kind} style={style} />}
    </span>
  );
}
