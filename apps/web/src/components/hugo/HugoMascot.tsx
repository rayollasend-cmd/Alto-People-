import { useEffect, useState, type CSSProperties } from 'react';
import { ASSISTANT_PLATFORM_NAME } from '@alto-people/shared';
import { cn } from '@/lib/cn';
import { useMediaQuery } from '@/lib/useViewport';
import celebrate from '@/assets/hugo/hugo-celebrate.webp';
import celebrateLoop from '@/assets/hugo/hugo-celebrate-loop.webp';
import coffee from '@/assets/hugo/hugo-coffee.webp';
import coffeeLoop from '@/assets/hugo/hugo-coffee-loop.webp';
import face from '@/assets/hugo/hugo-face.webp';
import faceBlink from '@/assets/hugo/hugo-face-blink.webp';
import handoff from '@/assets/hugo/hugo-handoff.webp';
import handoffBlink from '@/assets/hugo/hugo-handoff-blink.webp';
import hello from '@/assets/hugo/hugo-hello.webp';
import helloLoop from '@/assets/hugo/hugo-hello-loop.webp';
import listening from '@/assets/hugo/hugo-listening.webp';
import listeningBlink from '@/assets/hugo/hugo-listening-blink.webp';
import offline from '@/assets/hugo/hugo-offline.webp';
import offlineLoop from '@/assets/hugo/hugo-offline-loop.webp';
import pointing from '@/assets/hugo/hugo-pointing.webp';
import pointingLoop from '@/assets/hugo/hugo-pointing-loop.webp';
import reading from '@/assets/hugo/hugo-reading.webp';
import readingBlink from '@/assets/hugo/hugo-reading-blink.webp';
import thinking from '@/assets/hugo/hugo-thinking.webp';
import thinkingLoop from '@/assets/hugo/hugo-thinking-loop.webp';
import working from '@/assets/hugo/hugo-working.webp';
import workingLoop from '@/assets/hugo/hugo-working-loop.webp';

/**
 * Hugo, the assistant's mascot — a 3D character rendered to images
 * (design/hugo has the model and the script that renders these).
 *
 * His headphones say what he's doing: around his neck when he isn't working
 * (hello, celebrate, coffee), on his ears when he is (working, listening,
 * thinking, reading, handoff, pointing), greyed out when offline.
 *
 * A still image paints first — sized, so nothing moves — and the motion strip
 * is fetched only once the page is idle, then played as CSS steps over the
 * strip (index.css, .hugo-sprite). Nothing animates, or downloads, for people
 * who ask for reduced motion.
 *
 * Only the platform's own assistant is Hugo: a tenant that renamed its
 * assistant gets its own words and no Alto mascot (isHugo).
 */
export type HugoPose = 'hello' | 'working' | 'listening' | 'thinking' | 'handoff' | 'celebrate' | 'offline' | 'coffee' | 'reading' | 'pointing' | 'face';

const STILL: Record<HugoPose, string> = { hello, working, listening, thinking, handoff, celebrate, offline, coffee, reading, pointing, face };

/** Each pose's motion: a strip of frames, played as a loop or as an occasional blink. */
const MOTION: Partial<Record<HugoPose, { strip: string; frames: number; kind: 'loop' | 'blink'; seconds: number }>> = {
  hello: { strip: helloLoop, frames: 12, kind: 'loop', seconds: 1.1 },
  working: { strip: workingLoop, frames: 8, kind: 'loop', seconds: 0.9 },
  thinking: { strip: thinkingLoop, frames: 8, kind: 'loop', seconds: 1.6 },
  celebrate: { strip: celebrateLoop, frames: 8, kind: 'loop', seconds: 1 },
  offline: { strip: offlineLoop, frames: 8, kind: 'loop', seconds: 2.4 },
  coffee: { strip: coffeeLoop, frames: 6, kind: 'loop', seconds: 1.5 },
  pointing: { strip: pointingLoop, frames: 8, kind: 'loop', seconds: 1.2 },
  listening: { strip: listeningBlink, frames: 2, kind: 'blink', seconds: 4.6 },
  reading: { strip: readingBlink, frames: 2, kind: 'blink', seconds: 5.2 },
  handoff: { strip: handoffBlink, frames: 2, kind: 'blink', seconds: 4.8 },
  face: { strip: faceBlink, frames: 2, kind: 'blink', seconds: 5.6 },
};

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

export function HugoMascot({ pose, size, play = 'loop', bounce = false, className }: HugoMascotProps) {
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const motion = play === 'still' || reduced ? undefined : MOTION[pose];
  const [ready, setReady] = useState<string | null>(null);

  useEffect(() => {
    if (!motion) return;
    let live = true;
    const cancel = whenIdle(() => {
      const img = new Image();
      img.src = motion.strip;
      // decode() where the browser has it (older Safari, jsdom: just the load).
      (img.decode ? img.decode() : Promise.resolve()).then(
        () => live && setReady(motion.strip),
        () => undefined, // stays the still image
      );
    });
    return () => {
      live = false;
      cancel();
    };
  }, [motion]);

  const playing = motion && ready === motion.strip;
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
    >
      <img src={STILL[pose]} width={size} height={size} alt="" decoding="async" draggable={false} className={cn('h-full w-full', playing && 'invisible')} />
      {playing && <span className="hugo-sprite absolute inset-0" data-kind={motion.kind} style={style} />}
    </span>
  );
}
