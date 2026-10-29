import type { UseQueryResult } from '@tanstack/react-query';
import type { ExecOverview } from '@alto-people/shared';
import { ArrowRight, Target } from '@/components/ui/icons';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { KpiCard } from '@/components/executive/KpiCard';
import { cn } from '@/lib/cn';
import { execHref, type ExecFrame } from '@/lib/executiveApi';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { quarterWords } from './util';

/**
 * The scorecard (2026-10-27): the eight measures the board reads, each
 * against the chosen comparison and the plan. Four across on a desktop
 * (two rows — the whole of it inside the first screen), two across on a
 * tablet, and on a phone a sideways carousel two cards tall, with the next
 * column peeking in, so all eight sit in one screen height instead of a
 * page of scrolling. Each card is a link, so the carousel is reachable
 * by Tab as well as by swipe.
 */
const GRID = cn(
  // Phone: a two-row carousel, column by column, snapping to each column.
  'grid grid-flow-col grid-rows-2 auto-cols-[84%] gap-3 overflow-x-auto snap-x snap-mandatory scrollbar-none',
  // Room for a card's focus ring inside the scroller.
  '-m-1 p-1',
  // Tablet and up: a plain grid.
  'sm:m-0 sm:grid-flow-row sm:grid-rows-none sm:auto-cols-auto sm:grid-cols-2 sm:overflow-visible sm:p-0 lg:grid-cols-4',
);

export function Scorecard({ overview, frame }: { overview: UseQueryResult<ExecOverview>; frame: ExecFrame }) {
  const { t } = useI18n();
  const data = overview.data;
  if (!data) {
    if (overview.isError) return <QueryError what={t('execPortal.home.scorecardWhat')} query={overview} />;
    return (
      <ul role="list" aria-label={t('execPortal.home.scorecardAria')} aria-busy="true" className={GRID} data-testid="exec-scorecard-loading">
        {Array.from({ length: 8 }, (_, i) => (
          <li key={i} className="min-w-0 snap-start">
            <Skeleton className="h-[172px] rounded-lg" />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul role="list" aria-label={t('execPortal.home.scorecardAria')} className={GRID} data-testid="exec-scorecard">
      {data.scorecard.map((kpi) => (
        <li key={kpi.id} className="flex min-w-0 snap-start">
          <KpiCard kpi={kpi} comparisonLabel={data.comparison.label} href={execHref(kpi.href, frame)} className="w-full" />
        </li>
      ))}
    </ul>
  );
}

/**
 * No plan for the quarter: one calm line above the cards, not an empty
 * card — the measures still read against the period compared with, and
 * the person who can set the plan is one tap from doing it.
 */
export function PlanPrompt({ quarter, canSet, onSet }: { quarter: string; canSet: boolean; onSet: () => void }) {
  const { t } = useI18n();
  const q = quarterWords(quarter).short;
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-line-subtle bg-surface px-3 py-2.5 text-sm text-ink-muted sm:flex-row sm:items-center sm:justify-between"
      data-testid="exec-plan-prompt"
    >
      <p className="flex items-start gap-2">
        <Target className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
        <span>{canSet ? t('execPortal.home.planMissing', { quarter: q }) : t('execPortal.home.planMissingReadOnly', { quarter: q })}</span>
      </p>
      {canSet && (
        <button
          type="button"
          onClick={onSet}
          className="inline-flex shrink-0 items-center gap-1 self-start rounded text-sm font-medium text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent coarse:min-h-11 sm:self-auto"
        >
          {t('execPortal.setPlan')}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
