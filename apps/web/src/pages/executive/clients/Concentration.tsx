import type { ExecClients } from '@alto-people/shared';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { PALETTE } from '@/components/ui/charts';
import { cn } from '@/lib/cn';
import { fmtExecExact, fmtExecMoney } from '@/lib/executiveFormat';
import { useI18n } from '@/lib/i18n';
import { useMinWidth } from '@/lib/useViewport';
import '@/lib/i18n/en/execPortal';
import { pct1 } from '../financials/finMath';
import { concentrationBand, shareRows, type ShareRow } from './clientMath';

type T = ReturnType<typeof useI18n>['t'];

/** The book's concentration in words: a word for the index, the largest client and its share. */
export function concentrationSentence(c: ExecClients['concentration'], t: T): string {
  if (!c.topClientName) return t('execPortal.clients.empty');
  const band = concentrationBand(c.hhi, c.topSharePct, c.thresholdPct);
  return t(`execPortal.clients.conc.${band}`, { name: c.topClientName, pct: pct1(c.topSharePct) });
}

/**
 * Who the revenue depends on: one bar per client, as long as its share of
 * the period's billing on a 0–100% track, with the risk line drawn through
 * every track and named once. A client past the line is the one bar in a
 * status colour (and says so in words); the index is explained in a line.
 */
export function Concentration({ d }: { d: ExecClients }) {
  const { t } = useI18n();
  const wide = useMinWidth(640);
  const c = d.concentration;
  const rows = shareRows(d.clients);
  const threshold = c.thresholdPct;
  const sentence = concentrationSentence(c, t);
  const hhiLine = t('execPortal.clients.conc.hhi', { hhi: Math.round(c.hhi).toLocaleString() });
  const name = (r: ShareRow) => (r.other ? t('execPortal.clients.conc.other', { count: r.other }) : r.name);
  return (
    <ChartFrame
      title={t('execPortal.clients.conc.title')}
      description={
        <>
          <span className="block text-ink">{sentence}</span>
          <span className="block">{hhiLine}</span>
        </>
      }
      summary={`${sentence} ${hhiLine}`}
      columns={[
        { key: 'name', label: t('execPortal.clients.col.client') },
        { key: 'sharePct', label: t('execPortal.clients.col.share'), numeric: true, format: (v) => pct1(Number(v)) },
        { key: 'billed', label: t('execPortal.clients.col.billed'), numeric: true, format: (v) => fmtExecExact(Number(v), 'money') },
      ]}
      rows={rows.map((r) => ({ name: name(r), sharePct: r.sharePct, billed: r.billed }))}
      csvName="client-concentration"
      height={rows.length * (wide ? 40 : 50) + 26}
      empty={<p className="py-6 text-sm text-ink-muted">{t('execPortal.clients.emptyBody')}</p>}
    >
      <ol className="space-y-2.5" data-testid="exec-concentration">
        {/* The risk line's name, over the bar column; the line itself runs through every track. */}
        <li aria-hidden="true" className="grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(7rem,11rem)_minmax(0,1fr)_8.5rem] sm:gap-x-4">
          <div className="relative col-span-2 h-4 sm:col-span-1 sm:col-start-2">
            <span className="absolute top-0 whitespace-nowrap text-2xs text-ink-muted" style={{ left: `${threshold}%`, transform: 'translateX(-50%)' }}>
              {t('execPortal.clients.conc.line', { pct: `${Math.round(threshold)}%` })}
            </span>
          </div>
        </li>
        {rows.map((r) => {
          const over = !r.other && r.sharePct >= threshold;
          return (
            <li key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 sm:grid-cols-[minmax(7rem,11rem)_minmax(0,1fr)_8.5rem]">
              <div className="col-start-1 row-start-1 min-w-0">
                <div className={cn('truncate text-sm', r.other ? 'text-ink-muted' : 'text-ink')}>{name(r)}</div>
                {over && <div className="truncate text-2xs font-medium text-caution-800">{t('execPortal.clients.conc.over')}</div>}
              </div>
              <div className="relative col-span-2 row-start-2 h-3.5 rounded-full bg-neutral-100 sm:col-span-1 sm:col-start-2 sm:row-start-1">
                <div
                  className={cn('absolute inset-y-0 left-0 rounded-full', over && 'bg-caution-700')}
                  style={{ width: `${Math.max(0, Math.min(100, r.sharePct))}%`, background: over ? undefined : r.other ? PALETTE.other : PALETTE.secondary }}
                />
                <div className="absolute -inset-y-1.5 w-0.5 rounded-full bg-ink" style={{ left: `calc(${threshold}% - 1px)` }} aria-hidden="true" />
              </div>
              <div className="col-start-2 row-start-1 text-right text-sm tabular-nums sm:col-start-3">
                <span className={cn('font-medium', over ? 'text-caution-800' : 'text-ink')}>{pct1(r.sharePct)}</span>
                <span className="ml-2 text-ink-muted" title={fmtExecExact(r.billed, 'money')}>
                  {fmtExecMoney(r.billed)}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </ChartFrame>
  );
}
