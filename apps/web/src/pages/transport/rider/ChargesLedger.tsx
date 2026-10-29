import { ChevronDown, Receipt } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { useI18n, type Translate } from '@/lib/i18n';
import { fmtDayShort, fmtMoney, parseYmd } from '@/lib/format';
import type { MyTransport } from '@/lib/transportApi';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { atMinimumWage, chargeGroups, chargeRows, paydayText, type ChargeGroup, type ChargeRow, type Payday, type PayrollOutlook } from './charges';
import '@/lib/i18n/en/ride';

const cents = (n: number) => fmtMoney(n / 100);

const CHIP: Record<ChargeRow['state'], { variant: 'pending' | 'success' | 'default'; key: 'ride.ledger.chip.pending' | 'ride.ledger.chip.held' | 'ride.ledger.chip.taken' | 'ride.waived' | 'ride.ledger.chip.notCharged' }> = {
  pending: { variant: 'pending', key: 'ride.ledger.chip.pending' },
  held: { variant: 'pending', key: 'ride.ledger.chip.held' },
  taken: { variant: 'success', key: 'ride.ledger.chip.taken' },
  waived: { variant: 'default', key: 'ride.waived' },
  notCharged: { variant: 'default', key: 'ride.ledger.chip.notCharged' },
  notRun: { variant: 'default', key: 'ride.ledger.chip.notCharged' },
};

/**
 * The charge's state in words, when the row has more to say than its
 * section: why nothing was taken, or why it was waived. (A pending or
 * taken row's payday is its section's heading — said once, not per row.)
 */
function stateWords(t: Translate, row: ChargeRow): string | null {
  switch (row.state) {
    case 'waived':
      return row.reason ? t('ride.ledger.wordsWaivedWhy', { reason: row.reason }) : null;
    case 'notCharged':
      return t('ride.notCharged');
    case 'notRun':
      return t('ride.ledger.wordsNotRun');
    default:
      return null;
  }
}

/** A row's state as a sentence for screen readers and the chip's title. */
function fullWords(t: Translate, row: ChargeRow, payday: Payday, payroll?: PayrollOutlook): string {
  switch (row.state) {
    case 'pending':
      // Payroll never takes a fare below the minimum wage: no payday is promised.
      if (atMinimumWage(payroll)) return t('ride.ledger.wordsMinimumWage');
      if (!payday) return t('ride.ledger.wordsPendingNoDate');
      return row.date > payday.periodEnd ? t('ride.ledger.wordsPendingLater', { date: paydayText(payday.payDate) }) : t('ride.ledger.wordsPending', { date: paydayText(payday.payDate) });
    case 'held':
      return t('ride.heldForSignature');
    case 'taken':
      return row.takenOn ? t('ride.ledger.wordsTaken', { date: paydayText(row.takenOn) }) : t('ride.ledger.wordsTakenNoDate');
    default:
      return stateWords(t, row) ?? t('ride.waived');
  }
}

/**
 * The ledger: one row per charge with its state in words and a scale chip,
 * this pay period's running total, past paydays folded away. Money is
 * exact. "Question a charge" opens the problem form on that ride — never a
 * "waive" (a ride taken is never waived; only transportation waives a
 * no-show fee).
 */
export function ChargesLedger({ data, onQuestion }: { data: MyTransport; onQuestion: (rideId: string) => void }) {
  const { t } = useI18n();
  const payday = data.charges.nextPayday;
  const rows = chargeRows(data.rides);
  if (rows.length === 0) {
    return <EmptyState size="sm" icon={Receipt} title={t('ride.ledger.empty')} description={t('ride.ledger.emptyBody')} className="mb-4" />;
  }
  const groups = chargeGroups(rows, payday);
  return (
    <div className="mb-4 space-y-3" data-testid="ride-ledger">
      {groups.map((g) =>
        g.kind === 'current' || g.kind === 'later' || g.kind === 'held' ? (
          <Card key={g.key} data-testid={`ledger-${g.key}`}>
            <CardContent>
              <GroupHead g={g} payday={payday} payroll={data.charges.payroll} />
              <ChargeList rows={g.rows} payday={payday} payroll={data.charges.payroll} onQuestion={onQuestion} />
            </CardContent>
          </Card>
        ) : (
          <details key={g.key} className="group rounded-lg border border-line bg-surface" data-testid={`ledger-${g.key}`}>
            <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 rounded-lg px-4 py-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright [&::-webkit-details-marker]:hidden">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-ink">
                  {g.kind === 'payday' && g.payDate
                    ? t('ride.ledger.paidOn', { date: paydayText(g.payDate) })
                    : g.kind === 'taken'
                      ? t('ride.ledger.paidUndated')
                      : t('ride.ledger.earlier')}
                </span>
                <span className="block text-sm text-ink-muted">{t('ride.ledger.count', { count: g.rows.length })}</span>
              </span>
              {g.totalCents > 0 && <span className="shrink-0 text-base font-semibold tabular-nums text-ink">{cents(g.totalCents)}</span>}
              <ChevronDown className="h-4 w-4 shrink-0 text-ink-muted transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <div className="border-t border-line-subtle px-4">
              <ChargeList rows={g.rows} payday={payday} payroll={data.charges.payroll} onQuestion={onQuestion} />
            </div>
          </details>
        ),
      )}
    </div>
  );
}

function GroupHead({ g, payday, payroll }: { g: ChargeGroup; payday: Payday; payroll?: PayrollOutlook }) {
  const { t } = useI18n();
  // Headed by the payday the money comes out on, never "This pay period":
  // the rides due on the next payday are the period that already CLOSED,
  // while Home's "this pay period" is the one running now (ASSOC-17).
  const title =
    g.kind === 'current' && atMinimumWage(payroll)
      ? t('ride.ledger.keptTitle')
      : g.kind === 'current'
      ? payday
        ? t('ride.ledger.paydayTitle', { date: paydayText(payday.payDate) })
        : t('ride.ledger.current')
      : g.kind === 'later'
        ? payday
          ? t('ride.ledger.laterTitle', { date: paydayText(payday.payDate) })
          : t('ride.ledger.later')
        : t('ride.ledger.held');
  const sub =
    g.kind === 'current'
      ? payday
        ? t('ride.ledger.through', { date: paydayText(payday.periodEnd) })
        : t('ride.ledger.wordsPendingNoDate')
      : g.kind === 'later'
        ? payday
          ? t('ride.ledger.after', { date: paydayText(payday.periodEnd) })
          : t('ride.ledger.wordsPendingNoDate')
        : t('ride.heldForSignature');
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line-subtle pb-3">
      <div className="min-w-0">
        <h3 className="text-base font-medium text-ink">{title}</h3>
        <p className="text-sm text-ink-muted">{sub}</p>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-2xs font-semibold uppercase tracking-[0.18em] text-ink-muted">{t('ride.ledger.running')}</div>
        <div className={cn('text-lg font-semibold tabular-nums', g.totalCents > 0 ? 'text-ink' : 'text-ink-muted')} data-testid="ledger-running">
          {cents(g.totalCents)}
        </div>
      </div>
    </div>
  );
}

function ChargeList({ rows, payday, payroll, onQuestion }: { rows: ChargeRow[]; payday: Payday; payroll?: PayrollOutlook; onQuestion: (rideId: string) => void }) {
  const { t } = useI18n();
  return (
    <ul className="divide-y divide-line-subtle">
      {rows.map((row) => {
        const chip = CHIP[row.state];
        const words = stateWords(t, row);
        return (
          <li key={row.ride.id} className="flex items-start gap-3 py-3" data-testid="ledger-row" data-state={row.state}>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-ink">
                {fmtDayShort(parseYmd(row.date) ?? row.date, { anchored: true })} ·{' '}
                {row.ride.direction === 'TO_WORK' ? t('ride.toWork') : t('ride.fromWork')}
              </div>
              <div className="text-sm text-ink-muted">
                {row.kind === 'noShow' ? t('ride.ledger.noShowFee') : t('ride.ledger.fare')}
                {words ? ` · ${words}` : <span className="sr-only"> · {fullWords(t, row, payday, payroll)}</span>}
              </div>
              {row.counts && (
                <button
                  type="button"
                  onClick={() => onQuestion(row.ride.id)}
                  className="mt-0.5 inline-flex items-center rounded-md text-sm text-ink-muted underline decoration-line-strong underline-offset-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright coarse:min-h-11"
                >
                  {t('ride.ledger.question')}
                </button>
              )}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <span className={cn('text-base font-semibold tabular-nums', row.counts ? 'text-ink' : 'text-ink-muted line-through')}>{cents(row.cents)}</span>
              <Badge variant={chip.variant} size="sm">
                {t(chip.key)}
              </Badge>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
