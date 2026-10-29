import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Banknote, FileText, HeartPulse, Landmark, PiggyBank, Receipt, Scale } from '@/components/ui/icons';
import { apiFetch } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { fmtCount, fmtDate, fmtMoney } from '@/lib/format';
import { useUrlParam } from '@/lib/useUrlState';
import { cn } from '@/lib/cn';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { FilterChip } from '@/components/ui/FilterBar';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { QueryError } from '@/components/ui/QueryError';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { CashFlowChart, cashRows } from './financeCharts';
import type { CashForecast, CashLine, CashWeek } from './financeTypes';
import '@/lib/i18n/en/fin';

/**
 * The cash forecast, every line: where the cash stands today (the Books
 * balance), payroll, deposits, retirement plan contributions, benefit
 * carrier premiums and vendor bills going out, statements coming
 * in on their terms — week by week with the projected balance, the low
 * point marked, and the cash floor from Settings shaded. A payday is never
 * dropped: with nobody on the schedule it shows at the last run's net,
 * flagged as an estimate.
 */

const KIND_ICON: Record<CashLine['kind'], typeof Banknote> = {
  PAYROLL: Banknote,
  TAX_DEPOSIT: Landmark,
  GARNISHMENT: Scale,
  RECEIVABLE: Receipt,
  BILL: FileText,
  RETIREMENT: PiggyBank,
  BENEFITS: HeartPulse,
};

const KIND_LABEL: Record<CashLine['kind'], string> = {
  PAYROLL: 'Payroll',
  TAX_DEPOSIT: 'Tax deposit',
  GARNISHMENT: 'Garnishment remittance',
  RECEIVABLE: 'Client payment',
  BILL: 'Vendor bill',
  RETIREMENT: 'Retirement plan',
  BENEFITS: 'Benefit carrier',
};

const CONFIDENCE_LABEL: Record<CashLine['confidence'], string> = {
  scheduled: 'Scheduled',
  estimated: 'Estimated',
  overdue: 'Past due',
};

type Horizon = '4' | '8' | '13';
type KindFilter = 'all' | 'in' | CashLine['kind'];
const KINDS = Object.keys(KIND_LABEL) as Array<CashLine['kind']>;

/**
 * The lines in weeks counted from the forecast's first day (the same weeks
 * as the chart), each week once, in date order. Past-due lines are dated
 * today by the API, so they sit in the first week.
 */
export function weekGroups(from: string, lines: CashLine[]): Array<{ weekStart: string; lines: CashLine[] }> {
  const start = Date.parse(`${from}T00:00:00Z`);
  const groups = new Map<string, CashLine[]>();
  for (const l of lines) {
    const days = Math.max(0, Math.floor((Date.parse(`${l.date}T00:00:00Z`) - start) / 86_400_000));
    // eslint-disable-next-line no-restricted-syntax -- UTC on purpose: day arithmetic on YYYY-MM-DD keys anchored at UTC midnight, never a clock time.
    const ws = new Date(start + Math.floor(days / 7) * 7 * 86_400_000).toISOString().slice(0, 10);
    groups.set(ws, [...(groups.get(ws) ?? []), l]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([weekStart, ls]) => ({ weekStart, lines: ls }));
}

export function CashForecastPage() {
  const { t } = useI18n();
  // The horizon and the kind filter are in the URL, so a link is this view.
  const [weeks, setWeeks] = useUrlParam<Horizon>('weeks', '4', ['4', '8', '13']);
  const [kind, setKind] = useUrlParam<KindFilter>('kind', 'all', ['all', 'in', ...KINDS]);
  const q = useQuery({
    queryKey: ['finance', 'cash-forecast', weeks],
    queryFn: () => apiFetch<CashForecast>(`/finance/cash-forecast?weeks=${weeks}`),
  });
  const data = q.data;
  // A balance is only a balance when the books hold one. Bank accounts with
  // nothing posted read "Cash today $0.00" and drew a "low point" below
  // zero from it — then this page shows the net movement instead.
  const booked = !!data?.opening && data.opening.onFile !== false;
  const notPosted = !!data?.opening && data.opening.onFile === false;
  const lines = (data?.lines ?? []).filter((l) => kind === 'all' || (kind === 'in' ? l.amount > 0 : l.kind === kind));
  const kindsHere = KINDS.filter((k) => (data?.lines ?? []).some((l) => l.kind === k));

  return (
    <ListTemplate
      title="Cash forecast"
      topbarTitle="Cash forecast"
      subtitle={t('fin.cashSub')}
      filters={
        <SegmentedControl
          ariaLabel="Horizon"
          value={weeks}
          onChange={setWeeks}
          options={[
            { value: '4', label: '4 weeks' },
            { value: '8', label: '8 weeks' },
            { value: '13', label: '13 weeks' },
          ]}
        />
      }
      summary={
        data ? (
          <MetricStrip label="Cash at a glance">
            <MetricCard
              label="Cash today"
              value={booked ? fmtMoney(data.opening!.balance) : '—'}
              href={booked ? '/books/bank' : '/books'}
              tone={booked && (data.opening!.overdrawn ?? []).length ? 'alert' : 'neutral'}
              hint={booked ? overdrawnHint(data.opening!) ?? `From the books · ${fmtCount(data.opening!.accounts, 'bank and card account')}` : undefined}
              nothing={booked ? undefined : notPosted ? 'Cash not in the books yet' : 'No bank account in the books yet'}
            />
            <MetricCard label="Money in" value={fmtMoney(data.totals.inflow)} tone="good" onClick={() => setKind(kind === 'in' ? 'all' : 'in')} selected={kind === 'in'} nothing={data.totals.inflow ? undefined : 'Nothing coming in'} />
            <MetricCard label="Money out" value={fmtMoney(data.totals.outflow)} tone="neutral" nothing={data.totals.outflow ? undefined : 'Nothing going out'} />
            {booked && data.lowest ? (
              <MetricCard
                label="Low point"
                value={fmtMoney(data.lowest.balance)}
                tone={data.lowest.balance < 0 || data.lowest.belowMinimum ? 'alert' : 'good'}
                hint={`Week of ${fmtDate(data.lowest.weekStart)}${data.minimumCash !== null ? (data.lowest.belowMinimum ? ` · under the ${fmtMoney(data.minimumCash)} floor` : ` · above the ${fmtMoney(data.minimumCash)} floor`) : ''}`}
              />
            ) : (
              <MetricCard label="Net movement" value={fmtMoney(data.totals.net)} tone={data.totals.net < 0 ? 'alert' : 'good'} hint={`Over ${weeks} weeks, before any cash on hand`} />
            )}
          </MetricStrip>
        ) : (
          <Skeleton className="h-20" />
        )
      }
    >
      {q.isError && <QueryError what="the cash forecast" query={q} />}
      {data && (
        <div className="space-y-4">
          {notPosted && (
            <p className="flex flex-wrap items-start gap-x-2 gap-y-1 rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-ink" role="status">
              <Landmark className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                Cash isn’t in the books yet, so this shows the net movement — money in less money out — not a balance.{' '}
                <Link to="/books" className="text-accent underline-offset-2 hover:underline">
                  Post history in Books
                </Link>
              </span>
            </p>
          )}
          {booked && data.lowest?.belowMinimum && data.minimumCash !== null && (
            <p className="flex items-start gap-2 rounded-lg border border-alert/30 bg-alert/[0.06] px-3 py-2 text-sm text-ink" role="status">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-alert" aria-hidden="true" />
              Cash dips to {fmtMoney(data.lowest.balance)} in the week of {fmtDate(data.lowest.weekStart)} — under the {fmtMoney(data.minimumCash)} floor.
            </p>
          )}
          {/* The chart's own Table switch is the week-by-week table. */}
          <CashChart weeks={data.weeks} withBalance={booked} minimumCash={data.minimumCash} />

          {data.lines.length === 0 ? (
            <EmptyState title={t('fin.cashEmpty')} />
          ) : (
            <section className="space-y-3" aria-label={t('fin.cashOpen')}>
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Kind">
                <FilterChip active={kind === 'all'} onClick={() => setKind('all')}>
                  All
                </FilterChip>
                {kindsHere.map((k) => (
                  <FilterChip key={k} active={kind === k} onClick={() => setKind(kind === k ? 'all' : k)}>
                    {KIND_LABEL[k]}
                  </FilterChip>
                ))}
              </div>
              {lines.length === 0 ? (
                <p className="text-sm text-ink-muted">Nothing of this kind in the next {weeks} weeks.</p>
              ) : (
                weekGroups(data.from, lines).map((w) => {
                  const mine = w.lines;
                  const inSum = mine.filter((l) => l.amount > 0).reduce((s2, l) => s2 + l.amount, 0);
                  const outSum = mine.filter((l) => l.amount < 0).reduce((s2, l) => s2 - l.amount, 0);
                  return (
                    <Card key={w.weekStart}>
                      <CardContent className="p-0">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line px-4 py-2.5">
                          <h3 className="text-sm font-medium text-ink">{t('fin.cashWeek', { date: fmtDate(w.weekStart) })}</h3>
                          <p className="text-xs tabular-nums text-ink-muted">
                            {inSum > 0 && <span className="text-success">+{fmtMoney(inSum)} in</span>}
                            {inSum > 0 && outSum > 0 && ' · '}
                            {outSum > 0 && <span>−{fmtMoney(outSum)} out</span>}
                          </p>
                        </div>
                        <ul className="divide-y divide-line">
                          {mine.map((l, i) => {
                            const Icon = KIND_ICON[l.kind];
                            const incoming = l.amount > 0;
                            return (
                              <li key={`${l.date}-${l.kind}-${i}`}>
                                <Link to={l.linkUrl} className="group flex items-center gap-3 px-4 py-2.5 hover:bg-surface-raised">
                                  <Icon className={cn('h-4 w-4 shrink-0', incoming ? 'text-success' : 'text-ink-muted')} aria-hidden="true" />
                                  <span className="hidden w-24 shrink-0 text-xs tabular-nums text-ink-muted sm:block">{fmtDate(l.date)}</span>
                                  <span className="min-w-0 flex-1">
                                    <span className="block text-sm text-ink sm:truncate">{l.label}</span>
                                    <span className="block text-2xs text-ink-muted">
                                      <span className="sm:hidden">{fmtDate(l.date)} · </span>
                                      {KIND_LABEL[l.kind]}
                                      {l.confidence !== 'overdue' && ` · ${CONFIDENCE_LABEL[l.confidence]}`}
                                      {l.warning && <span className="text-warning"> · {l.warning}</span>}
                                    </span>
                                  </span>
                                  <span className="flex shrink-0 flex-col items-end gap-0.5">
                                    {/* Money coming in stays green even when it's late — late is the badge's to say. */}
                                    <span className={cn('text-sm tabular-nums', incoming ? 'text-success' : 'text-ink')}>
                                      {incoming ? '+' : '−'}
                                      {fmtMoney(Math.abs(l.amount))}
                                    </span>
                                    {l.confidence === 'overdue' && (
                                      <Badge size="sm" variant={incoming ? 'pending' : 'destructive'}>
                                        {CONFIDENCE_LABEL.overdue}
                                      </Badge>
                                    )}
                                  </span>
                                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-muted group-hover:text-accent" aria-hidden="true" />
                                </Link>
                              </li>
                            );
                          })}
                        </ul>
                      </CardContent>
                    </Card>
                  );
                })
              )}
            </section>
          )}
        </div>
      )}
    </ListTemplate>
  );
}

/* ---- Running balance over money in and out ------------------------------ */

function CashChart({ weeks, withBalance, minimumCash }: { weeks: CashWeek[]; withBalance: boolean; minimumCash: number | null }) {
  if (weeks.length === 0) return null;
  const val = (w: CashWeek) => (withBalance ? (w.balance ?? w.cumulative) : w.cumulative);
  const low = weeks.reduce((m, w) => (val(w) < val(m) ? w : m), weeks[0]!);
  const end = weeks[weeks.length - 1]!;
  const what = withBalance ? 'Cash' : 'The running total';
  const floor = withBalance && minimumCash !== null ? minimumCash : 0;
  const summary =
    val(low) < floor
      ? `${what} dips to ${fmtMoney(val(low))} in the week of ${fmtDate(low.weekStart)}${floor > 0 ? `, under the ${fmtMoney(floor)} floor,` : ''} and ends at ${fmtMoney(val(end))}.`
      : `${what} stays above ${floor > 0 ? `the ${fmtMoney(floor)} floor` : 'zero'}, lowest at ${fmtMoney(val(low))} in the week of ${fmtDate(low.weekStart)}, ending at ${fmtMoney(val(end))} after ${weeks.length} weeks.`;
  return (
    <ChartFrame
      title="Week by week"
      description={withBalance ? 'Money in above the line, money out below, and the cash balance across the horizon.' : 'Money in above the line, money out below, and the running total across the horizon.'}
      summary={summary}
      columns={[
        { key: 'weekStart', label: 'Week of', format: (v) => fmtDate(v as string) },
        { key: 'inflow', label: 'Money in', numeric: true, format: (v) => fmtMoney(v as number) },
        { key: 'outflow', label: 'Money out', numeric: true, format: (v) => fmtMoney(v as number) },
        { key: 'net', label: 'Net', numeric: true, format: (v) => fmtMoney(v as number) },
        { key: withBalance ? 'balance' : 'cumulative', label: withBalance ? 'Cash balance' : 'Running total', numeric: true, format: (v) => fmtMoney(v as number) },
      ]}
      rows={cashRows(weeks)}
      csvName="cash-forecast"
      height={280}
    >
      <CashFlowChart weeks={weeks} withBalance={withBalance} minimumCash={withBalance ? minimumCash : null} />
    </ChartFrame>
  );
}

/** An overdrawn bank account, which the cash total nets away (MONEY-18); null when none is. */
export function overdrawnHint(opening: NonNullable<CashForecast['opening']>): string | null {
  const short = opening.overdrawn ?? [];
  if (short.length === 0) return null;
  return short.length === 1 ? `${short[0]!.name} overdrawn by ${fmtMoney(-short[0]!.balance)}` : `${short.length} accounts overdrawn`;
}
