import { useEffect, useLayoutEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { seenKey, stepCopy, tourFor, type Tour } from '@/lib/tours';
import { Button } from '@/components/ui/Button';

/**
 * Coach marks without a library: a ring around the anchored element and
 * a card beside it, stepped with Next/Back, remembered per person once
 * finished or skipped. Positions are measured, not guessed, and
 * re-measured on resize; if an anchor is missing the whole tour stays
 * quiet rather than pointing at nothing.
 *
 * Reduced motion is respected by the fade class already flattened in
 * index.css; the card is a dialog for the screen reader.
 */

const CARD_W = 300;
const GAP = 12;
/** How long after a route renders before the anchors are measured. */
let armDelayMs = 900;
/** Test-only: no shell to wait for in jsdom. */
export function setCoachmarksArmDelayForTests(ms: number): void {
  armDelayMs = ms;
}

function rectOf(anchor: string): DOMRect | null {
  const el = document.querySelector<HTMLElement>(`[data-tour="${anchor}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width === 0 && r.height === 0 ? null : r;
}

function everyAnchorPresent(tour: Tour): boolean {
  return tour.steps.every((s) => rectOf(s.anchor) !== null);
}

export function Coachmarks() {
  const { user } = useAuth();
  const { lang, t } = useI18n();
  const location = useLocation();
  const [tour, setTour] = useState<Tour | null>(null);
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  // "Show the tour again" from the help sheet, on the route already open.
  const [replay, setReplay] = useState(0);
  useEffect(() => {
    const bump = () => setReplay((n) => n + 1);
    window.addEventListener('alto:tour-replay', bump);
    return () => window.removeEventListener('alto:tour-replay', bump);
  }, []);

  // Arm a tour the first time its route renders for this person. A short
  // delay lets the shell paint (and the anchors exist) before measuring.
  useEffect(() => {
    void replay;
    if (!user) return;
    const candidate = tourFor(location.pathname);
    if (!candidate) return;
    let seen: boolean;
    try {
      seen = window.localStorage.getItem(seenKey(candidate.id, user.id)) !== null;
    } catch {
      seen = true; // no storage → we could never remember, so never nag
    }
    if (seen) return;
    const timer = window.setTimeout(() => {
      if (everyAnchorPresent(candidate)) {
        setTour(candidate);
        setStep(0);
      }
    }, armDelayMs);
    return () => window.clearTimeout(timer);
  }, [location.pathname, user, replay]);

  // Measure the current anchor, and again whenever the window changes.
  useLayoutEffect(() => {
    if (!tour) return;
    const measure = () => setRect(rectOf(tour.steps[step]!.anchor));
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [tour, step]);

  if (!tour || !rect || !user) return null;

  const finish = () => {
    try {
      window.localStorage.setItem(seenKey(tour.id, user.id), new Date().toISOString());
    } catch {
      /* best-effort */
    }
    setTour(null);
  };

  const current = stepCopy(tour.steps[step]!, lang);
  const last = step === tour.steps.length - 1;
  // Card below the anchor when there is room, otherwise above; never off
  // the right edge.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const below = rect.bottom + GAP + 160 < vh;
  const left = Math.max(8, Math.min(rect.left, vw - CARD_W - 8));
  const top = below ? rect.bottom + GAP : undefined;
  const bottom = below ? undefined : vh - rect.top + GAP;

  return (
    <>
      <div
        aria-hidden="true"
        className="pointer-events-none fixed z-[60] rounded-lg ring-2 ring-gold ring-offset-2 ring-offset-navy animate-fade-in"
        style={{ top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8 }}
      />
      <div
        role="dialog"
        aria-modal="false"
        aria-label={current.title}
        className="fixed z-[61] rounded-lg border border-gold/40 bg-navy p-4 elev-2 animate-fade-in"
        style={{ left, top, bottom, width: Math.min(CARD_W, vw - 16) }}
      >
        <div className="text-2xs uppercase tracking-widest text-gold">
          {step + 1} / {tour.steps.length}
        </div>
        <div className="mt-1 text-sm font-medium text-white">{current.title}</div>
        <p className="mt-1 text-sm text-silver">{current.body}</p>
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={finish}>
            {t('tour.skip')}
          </Button>
          <div className="ml-auto flex gap-2">
            {step > 0 && (
              <Button size="sm" variant="outline" onClick={() => setStep((s) => s - 1)}>
                {t('tour.back')}
              </Button>
            )}
            <Button size="sm" onClick={() => (last ? finish() : setStep((s) => s + 1))}>
              {last ? t('tour.done') : t('tour.next')}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
