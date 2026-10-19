import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Banknote, CheckCircle2, Clock, Info } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { fmtDate } from '@/lib/format';
import { getMyPayByCheck, requestPayByCheck } from '@/lib/paperChecksApi';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';

/**
 * "I'd like a paper check for this payday." Shows only while a paycheck is
 * open to a change (payroll has prepared it and hasn't paid it): the
 * request, payroll's answer, or the check itself once approved. Only this
 * paycheck changes; the deposit stays on file.
 */
export function PaperCheckRequestCard() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['me', 'pay-by-check'], queryFn: getMyPayByCheck, retry: false });
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const ask = useMutation({
    mutationFn: () => requestPayByCheck(reason.trim()),
    onSuccess: (d) => {
      qc.setQueryData(['me', 'pay-by-check'], d);
      setOpen(false);
      setReason('');
      toast.success(t('payCheck.sent'));
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('payCheck.failed')),
  });
  const d = q.data;
  if (!d?.openPaycheck) return null;
  const period = `${fmtDate(d.openPaycheck.periodStart)} – ${fmtDate(d.openPaycheck.periodEnd)}`;
  const box = 'mb-4 rounded-lg border p-4 text-sm';

  if (d.override) {
    return (
      <div className={`${box} border-success/30 bg-success/5`} role="status">
        <p className="flex items-center gap-2 font-medium text-ink">
          <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
          {t('payCheck.title')}
        </p>
        <p className="mt-1 text-ink-muted">{t('payCheck.approved', { period })}</p>
      </div>
    );
  }
  if (d.request?.status === 'PENDING') {
    return (
      <div className={`${box} border-warning/40 bg-warning/5`} role="status">
        <p className="flex items-center gap-2 font-medium text-ink">
          <Clock className="h-4 w-4 text-warning" aria-hidden="true" />
          {t('payCheck.title')}
        </p>
        <p className="mt-1 text-ink-muted">{t('payCheck.pending', { period })}</p>
      </div>
    );
  }
  return (
    <div className={`${box} border-line bg-surface-raised`}>
      {d.request?.status === 'REJECTED' && (
        <p className="mb-2 flex items-start gap-2 text-ink-muted">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
          {t('payCheck.declined', { period, reason: d.request.decidedReason ?? '' })}
        </p>
      )}
      {!open ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-ink">
            <Banknote className="h-4 w-4 text-gold" aria-hidden="true" />
            {t('payCheck.prompt')}
          </span>
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            {t('payCheck.ask')}
          </Button>
        </div>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim().length >= 3) ask.mutate();
          }}
        >
          <p className="font-medium text-ink">{t('payCheck.title')}</p>
          <p className="text-ink-muted">{t('payCheck.note')}</p>
          <label className="block">
            <span className="text-ink-muted">{t('payCheck.reasonLabel')}</span>
            <Textarea className="mt-1" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('payCheck.reasonPlaceholder')} />
          </label>
          <div className="flex gap-2">
            <Button type="submit" size="sm" loading={ask.isPending} disabled={reason.trim().length < 3 || ask.isPending}>
              {t('payCheck.send')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
              {t('payCheck.cancel')}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
