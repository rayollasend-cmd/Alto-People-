import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { fmtDate, parseYmd, ymdLocal } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { downloadStatementFile } from '@/pages/clients/statementsShared';
import { shiftDays } from './scope';

/**
 * The service report picker — "which day do you want on paper?"
 *
 * The report is the portal, frozen: the 16th's PDF is what the portal
 * showed on the 16th. So the picker is the same lens the pages use —
 * today, yesterday, this week, last week, a day off the calendar, or a
 * range — and the download is one tap.
 */

export type ReportPick = { kind: 'day'; date: string } | { kind: 'range'; from: string; to: string };
type Preset = 'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | 'day' | 'range';

/** The org week starts on Saturday. */
function weekSaturday(ymd: string): string {
  const d = parseYmd(ymd) ?? new Date();
  const sinceSat = (d.getDay() + 1) % 7;
  return shiftDays(ymd, -sinceSat);
}

export function reportUrl(scope: URLSearchParams, pick: ReportPick): { url: string; filename: string } {
  const q = new URLSearchParams(scope);
  if (pick.kind === 'day') {
    q.set('date', pick.date);
    return { url: `/api/client-portal/service-report.pdf?${q.toString()}`, filename: `service-report-${pick.date}.pdf` };
  }
  q.set('from', pick.from);
  q.set('to', pick.to);
  return { url: `/api/client-portal/service-report.pdf?${q.toString()}`, filename: `service-report-${pick.from}-to-${pick.to}.pdf` };
}

export function ServiceReportDialog({
  open,
  onClose,
  scope,
  initial,
}: {
  open: boolean;
  onClose: () => void;
  /** The portal scope in the URL (clientId / locationId), threaded into the download. */
  scope: URLSearchParams;
  /** What the opening page was looking at, so the picker starts there. */
  initial?: ReportPick;
}) {
  const { t } = useI18n();
  const today = ymdLocal();
  const yesterday = shiftDays(today, -1);
  const sat = weekSaturday(today);
  const lastWeek = { from: shiftDays(sat, -7), to: shiftDays(sat, -1) };
  const thisWeek = { from: sat, to: today };

  const initialPreset = (): Preset => {
    if (!initial) return 'yesterday';
    if (initial.kind === 'day') return initial.date === today ? 'today' : initial.date === yesterday ? 'yesterday' : 'day';
    if (initial.from === lastWeek.from && initial.to === lastWeek.to) return 'lastWeek';
    if (initial.from === thisWeek.from && initial.to === thisWeek.to) return 'thisWeek';
    return 'range';
  };
  const [preset, setPreset] = useState<Preset>(initialPreset);
  const [day, setDay] = useState(initial?.kind === 'day' ? initial.date : yesterday);
  const [range, setRange] = useState(initial?.kind === 'range' ? { from: initial.from, to: initial.to } : lastWeek);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setPreset(initialPreset());
    if (initial?.kind === 'day') setDay(initial.date);
    if (initial?.kind === 'range') setRange({ from: initial.from, to: initial.to });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pick: ReportPick =
    preset === 'today'
      ? { kind: 'day', date: today }
      : preset === 'yesterday'
        ? { kind: 'day', date: yesterday }
        : preset === 'thisWeek'
          ? { kind: 'range', from: thisWeek.from, to: thisWeek.to }
          : preset === 'lastWeek'
            ? { kind: 'range', from: lastWeek.from, to: lastWeek.to }
            : preset === 'day'
              ? { kind: 'day', date: day }
              : { kind: 'range', from: range.from, to: range.to };
  const spanDays = pick.kind === 'range' ? Math.round((new Date(pick.to).getTime() - new Date(pick.from).getTime()) / 86_400_000) + 1 : 1;
  const valid = pick.kind === 'day' ? !!pick.date : pick.from <= pick.to && spanDays <= 31;
  const describe =
    pick.kind === 'day'
      ? fmtDate(parseYmd(pick.date))
      : `${fmtDate(parseYmd(pick.from))} – ${fmtDate(parseYmd(pick.to))} · ${t('portal.svcPages', { count: spanDays })}`;

  const download = async () => {
    setBusy(true);
    try {
      const { url, filename } = reportUrl(scope, pick);
      await downloadStatementFile(url, filename);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const presets: Array<{ key: Preset; label: string }> = [
    { key: 'today', label: t('portal.svcToday') },
    { key: 'yesterday', label: t('portal.yesterday') },
    { key: 'thisWeek', label: t('portal.svcThisWeek') },
    { key: 'lastWeek', label: t('portal.rangeLastWeek') },
    { key: 'day', label: t('portal.svcADay') },
    { key: 'range', label: t('portal.svcARange') },
  ];
  const inputCls = 'h-9 rounded-md border border-navy-secondary bg-navy px-2 text-sm text-white coarse:h-11';

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('portal.svcReportTitle')}</DialogTitle>
          <DialogDescription>{t('portal.svcReportDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('portal.svcReportTitle')}>
            {presets.map((p) => (
              <Button
                key={p.key}
                size="sm"
                variant={preset === p.key ? 'secondary' : 'ghost'}
                role="radio"
                aria-checked={preset === p.key}
                onClick={() => setPreset(p.key)}
              >
                {p.label}
              </Button>
            ))}
          </div>
          {preset === 'day' && (
            <label className="flex items-center gap-2 text-sm text-silver">
              {t('portal.pickDate')}
              <input type="date" value={day} max={shiftDays(today, 14)} onChange={(e) => e.target.value && setDay(e.target.value)} className={inputCls} />
            </label>
          )}
          {preset === 'range' && (
            <div className="flex flex-wrap items-center gap-2 text-sm text-silver">
              <label className="flex items-center gap-1.5">
                {t('portal.rangeFrom')}
                <input
                  type="date"
                  value={range.from}
                  max={range.to}
                  onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })}
                  className={inputCls}
                />
              </label>
              <label className="flex items-center gap-1.5">
                {t('portal.rangeTo')}
                <input
                  type="date"
                  value={range.to}
                  min={range.from}
                  max={shiftDays(today, 14)}
                  onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })}
                  className={inputCls}
                />
              </label>
            </div>
          )}
          <p className={cn('text-xs', valid ? 'text-silver/70' : 'text-alert')}>
            {valid ? describe : t('portal.svcRangeTooLong')}
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void download()} loading={busy} disabled={!valid}>
            <FileText className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {t('portal.svcDownload')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
