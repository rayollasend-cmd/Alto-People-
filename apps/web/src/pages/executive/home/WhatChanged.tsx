import { Link } from 'react-router-dom';
import type { ExecChange } from '@alto-people/shared';
import { AlertTriangle, Check, ChevronRight, Minus } from '@/components/ui/icons';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { ExecSection } from '@/components/executive/ExecPage';
import { cn } from '@/lib/cn';
import { execHref, type ExecFrame } from '@/lib/executiveApi';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';

/**
 * What changed (2026-10-27): the overview's three to five sentences, the
 * biggest move first, each with its number and its way in. The sentence
 * says which way the number went; the mark beside it says whether that is
 * good news (a tick) or needs a look (a warning) — by its shape as well as
 * its colour, so "overtime fell" never wears an arrow pointing up.
 */
const TONE = {
  good: { Icon: Check, chip: 'bg-positive-100 text-positive-800 border-positive-200' },
  bad: { Icon: AlertTriangle, chip: 'bg-negative-100 text-negative-800 border-negative-200' },
  neutral: { Icon: Minus, chip: 'bg-neutral-100 text-ink-muted border-neutral-200' },
} as const;

const ROW = 'flex items-start gap-3 px-4 py-3 coarse:min-h-11';

export function WhatChanged({ changes, loading, frame }: { changes: ExecChange[] | undefined; loading: boolean; frame: ExecFrame }) {
  const { t } = useI18n();
  return (
    <ExecSection id="exec-home-changes" title={t('execPortal.home.changesTitle')} description={t('execPortal.home.changesDescription')}>
      <Card className="overflow-hidden" animate={false}>
        {!changes ? (
          loading ? (
            <div className="p-4">
              <SkeletonRows count={4} rowHeight="h-9" />
            </div>
          ) : (
            <div className="p-4">
              <EmptyState size="sm" title={t('execPortal.home.changesUnavailable')} />
            </div>
          )
        ) : changes.length === 0 ? (
          <div className="p-4">
            <EmptyState size="sm" title={t('execPortal.home.changesEmpty')} description={t('execPortal.home.changesEmptyBody')} />
          </div>
        ) : (
          <ul role="list" className="divide-y divide-line-subtle" data-testid="exec-changes">
            {changes.map((c) => {
              const tone = TONE[c.tone] ?? TONE.neutral;
              const icon = (
                <span className={cn('mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border', tone.chip)} aria-hidden="true">
                  <tone.Icon className="h-3.5 w-3.5" />
                </span>
              );
              return (
                <li key={c.id}>
                  {c.href ? (
                    <Link
                      to={execHref(c.href, frame)}
                      className={cn(ROW, 'group transition-colors hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent')}
                    >
                      {icon}
                      <span className="min-w-0 flex-1 text-sm leading-snug text-ink">{c.text}</span>
                      <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-ink-subtle group-hover:text-ink-muted" aria-hidden="true" />
                    </Link>
                  ) : (
                    <div className={ROW}>
                      {icon}
                      <span className="min-w-0 flex-1 text-sm leading-snug text-ink">{c.text}</span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </ExecSection>
  );
}
