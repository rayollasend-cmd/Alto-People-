import { useQuery } from '@tanstack/react-query';
import type { HugoAllowanceView } from '@alto-people/shared';
import { Gauge, Hourglass } from '@/components/ui/icons';
import { getHugoAllowance } from '@/lib/hugoApi';
import { fmtDayShort, fmtMoney } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import '@/lib/i18n/en/hugoPane';

/**
 * The person's allowance for Hugo's thinking, on screen (owner, 2026-10-29):
 * each account has its own — associates, drivers and floor supervisors a
 * dollar every 30 days, the office ten a month (API lib/hugoAllowance).
 *
 *   the ⋯ menu      "Thinking time this month: 23% used · renews Fri, Nov 27"
 *                   (the office also sees "$2.30 of $10")
 *   from 80%        a quiet line above the input
 *   used up         a calm banner: until when he answers the basics, and which
 *
 * Nothing shows without a model (there is no thinking time to count). The
 * answers that fell back already say it; each answer refreshes the meter.
 */

export const HUGO_ALLOWANCE_KEY = ['hugo', 'allowance'] as const;
/** From here the panel says most of it is used. */
export const ALLOWANCE_NEARLY_AT = 80;

/** The person's allowance, when a model answers for them. */
export function useHugoAllowance(enabled: boolean) {
  return useQuery({ queryKey: HUGO_ALLOWANCE_KEY, queryFn: () => getHugoAllowance(), enabled, staleTime: 60_000, retry: false });
}

/**
 * The day it renews, as a day. The office's month turns at midnight in the
 * company's zone; read twelve hours on, that instant is the same calendar
 * day anywhere in the Americas, so a reader on Pacific time isn't told the
 * day before. A worker's 30 days end at the time they began.
 */
export function allowanceRenewDay(a: Pick<HugoAllowanceView, 'allowanceClass' | 'renewsAt'>): string {
  const at = new Date(a.renewsAt).getTime() + (a.allowanceClass === 'staff' ? 12 * 3_600_000 : 0);
  return fmtDayShort(new Date(at));
}

/** Dollars as the office reads them: cents, or the fraction of a cent when that is all. */
export const fmtSpend = (usd: number): string => fmtMoney(usd, { precise: usd > 0 && usd < 0.01 });

/** The ⋯ menu's lines: the share used and when it renews (and, for the office, the dollars), with a slim bar. */
export function HugoAllowanceMeter({ allowance }: { allowance: HugoAllowanceView | null | undefined }) {
  const { t } = useI18n();
  if (!allowance?.on) return null;
  const pct = Math.max(0, Math.min(100, allowance.usedPercent));
  const high = allowance.exhausted || pct >= ALLOWANCE_NEARLY_AT;
  return (
    <div className="px-2 py-1.5 text-xs text-ink-muted" data-testid="hugo-allowance-meter">
      <p className="flex items-start gap-1.5 leading-snug">
        <Gauge className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{t('hugoPane.allowance.meter', { percent: pct, date: allowanceRenewDay(allowance) })}</span>
      </p>
      {allowance.allowanceClass === 'staff' && allowance.spentUsd !== undefined && allowance.capUsd !== undefined && (
        <p className="mt-0.5 pl-5 tabular-nums">{t('hugoPane.allowance.meterStaff', { spent: fmtSpend(allowance.spentUsd), cap: fmtMoney(allowance.capUsd) })}</p>
      )}
      <div
        className="ml-5 mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken"
        role="meter"
        aria-label={t('hugoPane.allowance.meterLabel')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className={cn('h-full rounded-full', high ? 'bg-caution' : 'bg-accent-fill')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/**
 * Above the input: from 80% a quiet line; used up, a calm banner naming the
 * day it renews and what he can still answer. Nothing below 80%.
 */
export function HugoAllowanceNotice({ allowance }: { allowance: HugoAllowanceView | null | undefined }) {
  const { t } = useI18n();
  if (!allowance?.on) return null;
  if (allowance.exhausted) {
    const date = allowanceRenewDay(allowance);
    return (
      <p role="status" className="mb-2 flex items-start gap-2 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-sm text-ink" data-testid="hugo-allowance-used-up">
        <Hourglass className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
        <span>{allowance.allowanceClass === 'staff' ? t('hugoPane.allowance.usedUpStaff', { date }) : t('hugoPane.allowance.usedUp', { date })}</span>
      </p>
    );
  }
  if (allowance.usedPercent < ALLOWANCE_NEARLY_AT) return null;
  return (
    <p className="mb-2 flex items-center gap-1.5 px-1 text-xs text-ink-muted" data-testid="hugo-allowance-most">
      <Gauge className="h-3.5 w-3.5 shrink-0 text-caution" aria-hidden="true" />
      {t('hugoPane.allowance.most')}
    </p>
  );
}
