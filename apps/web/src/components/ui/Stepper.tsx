import { Check } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Horizontal step indicator for multi-step flows (RunPayrollWizard,
 * future onboarding wizards, any "page N of M" pattern).
 *
 * Each step is one of three visual states keyed off its index vs. the
 * current step:
 *   - active  (index === current) — gold tint background + gold pip
 *   - done    (index <  current) — checkmark pip, dimmed silver label
 *   - upcoming(index >  current) — flat silver/30, no chrome
 *
 * Tap-friendly on mobile via the Button-style hit area; passive by
 * default (just a visual indicator). Pass `onStepClick` to make
 * already-completed steps clickable for back-navigation — useful for
 * review screens where the user has filled in every step.
 *
 * Pattern that already shipped lived inline at
 * pages/payroll/RunPayrollWizard.tsx:322-354; promoted here so the
 * next wizard doesn't reinvent it.
 */

interface StepperProps {
  /** 1-indexed current step. */
  current: number;
  steps: ReadonlyArray<{ label: string }>;
  /** When provided, completed steps render as buttons that fire this. */
  onStepClick?: (step: number) => void;
  className?: string;
}

export function Stepper({ current, steps, onStepClick, className }: StepperProps) {
  return (
    <ol
      className={cn('flex items-center justify-between gap-2', className)}
      aria-label="Progress"
    >
      {steps.map((s, i) => {
        const stepNum = i + 1;
        const state: 'active' | 'done' | 'upcoming' =
          stepNum === current ? 'active' : stepNum < current ? 'done' : 'upcoming';
        const interactive = state === 'done' && onStepClick;
        const Body = interactive ? 'button' : 'li';
        const content = (
          <>
            <span
              className={cn(
                'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium tabular-nums',
                state === 'active' && 'bg-gold text-navy',
                state === 'done' && 'bg-silver/20 text-silver',
                state === 'upcoming' && 'bg-silver/10 text-silver/70',
              )}
              aria-hidden="true"
            >
              {state === 'done' ? <Check className="h-3 w-3" /> : stepNum}
            </span>
            <span className="truncate">{s.label}</span>
          </>
        );
        const wrapperClass = cn(
          'flex-1 flex items-center gap-2 px-2 py-1.5 rounded text-xs uppercase tracking-wide',
          state === 'active' && 'bg-gold/15 text-gold border border-gold/30',
          state === 'done' && 'text-silver/70',
          state === 'upcoming' && 'text-silver/30',
          interactive && 'hover:bg-silver/10 transition-colors cursor-pointer',
        );
        if (interactive) {
          // `interactive` only resolves true when state==='done', so no
          // need to wire aria-current here (the active step renders via
          // the <li> branch below).
          return (
            <Body
              key={i}
              type="button"
              onClick={() => onStepClick!(stepNum)}
              className={wrapperClass}
            >
              {content}
            </Body>
          );
        }
        return (
          <li
            key={i}
            className={wrapperClass}
            aria-current={state === 'active' ? 'step' : undefined}
          >
            {content}
          </li>
        );
      })}
    </ol>
  );
}
