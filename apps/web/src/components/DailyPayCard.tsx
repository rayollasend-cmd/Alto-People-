import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sunrise } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { fmtMoney } from '@/lib/format';
import { getMyDailyPay, setMyDailyPay } from '@/lib/payExpApi';
import { Button } from '@/components/ui/Button';
import '@/lib/i18n/en/payx';

/**
 * Daily pay, on the worker's pay page: whether they're paid each day, and
 * (when the organization lets anyone opt in) the switch. Quiet when daily
 * pay is off or not open to them.
 */
export function DailyPayCard() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['me', 'dailyPay'], queryFn: () => getMyDailyPay(), staleTime: 5 * 60_000, retry: false });
  const toggle = useMutation({
    mutationFn: (enrolled: boolean) => setMyDailyPay(enrolled),
    onSuccess: () => {
      toast.success(t('payx.daily.saved'));
      void qc.invalidateQueries({ queryKey: ['me', 'dailyPay'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('payx.daily.failed')),
  });
  const d = q.data;
  if (!d || !d.active || (!d.enrolled && !d.canOptIn)) return null;
  return (
    <section aria-label={t('payx.daily.title')} data-testid="daily-pay-card" className="mb-4 rounded-lg border border-navy-secondary bg-navy p-5 animate-enter">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gold">
          <Sunrise className="h-3.5 w-3.5" aria-hidden="true" />
          {t('payx.daily.title')}
        </span>
        <span className="text-2xs text-silver/70">{d.feeCents > 0 ? t('payx.daily.fee', { fee: fmtMoney(d.feeCents / 100) }) : t('payx.daily.noFee')}</span>
      </div>
      <p className="mt-2 text-sm text-silver">{d.timing === 'SAME_DAY' ? t('payx.daily.descSameDay') : t('payx.daily.descNextDay')}</p>
      {d.onDailySchedule ? (
        <p className="mt-3 text-sm font-medium text-success">{t('payx.daily.group')}</p>
      ) : d.enrolled ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-success">{t('payx.daily.on')}</p>
          <Button size="sm" variant="ghost" loading={toggle.isPending} disabled={toggle.isPending} onClick={() => toggle.mutate(false)}>
            {t('payx.daily.leave')}
          </Button>
        </div>
      ) : (
        <Button className="mt-3" loading={toggle.isPending} disabled={toggle.isPending} onClick={() => toggle.mutate(true)}>
          {t('payx.daily.join')}
        </Button>
      )}
    </section>
  );
}
