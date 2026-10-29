import { Link } from 'react-router-dom';
import type { ExecClients, ExecStatus } from '@alto-people/shared';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryError } from '@/components/ui/QueryError';
import { cn } from '@/lib/cn';
import { execHref, useExecClients, type ExecFrame } from '@/lib/executiveApi';
import { fmtExecExact, fmtExecMoney } from '@/lib/executiveFormat';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { Preview, PreviewBody } from './PreviewParts';
import { healthStatus } from './util';

/**
 * The client portfolio, in one look (2026-10-27): how much of the billing
 * rides on each of the largest clients — one bar each, with a mark at the
 * share past which one client is a concentration risk — and, on the same
 * row, what each bills, the margin it earns and how healthy the account is.
 */
const TOP = 5;

/** The account's health word as a chip from the palette's scales: Good · Watch · At risk. */
const HEALTH_CHIP: Record<ExecStatus, { variant: 'success' | 'pending' | 'destructive' | 'default'; className?: string }> = {
  good: { variant: 'success' },
  watch: { variant: 'pending' },
  bad: { variant: 'destructive' },
  none: { variant: 'default', className: 'border-neutral-200 bg-neutral-100 text-neutral-800' },
};

export function ClientsPreview({ frame }: { frame: ExecFrame }) {
  const { t } = useI18n();
  const q = useExecClients(frame);
  const d = q.data;
  return (
    <Preview
      id="exec-home-clients"
      title={t('execPortal.home.clients.title')}
      answer={d ? clientsAnswer(d, t) : undefined}
      open={{ to: execHref('/executive/clients', frame), label: t('execPortal.home.clients.open') }}
      testId="exec-preview-clients"
    >
      {!d ? q.isError ? <QueryError what={t('execPortal.home.clients.what')} query={q} /> : <PreviewBody height={300} /> : <ClientsBody d={d} frame={frame} />}
    </Preview>
  );
}

type T = ReturnType<typeof useI18n>['t'];

function clientsAnswer(d: ExecClients, t: T): string {
  const { topClientName, topSharePct, thresholdPct } = d.concentration;
  if (!topClientName || d.clients.length === 0) return t('execPortal.home.clients.answerNone');
  const pct = `${topSharePct.toFixed(1)}%`;
  return topSharePct >= thresholdPct
    ? t('execPortal.home.clients.answerOver', { name: topClientName, pct, threshold: `${Math.round(thresholdPct)}%` })
    : t('execPortal.home.clients.answerUnder', { name: topClientName, pct });
}

function ClientsBody({ d, frame }: { d: ExecClients; frame: ExecFrame }) {
  const { t } = useI18n();
  const rows = [...d.clients].sort((a, b) => b.billed - a.billed).slice(0, TOP);
  const threshold = d.concentration.thresholdPct;
  const more = d.clients.length - rows.length;
  if (rows.length === 0) {
    return (
      <Card animate={false} className="p-4">
        <EmptyState size="sm" title={t('execPortal.home.clients.empty')} description={t('execPortal.home.clients.emptyBody')} />
      </Card>
    );
  }
  return (
    <Card animate={false} className="min-w-0 overflow-hidden">
      <table className="w-full table-fixed text-sm" data-testid="exec-clients-table">
        <caption className="sr-only">{t('execPortal.home.clients.caption')}</caption>
        <thead>
          <tr className="border-b border-line-subtle text-left text-2xs font-semibold uppercase tracking-[0.12em] text-ink-muted">
            <th scope="col" className="px-4 py-2 font-semibold">{t('execPortal.home.clients.colClient')}</th>
            <th scope="col" className="w-[5.75rem] px-2 py-2 text-right font-semibold sm:w-24">{t('execPortal.home.clients.colBilled')}</th>
            {/* On a phone the margin rides under the billed figure, so the client's name keeps its room. */}
            <th scope="col" className="hidden w-20 px-2 py-2 text-right font-semibold sm:table-cell">{t('execPortal.home.clients.colMargin')}</th>
            <th scope="col" className="w-[5rem] py-2 pl-2 pr-3 font-semibold sm:w-24 sm:pr-4">
              {t('execPortal.home.clients.colHealth')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-subtle">
          {rows.map((c) => {
            const over = c.sharePct >= threshold;
            const status = healthStatus(c.health, c.healthLabel);
            const share = `${c.sharePct.toFixed(1)}%`;
            return (
              <tr key={c.clientId} data-testid="exec-client-row">
                <td className="px-4 py-2.5 align-top">
                  <div className="flex items-baseline justify-between gap-2">
                    <Link to={execHref(c.href, frame)} className="min-w-0 truncate rounded text-ink hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent coarse:-my-3 coarse:py-3">
                      {c.name}
                    </Link>
                    <span className={cn('shrink-0 text-xs2 tabular-nums', over ? 'font-medium text-caution-800' : 'text-ink-muted')}>{share}</span>
                  </div>
                  <div
                    role="img"
                    aria-label={t('execPortal.home.clients.shareAria', { name: c.name, pct: share, threshold: `${Math.round(threshold)}%` })}
                    className="relative mt-1.5 h-1.5 w-full rounded-full bg-neutral-100"
                  >
                    <div className={cn('absolute inset-y-0 left-0 rounded-full', over ? 'bg-caution-700' : 'bg-neutral-600')} style={{ width: `${Math.max(0, Math.min(100, c.sharePct))}%` }} />
                    <div className="absolute -inset-y-1 w-0.5 rounded-full bg-ink" style={{ left: `calc(${Math.max(0, Math.min(100, threshold))}% - 1px)` }} aria-hidden="true" />
                  </div>
                </td>
                <td className="px-2 py-2.5 text-right align-top tabular-nums text-ink" title={fmtExecExact(c.billed, 'money')}>
                  {fmtExecMoney(c.billed)}
                  {c.marginPct !== null && <div className="whitespace-nowrap text-xs2 text-ink-muted sm:hidden">{t('execPortal.home.clients.marginShort', { pct: `${c.marginPct.toFixed(1)}%` })}</div>}
                </td>
                <td className="hidden px-2 py-2.5 text-right align-top tabular-nums text-ink-muted sm:table-cell">{c.marginPct === null ? '—' : `${c.marginPct.toFixed(1)}%`}</td>
                <td className="py-2.5 pl-2 pr-3 align-top sm:pr-4">
                  {c.healthLabel ? (
                    <Badge size="sm" variant={HEALTH_CHIP[status].variant} className={HEALTH_CHIP[status].className} data-testid="exec-client-health">
                      {c.healthLabel}
                    </Badge>
                  ) : (
                    <span className="text-ink-muted">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="border-t border-line-subtle px-4 py-2 text-xs2 text-ink-muted">
        {t('execPortal.home.clients.thresholdNote', { threshold: `${Math.round(threshold)}%` })}
        {more > 0 && <> · {t('execPortal.home.clients.more', { count: more })}</>}
      </p>
    </Card>
  );
}
