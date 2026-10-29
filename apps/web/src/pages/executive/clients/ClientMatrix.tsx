import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ExecClientRow } from '@alto-people/shared';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { SCATTER_MIN_POINTS, ScatterMatrix, type ScatterPoint, type ScatterTone } from '@/components/ui/charts';
import { fmtMoneyAxis } from '@/components/ui/charts/axes';
import { fmtExecExact, fmtExecMoney } from '@/lib/executiveFormat';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { pct1 } from '../financials/finMath';
import { healthTone, portfolioMarginPct } from './clientMath';

type T = ReturnType<typeof useI18n>['t'];

/** The matrix in a sentence: how many, the largest and what it earns, the best margin. */
export function matrixSentence(clients: ReadonlyArray<ExecClientRow>, t: T): string {
  const placed = clients.filter((c) => c.billed > 0 && c.marginPct !== null);
  if (placed.length === 0) return t('execPortal.clients.emptyBody');
  const big = [...placed].sort((a, b) => b.billed - a.billed)[0]!;
  const best = [...placed].sort((a, b) => (b.marginPct ?? 0) - (a.marginPct ?? 0))[0]!;
  const lead = t('execPortal.clients.matrix.summary', { count: placed.length, big: big.name, billed: fmtExecMoney(big.billed), pct: pct1(big.marginPct) });
  return best.clientId === big.clientId ? `${lead} ${t('execPortal.clients.matrix.bestIsBig')}` : `${lead} ${t('execPortal.clients.matrix.best', { best: best.name, pct: pct1(best.marginPct) })}`;
}

const people = (n: number) => Math.round(n).toLocaleString();
const pctAxis = (n: number) => `${Number(n.toFixed(1))}%`.replace('-', '−');

/**
 * The client matrix: each client a bubble — billed across, margin rate up,
 * as big as the team placed there, in its health colour — on quadrants cut
 * at the portfolio's average client and its own margin rate. A tap opens
 * the client.
 */
export function ClientMatrix({ clients }: { clients: ExecClientRow[] }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const placed = useMemo(() => clients.filter((c) => c.billed > 0 && c.marginPct !== null), [clients]);
  const points = useMemo<ScatterPoint[]>(
    () => placed.map((c) => ({ id: c.clientId, name: c.name, x: c.billed, y: c.marginPct!, size: c.headcount, tone: healthTone(c) })),
    [placed],
  );
  const split = useMemo(() => {
    if (placed.length === 0) return undefined;
    const avg = placed.reduce((s, c) => s + c.billed, 0) / placed.length;
    return { x: avg, y: portfolioMarginPct(placed) ?? 0 };
  }, [placed]);
  const toneWords = useMemo<Record<ScatterTone, string>>(
    () => ({ good: t('execPortal.clients.health.good'), watch: t('execPortal.clients.health.watch'), bad: t('execPortal.clients.health.bad'), none: t('execPortal.clients.health.none') }),
    [t],
  );
  const quadrants = useMemo(
    () => ({
      topLeft: t('execPortal.clients.matrix.q.topLeft'),
      topRight: t('execPortal.clients.matrix.q.topRight'),
      bottomLeft: t('execPortal.clients.matrix.q.bottomLeft'),
      bottomRight: t('execPortal.clients.matrix.q.bottomRight'),
    }),
    [t],
  );
  const hrefOf = useMemo(() => new Map(clients.map((c) => [c.clientId, c.href])), [clients]);
  const summary = matrixSentence(clients, t);
  return (
    <ChartFrame
      title={t('execPortal.clients.matrix.title')}
      description={
        <>
          {placed.length > 0 && <span className="block text-ink">{summary}</span>}
          <span className="block">{t('execPortal.clients.matrix.desc')}</span>
        </>
      }
      summary={summary}
      columns={[
        { key: 'name', label: t('execPortal.clients.col.client') },
        { key: 'billed', label: t('execPortal.clients.col.billed'), numeric: true, format: (v) => fmtExecExact(Number(v), 'money') },
        { key: 'marginPct', label: t('execPortal.clients.col.marginPct'), numeric: true, format: (v) => (typeof v === 'number' ? pct1(v) : '—') },
        { key: 'headcount', label: t('execPortal.clients.col.headcount'), numeric: true },
        { key: 'health', label: t('execPortal.clients.col.health') },
      ]}
      rows={placed.map((c) => ({ name: c.name, billed: c.billed, marginPct: c.marginPct, headcount: c.headcount, health: toneWords[healthTone(c)] }))}
      csvName="client-matrix"
      height={placed.length < SCATTER_MIN_POINTS ? 120 : 400}
      empty={<p className="py-6 text-sm text-ink-muted">{t('execPortal.clients.emptyBody')}</p>}
    >
      <ScatterMatrix
        points={points}
        xName={t('execPortal.clients.matrix.x')}
        yName={t('execPortal.clients.matrix.y')}
        sizeName={t('execPortal.clients.matrix.size')}
        formatX={fmtExecMoney}
        formatY={pct1}
        formatSize={people}
        axisX={fmtMoneyAxis}
        axisY={pctAxis}
        toneWords={toneWords}
        sizeNote={t('execPortal.clients.matrix.sizeNote')}
        split={split}
        quadrants={quadrants}
        onPointClick={(id) => {
          const href = hrefOf.get(id);
          if (href) navigate(href);
        }}
        few={(pts) => (
          <ul className="space-y-2 text-sm" data-testid="exec-matrix-few">
            {pts.map((p) => (
              <li key={p.id} className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="min-w-0 text-ink">{p.name}</span>
                <span className="tabular-nums text-ink-muted">{t('execPortal.clients.matrix.fewRow', { billed: fmtExecMoney(p.x), pct: pct1(p.y), count: p.size })}</span>
              </li>
            ))}
            <li className="pt-1 text-xs2 text-ink-muted">{t('execPortal.clients.matrix.few')}</li>
          </ul>
        )}
      />
    </ChartFrame>
  );
}
