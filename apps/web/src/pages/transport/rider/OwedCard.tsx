import { ChevronRight, Wallet } from '@/components/ui/icons';
import { useI18n } from '@/lib/i18n';
import { fmtMoney } from '@/lib/format';
import type { MyTransport } from '@/lib/transportApi';
import { owedSummary, paydayText } from './charges';
import '@/lib/i18n/en/ride';

const cents = (n: number) => fmtMoney(n / 100);

/**
 * "What you owe" — the balance in one place, Uber-style: the amount, the
 * payday it comes out on, what it is for, and the way into the ledger.
 * Quiet when nothing is owed: muted words, never a coloured zero.
 */
export function OwedCard({ data, onLedger }: { data: MyTransport; onLedger?: () => void }) {
  const { t } = useI18n();
  const s = owedSummary(data);
  const link = onLedger && (
    <button
      type="button"
      onClick={onLedger}
      className="inline-flex shrink-0 items-center gap-1 rounded-md text-sm font-medium text-accent hover:text-gold-bright focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright coarse:min-h-11"
    >
      {t('ride.owe.ledger')}
      <ChevronRight className="h-4 w-4" aria-hidden="true" />
    </button>
  );
  if (s.cents <= 0) {
    return (
      <section aria-label={t('ride.owe.title')} data-testid="owed-card" data-owed="0" className="mb-4 flex min-h-12 items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-2">
        <p className="min-w-0 text-sm text-ink-muted">
          <span className="font-medium">{t('ride.owe.title')}</span> · {t('ride.owe.none')}
        </p>
        {link}
      </section>
    );
  }
  const due = s.cents - s.laterCents;
  // What payroll will really take: never a fare below the minimum wage (API lib/ridePayrollOutlook).
  const when =
    s.keptReason === 'MINIMUM_WAGE'
      ? t('ride.owe.minimumWage')
      : s.payDate && s.keptReason === 'CHECK_TOO_SMALL'
        ? (s.dueCents ?? 0) > 0
          ? t('ride.owe.partKept', { due: cents(s.dueCents ?? 0), date: paydayText(s.payDate), kept: cents(s.keptCents) })
          : t('ride.owe.noneThisCheck', { date: paydayText(s.payDate) })
        : s.payDate
          ? s.laterCents > 0
            ? t('ride.owe.split', { due: cents(due), date: paydayText(s.payDate), later: cents(s.laterCents) })
            : t('ride.owe.payday', { date: paydayText(s.payDate) })
          : t('ride.owe.noPayday');
  const long = s.laterCents > 0 || s.keptCents > 0;
  const what = [
    s.rides > 0 ? t('ride.owe.rides', { count: s.rides }) : null,
    s.noShows > 0 ? t('ride.owe.noShows', { count: s.noShows }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <section aria-label={t('ride.owe.title')} data-testid="owed-card" data-owed={s.cents} className="mb-4 rounded-lg border border-line bg-surface p-4 elev-1">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-surface-raised text-ink-muted" aria-hidden="true">
          <Wallet className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-2xs font-semibold uppercase tracking-[0.18em] text-ink-muted">{t('ride.owe.title')}</div>
          <p className="mt-1 text-ink">
            <span className="text-2xl font-semibold tabular-nums">{cents(s.cents)}</span>
            {long ? (
              <span className="block text-base text-ink-muted tabular-nums">{when}</span>
            ) : (
              <span className="text-base text-ink-muted"> · {when}</span>
            )}
          </p>
          {what && <p className="mt-0.5 text-sm text-ink-muted">{what}</p>}
          {s.heldCents > 0 && <p className="mt-0.5 text-sm text-caution-800">{t('ride.owe.held', { amount: cents(s.heldCents) })}</p>}
          {link && <div className="mt-1">{link}</div>}
        </div>
      </div>
    </section>
  );
}
