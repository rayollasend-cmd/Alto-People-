import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Flag, ReceiptText } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { fmtDayShort, fmtHours, fmtMoney, parseYmd } from '@/lib/format';
import { cn } from '@/lib/cn';
import {
  confirmMyPayPreview,
  flagMyPayPreview,
  getMyPayPreview,
  type PayPreview,
  type PreviewFlag,
} from '@/lib/payExpApi';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';

/**
 * "Check your pay before payday" — two days before each pay date, the
 * check that's coming, line by line: each day's hours, the pay lines,
 * taxes, deductions, what daily pay already sent, and the take-home. One
 * tap says it looks right; any line can be flagged. A day with the right
 * times goes to the lead as a punch fix; anything else goes to payroll as
 * a case. Quiet outside the window.
 */

const TAX_KEY: Record<PayPreview['taxes'][number]['kind'], MessageKey> = {
  FEDERAL: 'payx.preview.tax.FEDERAL',
  SOCIAL_SECURITY: 'payx.preview.tax.SOCIAL_SECURITY',
  MEDICARE: 'payx.preview.tax.MEDICARE',
  STATE: 'payx.preview.tax.STATE',
  LOCAL: 'payx.preview.tax.LOCAL',
};
const DED_KEY: Record<PayPreview['deductions'][number]['kind'], MessageKey> = {
  PRE_TAX: 'payx.preview.ded.PRE_TAX',
  POST_TAX: 'payx.preview.ded.POST_TAX',
};

interface FlagTarget {
  line: string;
  label: string;
  kind: PreviewFlag['kind'];
  /** A day's shift, when the line is a day: times can be corrected. */
  entry?: { id: string; date: string } | null;
}

const day = (ymd: string) => {
  const d = parseYmd(ymd);
  return d ? fmtDayShort(d, { anchored: true }) : ymd;
};

export function PayPreviewCard() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [target, setTarget] = useState<FlagTarget | null>(null);
  const q = useQuery({ queryKey: ['me', 'payPreview'], queryFn: () => getMyPayPreview(), staleTime: 60_000, retry: 1 });
  const confirm = useMutation({
    mutationFn: () => confirmMyPayPreview(),
    onSuccess: (p) => {
      qc.setQueryData(['me', 'payPreview'], p);
      toast.success(t('payx.preview.confirmed'));
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('payx.preview.saveFailed')),
  });

  if (q.isError) {
    return (
      <section aria-label={t('payx.preview.title')} className="mb-4 rounded-lg border border-navy-secondary bg-navy p-5 text-sm text-silver">
        {t('payx.preview.loadFailed')}{' '}
        <Button size="sm" variant="ghost" onClick={() => void q.refetch()}>
          {t('common.retry')}
        </Button>
      </section>
    );
  }
  const p = q.data;
  if (!p || !p.available || !p.payDate) return null;

  const kindLabel = (kind: string) => {
    const key = `pay.kind.${kind}` as MessageKey;
    const s = t(key);
    return s === key ? kind : s;
  };
  const flagged = p.check?.status === 'FLAGGED' ? p.check.flags.length : 0;
  const flaggedLines = new Set(p.check?.flags.map((f) => f.line) ?? []);

  const row = (opts: { line: string; label: string; value: string; kind: PreviewFlag['kind']; muted?: boolean; strong?: boolean; entry?: FlagTarget['entry']; sub?: string | null }) => (
    <li key={opts.line} className="flex items-center gap-2 py-1.5">
      <div className="min-w-0 flex-1">
        <div className={cn('truncate text-sm', opts.strong ? 'font-semibold text-ink' : opts.muted ? 'text-silver' : 'text-ink')}>{opts.label}</div>
        {opts.sub && <div className="truncate text-xs text-silver/80">{opts.sub}</div>}
      </div>
      <span className={cn('tabular-nums text-sm', opts.strong ? 'font-semibold text-ink' : 'text-ink')}>{opts.value}</span>
      <button
        type="button"
        onClick={() => setTarget({ line: opts.line, label: opts.label, kind: opts.kind, entry: opts.entry ?? null })}
        className={cn(
          'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-silver transition-colors hover:bg-navy-secondary hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold',
          flaggedLines.has(opts.line) && 'text-warning',
        )}
        aria-label={t('payx.preview.flagLine', { line: opts.label })}
      >
        <Flag className="h-4 w-4" aria-hidden="true" />
      </button>
    </li>
  );

  return (
    <section aria-label={t('payx.preview.title')} data-testid="pay-preview-card" className="relative mb-4 overflow-hidden rounded-lg border border-gold/30 bg-navy animate-enter">
      <div className="p-5">
        <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gold">
          <ReceiptText className="h-3.5 w-3.5" aria-hidden="true" />
          {t('payx.preview.title')}
        </span>
        <p className="mt-2 text-sm text-ink">{t('payx.preview.intro', { date: day(p.payDate), from: day(p.periodStart!), to: day(p.periodEnd!) })}</p>
        <p className="mt-1 text-xs text-silver">{p.source === 'RUN' ? t('payx.preview.fromRun') : t('payx.preview.estimate')}</p>

        <h3 className="mt-4 text-2xs font-medium uppercase tracking-[0.14em] text-silver">{t('payx.preview.days')}</h3>
        {p.days.length === 0 ? (
          <p className="mt-1 text-sm text-silver">{t('payx.preview.noDays')}</p>
        ) : (
          <ul className="divide-y divide-navy-secondary/60">
            {p.days.map((d) =>
              row({
                line: `day:${d.date}`,
                label: day(d.date),
                value: fmtHours(d.hours),
                kind: 'HOURS',
                entry: d.entries[0] ? { id: d.entries[0].id, date: d.date } : null,
                sub: d.entries.some((e) => !e.approved) ? t('payx.preview.notApproved') : d.entries.map((e) => e.siteName).filter(Boolean).join(' · ') || null,
              }),
            )}
          </ul>
        )}

        <h3 className="mt-4 text-2xs font-medium uppercase tracking-[0.14em] text-silver">{t('payx.preview.pay')}</h3>
        <ul className="divide-y divide-navy-secondary/60">
          {p.earnings.map((e) =>
            row({
              line: e.line,
              label: kindLabel(e.kind),
              value: fmtMoney(e.amount),
              kind: e.kind === 'REGULAR' || e.kind === 'OVERTIME' ? 'RATE' : 'OTHER',
              sub: e.hours !== null && e.rate !== null ? `${fmtHours(e.hours)} × ${fmtMoney(e.rate)}` : null,
            }),
          )}
          {row({ line: 'gross', label: t('payx.preview.gross'), value: fmtMoney(p.gross), kind: 'OTHER', strong: true })}
        </ul>

        {p.taxes.length > 0 && (
          <>
            <h3 className="mt-4 text-2xs font-medium uppercase tracking-[0.14em] text-silver">{t('payx.preview.taxes')}</h3>
            <ul className="divide-y divide-navy-secondary/60">
              {p.taxes.map((x) => row({ line: x.line, label: t(TAX_KEY[x.kind]), value: `−${fmtMoney(x.amount)}`, kind: 'TAX', muted: true }))}
            </ul>
          </>
        )}
        {(p.deductions.length > 0 || p.paidAhead > 0) && (
          <ul className="mt-2 divide-y divide-navy-secondary/60">
            {p.deductions.map((x) => row({ line: x.line, label: t(DED_KEY[x.kind]), value: `−${fmtMoney(x.amount)}`, kind: 'DEDUCTION', muted: true }))}
            {p.paidAhead > 0 && row({ line: 'paidAhead', label: t('payx.preview.paidAhead'), value: `−${fmtMoney(p.paidAhead)}`, kind: 'OTHER', muted: true })}
          </ul>
        )}
        <ul className="mt-2 border-t border-navy-secondary">
          {row({ line: 'net', label: t('payx.preview.net'), value: fmtMoney(p.net), kind: 'OTHER', strong: true })}
        </ul>

        {p.check?.status === 'CONFIRMED' && (
          <p role="status" className="mt-3 flex items-center gap-1.5 text-sm font-medium text-success">
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            {t('payx.preview.confirmed')}
          </p>
        )}
        {flagged > 0 && (
          <p role="status" className="mt-3 flex items-center gap-1.5 text-sm font-medium text-warning">
            <Flag className="h-4 w-4 shrink-0" aria-hidden="true" />
            {flagged === 1 ? t('payx.preview.flaggedOne') : t('payx.preview.flaggedMany', { count: flagged })}
          </p>
        )}
        {p.check?.status !== 'CONFIRMED' && (
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <Button className="sm:flex-1" loading={confirm.isPending} disabled={confirm.isPending} onClick={() => confirm.mutate()}>
              {t('payx.preview.looksRight')}
            </Button>
            <Button className="sm:flex-1" variant="secondary" onClick={() => setTarget({ line: 'net', label: t('payx.flag.whole'), kind: 'OTHER' })}>
              {t('payx.preview.somethingWrong')}
            </Button>
          </div>
        )}
      </div>
      <FlagDialog target={target} onClose={() => setTarget(null)} />
    </section>
  );
}

function FlagDialog({ target, onClose }: { target: FlagTarget | null; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [clockIn, setClockIn] = useState('');
  const [clockOut, setClockOut] = useState('');
  const [error, setError] = useState<string | null>(null);
  const reset = () => {
    setNote('');
    setClockIn('');
    setClockOut('');
    setError(null);
  };
  // A wall-clock time on the shift's own day, as an instant.
  const at = (date: string, hhmm: string) => (hhmm ? new Date(`${date}T${hhmm}:00`).toISOString() : null);
  const send = useMutation({
    mutationFn: () =>
      flagMyPayPreview({
        line: target!.line,
        kind: target!.kind,
        note: note.trim(),
        timeEntryId: target!.entry?.id ?? null,
        proposedClockIn: target!.entry ? at(target!.entry.date, clockIn) : null,
        proposedClockOut: target!.entry ? at(target!.entry.date, clockOut) : null,
      }),
    onSuccess: (r) => {
      qc.setQueryData(['me', 'payPreview'], r.preview);
      toast.success(r.routedTo === 'LEAD' ? t('payx.flag.sentLead') : t('payx.flag.sentPayroll'));
      reset();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : t('payx.preview.saveFailed')),
  });
  return (
    <Dialog
      open={!!target}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('payx.flag.title')}</DialogTitle>
          <DialogDescription>
            {target?.label} · {t('payx.flag.desc')}
          </DialogDescription>
        </DialogHeader>
        <form
          id="pay-flag-form"
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim().length < 3) {
              setError(t('payx.flag.noteRequired'));
              return;
            }
            send.mutate();
          }}
        >
          <label className="block text-sm text-ink">
            {t('payx.flag.note')}
            <Textarea
              className="mt-1"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('payx.flag.notePlaceholder')}
              aria-invalid={!!error}
              aria-describedby={error ? 'pay-flag-error' : undefined}
            />
          </label>
          {target?.entry && (
            <fieldset className="space-y-2">
              <legend className="text-sm text-ink">{t('payx.flag.fixTimes')}</legend>
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-xs text-silver">
                  {t('payx.flag.clockIn')}
                  <Input type="time" className="mt-1" value={clockIn} onChange={(e) => setClockIn(e.target.value)} />
                </label>
                <label className="block text-xs text-silver">
                  {t('payx.flag.clockOut')}
                  <Input type="time" className="mt-1" value={clockOut} onChange={(e) => setClockOut(e.target.value)} />
                </label>
              </div>
            </fieldset>
          )}
          {error && (
            <p id="pay-flag-error" role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            {t('payx.flag.cancel')}
          </Button>
          <Button type="submit" form="pay-flag-form" loading={send.isPending} disabled={send.isPending}>
            {t('payx.flag.send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
