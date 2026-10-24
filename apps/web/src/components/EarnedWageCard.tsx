import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Wallet } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useTenant } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { fmtDayShort, fmtHours, fmtMoney, parseYmd } from '@/lib/format';
import { getMyEarnedWage, requestEarnedWage, type EwaAvailability } from '@/lib/earnedWageApi';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/cn';
import '@/lib/i18n/en/ewa';

/**
 * Pay before payday — on the associate's pay hero. One number (what is
 * available now), one sentence (how it was earned), one field and one
 * button. The advance goes to the verified pay account and comes off the
 * next check; the card says which one. Quiet when the organization does
 * not offer it, when nothing has been earned yet, or when the account is
 * not verified — then it says why, in one line.
 */

export function EarnedWageCard() {
  const { t } = useI18n();
  const tenant = useTenant();
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const enabled = tenant.moduleOn('earnedWage');
  const q = useQuery({
    queryKey: ['me', 'earnedWage'],
    queryFn: () => getMyEarnedWage(),
    enabled,
    staleTime: 60_000,
  });
  const draw = useMutation({
    mutationFn: (n: number) => requestEarnedWage(n),
    onSuccess: (r) => {
      if (r.status === 'FAILED') toast.error(t('ewa.failed'));
      else toast.success(t('ewa.sent', { amount: fmtMoney(r.amount) }));
      setAmount('');
      void qc.invalidateQueries({ queryKey: ['me', 'earnedWage'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('ewa.failed')),
  });
  if (!enabled || !q.data || !q.data.enabled || q.data.blocker === 'NO_SCHEDULE') return null;
  const a: EwaAvailability = q.data;
  const pay = parseYmd(a.payDate);
  const n = Number(amount);
  const valid = Number.isFinite(n) && n >= 1 && n <= a.available;
  const blocker =
    a.blocker === 'NO_VERIFIED_ACCOUNT'
      ? t('ewa.blockerNoAccount')
      : a.blocker === 'NOTHING_EARNED'
        ? t('ewa.blockerNothing')
        : a.blocker === 'LIMIT_REACHED'
          ? t('ewa.blockerLimit')
          : null;

  return (
    <section
      aria-label={t('ewa.title')}
      data-testid="earned-wage-card"
      className="relative mb-4 overflow-hidden rounded-lg border border-navy-secondary bg-navy animate-enter"
    >
      <div className="p-5">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gold">
            <Wallet className="h-3.5 w-3.5" aria-hidden="true" />
            {t('ewa.title')}
          </span>
          <span className="text-2xs text-silver/70">{a.fee > 0 ? t('ewa.fee', { fee: fmtMoney(a.fee) }) : t('ewa.noFee')}</span>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className={cn('text-3xl font-bold tracking-tight tabular-nums', a.available > 0 ? 'text-ink' : 'text-silver/60')}>{fmtMoney(a.available)}</span>
          <span className="text-xs text-silver">{t('ewa.available')}</span>
        </div>
        <p className="mt-1 text-sm text-silver">
          {t('ewa.earned', { net: fmtMoney(a.earnedNet), hours: fmtHours(a.hoursWorked) })}
          {pay && <> · {t('ewa.comesOff', { date: fmtDayShort(pay, { anchored: true }) })}</>}
        </p>
        {a.drawn > 0 && <p className="mt-1 text-xs text-silver/70 tabular-nums">{t('ewa.drawn', { amount: fmtMoney(a.drawn) })}</p>}
        {blocker ? (
          <p className="mt-3 text-xs text-silver">{blocker}</p>
        ) : (
          <form
            className="mt-3 flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) draw.mutate(Math.round(n * 100) / 100);
            }}
          >
            <label className="block flex-1 text-xs text-silver">
              {t('ewa.amountLabel')}
              <Input
                type="number"
                inputMode="decimal"
                min="1"
                max={a.available}
                step="1"
                className="mt-1"
                placeholder={t('ewa.upTo', { amount: fmtMoney(a.available) })}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-label={t('ewa.amountLabel')}
              />
            </label>
            <Button type="submit" loading={draw.isPending} disabled={!valid || draw.isPending}>
              {draw.isPending ? t('ewa.sending') : t('ewa.get', { amount: valid ? fmtMoney(n) : fmtMoney(a.available) })}
            </Button>
          </form>
        )}
      </div>
    </section>
  );
}
