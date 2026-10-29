import { Fragment } from 'react';
import type { ExecClients } from '@alto-people/shared';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { PALETTE } from '@/components/ui/charts';
import { cn } from '@/lib/cn';
import { fmtExecExact, fmtExecMoney } from '@/lib/executiveFormat';
import { fmtHours } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useMinWidth } from '@/lib/useViewport';
import '@/lib/i18n/en/execPortal';
import { pct1 } from '../financials/finMath';

type League = ExecClients['league'];
type Row = League[number];
type T = ReturnType<typeof useI18n>['t'];

/** How many stores the league draws; past it, the best and the lowest, and the middle is in its table. */
export const LEAGUE_SHOWN = 12;
const LEAGUE_TAIL = 4;

/** The rows to draw: all of them up to LEAGUE_SHOWN, else the top and the bottom with the count between. */
export function leagueRows<T>(league: ReadonlyArray<T>): { head: T[]; hidden: number; tail: T[] } {
  if (league.length <= LEAGUE_SHOWN) return { head: [...league], hidden: 0, tail: [] };
  const headN = LEAGUE_SHOWN - LEAGUE_TAIL;
  return { head: league.slice(0, headN), hidden: league.length - LEAGUE_SHOWN, tail: league.slice(-LEAGUE_TAIL) };
}

/** The league in a sentence: the best store and the lowest, by margin. */
export function leagueSentence(league: League, t: T): string {
  if (league.length === 0) return t('execPortal.clients.league.empty');
  const best = league[0]!;
  const worst = league[league.length - 1]!;
  const name = (r: Row) => `${r.name} (${r.clientName})`;
  if (league.length === 1) return t('execPortal.clients.league.one', { best: name(best), margin: fmtExecMoney(best.margin), pct: pct1(best.marginPct) });
  return t('execPortal.clients.league.summary', { best: name(best), bestMargin: fmtExecMoney(best.margin), bestPct: pct1(best.marginPct), worst: name(worst), worstMargin: fmtExecMoney(worst.margin), worstPct: pct1(worst.marginPct) });
}

/**
 * Every store's period margin, best first: a bar as long as its margin
 * (a store losing money draws its bar in the negative step and says "−"),
 * the rate beside it, and the overtime that ate into it in words.
 */
export function StoreLeague({ league }: { league: League }) {
  const { t } = useI18n();
  const wide = useMinWidth(640);
  const { head, hidden, tail } = leagueRows(league);
  const shown = [...head, ...tail];
  const top = Math.max(1, ...shown.map((r) => Math.abs(r.margin)));
  const summary = leagueSentence(league, t);
  const ot = (r: Row) => (r.otHours > 0 ? t('execPortal.clients.league.ot', { hours: fmtHours(r.otHours), pct: r.hours > 0 ? pct1((r.otHours / r.hours) * 100) : '—' }) : t('execPortal.clients.league.noOt'));
  return (
    <ChartFrame
      title={t('execPortal.clients.league.chartTitle')}
      description={league.length > 0 ? summary : t('execPortal.clients.league.desc')}
      summary={summary}
      columns={[
        { key: 'name', label: t('execPortal.clients.league.colStore') },
        { key: 'clientName', label: t('execPortal.clients.col.client') },
        { key: 'billed', label: t('execPortal.clients.col.billed'), numeric: true, format: (v) => fmtExecExact(Number(v), 'money') },
        { key: 'margin', label: t('execPortal.clients.col.margin'), numeric: true, format: (v) => `${Number(v) < 0 ? '−' : ''}${fmtExecExact(Math.abs(Number(v)), 'money')}` },
        { key: 'marginPct', label: t('execPortal.clients.col.marginPct'), numeric: true, format: (v) => (typeof v === 'number' ? pct1(v) : '—') },
        { key: 'hours', label: t('execPortal.clients.col.hours'), numeric: true, format: (v) => fmtHours(Number(v)) },
        { key: 'otHours', label: t('execPortal.clients.league.colOt'), numeric: true, format: (v) => fmtHours(Number(v)) },
      ]}
      rows={league as unknown as Array<Record<string, unknown>>}
      csvName="store-league"
      height={shown.length * (wide ? 46 : 64) + (hidden > 0 ? 30 : 0)}
      empty={<p className="py-6 text-sm text-ink-muted">{t('execPortal.clients.league.empty')}</p>}
    >
      <ol className="space-y-2.5" data-testid="exec-store-league">
        {shown.map((r, i) => {
          const loss = r.margin < 0;
          const w = (Math.abs(r.margin) / top) * 100;
          const gap = hidden > 0 && i === head.length;
          return (
            <Fragment key={r.locationId}>
              {gap && <li className="text-xs2 text-ink-muted">{t('execPortal.clients.league.more', { count: hidden })}</li>}
              <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 sm:grid-cols-[minmax(9rem,15rem)_minmax(0,1fr)_12rem]">
                <div className="col-start-1 row-start-1 min-w-0">
                  <div className="truncate text-sm text-ink">{r.name}</div>
                  <div className="truncate text-xs2 text-ink-muted">{r.clientName}</div>
                </div>
                <div className="relative col-span-2 row-start-2 h-3 sm:col-span-1 sm:col-start-2 sm:row-start-1" aria-hidden="true">
                  {w > 0 && <div className={cn('absolute inset-y-0 left-0 rounded-full', loss && 'bg-negative-700')} style={{ width: `${Math.max(1.5, w)}%`, background: loss ? undefined : PALETTE.secondary }} />}
                </div>
                <div className="col-start-2 row-start-1 text-right tabular-nums sm:col-start-3">
                  <div className="text-sm">
                    <span className={cn('font-medium', loss ? 'text-negative-800' : 'text-ink')} title={fmtExecExact(r.margin, 'money')}>
                      {fmtExecMoney(r.margin)}
                    </span>
                    <span className="ml-1.5 text-ink-muted">{pct1(r.marginPct)}</span>
                  </div>
                  <div className="text-xs2 text-ink-muted">{ot(r)}</div>
                </div>
              </li>
            </Fragment>
          );
        })}
      </ol>
    </ChartFrame>
  );
}
