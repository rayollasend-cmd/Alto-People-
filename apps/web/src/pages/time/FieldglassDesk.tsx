import { useEffect, useMemo, useRef, useState } from 'react';
import { AlarmClock, AlertTriangle, Check, ClipboardCopy, FileUp, MessageSquare, RotateCcw, SkipForward } from 'lucide-react';
import { toast } from 'sonner';
import type { FieldglassStatus, TimesheetAssociateDetailResponse, TimesheetRow, TimesheetWeekResponse } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDateTz, fmtMoney, fmtRelativeDate, fmtTimeTz, fmtWeekdayTz } from '@/lib/format';
import {
  getAssociateTimesheetDetail,
  importFieldglassList,
  markFieldglassEntered,
  type FieldglassImportResult,
} from '@/lib/timeApi';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Drawer,
  DrawerBody,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  Skeleton,
} from '@/components/ui';

/**
 * The Fieldglass desk on the Timesheets page — how the week gets paid:
 *
 *   the strip     when the week is due in Fieldglass (Monday 2:00 PM
 *                 Pacific), how many workers are entered, what the buyer
 *                 approved or rejected, and — for one client — the money:
 *                 approved, awaiting, at risk
 *   the status    each worker's Fieldglass state on their row, with a tick
 *                 for "entered"
 *   enter mode    worker after worker, every value Fieldglass asks for one
 *                 tap to copy, "Entered — next"
 *   import        the buyer's Timesheets list, exported from Fieldglass,
 *                 read back: approved, rejected, hours that differ, rows
 *                 Alto can't place
 */

const PT = 'America/Los_Angeles';

/** Waiting on Alto: registered, and not entered yet — or rejected by the
 *  buyer, to fix and resubmit. */
function toWork(r: TimesheetRow): boolean {
  const f = r.fieldglass;
  return !!f?.registered && ((!f.enteredAt && !f.status) || f.status === 'REJECTED');
}

const STATUS_CHIP: Record<FieldglassStatus, { label: string; variant: 'success' | 'destructive' | 'info' | 'default' }> = {
  APPROVED: { label: 'Approved', variant: 'success' },
  INVOICED: { label: 'Invoiced', variant: 'success' },
  REJECTED: { label: 'Rejected', variant: 'destructive' },
  SUBMITTED: { label: 'Submitted', variant: 'info' },
  DRAFT: { label: 'Draft in Fieldglass', variant: 'default' },
};

function left(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h >= 48) return `${Math.floor(h / 24)}d left`;
  if (h >= 1) return `${h}h ${Math.floor((ms % 3_600_000) / 60_000)}m left`;
  return `${Math.max(1, Math.round(ms / 60_000))}m left`;
}

/** The week's standing in Fieldglass, and the two ways to work it. */
export function FieldglassStrip({
  data,
  clientId,
  onEnter,
  onImported,
}: {
  data: TimesheetWeekResponse;
  clientId: string | undefined;
  onEnter: () => void;
  onImported: () => void;
}) {
  const fg = data.fieldglass;
  const input = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<FieldglassImportResult | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  if (!fg || fg.workers === 0) return null;

  const due = Date.parse(fg.dueAt);
  const toGo = due - now;
  // Past the deadline with nothing left to enter is history, not an alarm.
  const toEnterNow = data.rows.filter(toWork).length;
  const late = toGo <= 0 && toEnterNow > 0;
  const closed = toGo <= 0 && toEnterNow === 0;
  const urgent = !late && !closed && toGo < 12 * 3_600_000;
  // Only workers registered under the row's client can be entered.
  const registered = data.rows.filter((r) => r.fieldglass?.registered).length;
  const pct = registered > 0 ? Math.round((fg.entered / registered) * 100) : 0;
  const toEnter = toEnterNow;

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setImporting(true);
    try {
      const res = await importFieldglassList(file, clientId);
      setResult(res);
      onImported();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setImporting(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <section aria-label="Fieldglass" className="rounded-lg border border-navy-secondary bg-navy/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div
            className={cn(
              'flex items-center gap-1.5 text-sm font-semibold',
              late ? 'text-alert' : urgent ? 'text-warning' : 'text-white',
            )}
          >
            <AlarmClock className="h-4 w-4 shrink-0" aria-hidden="true" />
            {late ? 'Past due in Fieldglass' : closed ? 'Was due in Fieldglass' : 'Due in Fieldglass'} · {fmtWeekdayTz(fg.dueAt, PT)}{' '}
            {fmtDateTz(fg.dueAt, PT)}, {fmtTimeTz(fg.dueAt, PT)} PT
            {!late && !closed && <span className="font-normal text-silver"> · {left(toGo)}</span>}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <div className="h-1.5 w-40 overflow-hidden rounded-full bg-navy-secondary" aria-hidden="true">
              <div className="h-full rounded-full bg-gold transition-all" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-xs tabular-nums text-silver">
              {fg.entered} of {registered} entered
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
            {fg.approved > 0 && <Badge variant="success" size="sm">{fg.approved} approved</Badge>}
            {fg.submitted > 0 && <Badge variant="info" size="sm">{fg.submitted} submitted</Badge>}
            {fg.rejected > 0 && <Badge variant="destructive" size="sm">{fg.rejected} rejected</Badge>}
            {fg.notRegistered > 0 && <Badge variant="destructive" size="sm">{fg.notRegistered} not in Fieldglass</Badge>}
            {fg.variances > 0 && <Badge variant="pending" size="sm">{fg.variances} hours differ</Badge>}
            {fg.syncedAt && <span className="self-center text-silver/70">Fieldglass list imported {fmtRelativeDate(fg.syncedAt)}</span>}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <input
            ref={input}
            type="file"
            accept=".xlsx,.csv,.txt"
            className="hidden"
            aria-label="Fieldglass Timesheets list"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
          <Button
            variant="secondary"
            size="sm"
            loading={importing}
            onClick={() => input.current?.click()}
            title="Export the Timesheets list from Fieldglass, then import it here to see what was approved"
          >
            <FileUp className="h-3.5 w-3.5" />
            Import from Fieldglass
          </Button>
          <Button size="sm" onClick={onEnter} disabled={toEnter === 0}>
            <ClipboardCopy className="h-3.5 w-3.5" />
            {toEnter > 0 ? `Enter in Fieldglass (${toEnter})` : 'All entered'}
          </Button>
        </div>
      </div>
      {fg.money && (
        <div className="mt-3 grid grid-cols-3 gap-px overflow-hidden rounded-md border border-navy-secondary bg-navy-secondary/60 text-center">
          <Money label="Approved" value={fg.money.approved} tone="text-success" />
          <Money label="Awaiting approval" value={fg.money.awaiting} tone="text-white" />
          <Money label="At risk" value={fg.money.atRisk} tone={fg.money.atRisk > 0 ? 'text-alert' : 'text-silver'} />
        </div>
      )}
      {fg.money && (
        <p className="mt-1.5 text-2xs text-silver/70">
          At {fmtMoney(fg.money.billRate)}/hr. At risk: not in Fieldglass, rejected, not entered yet, or fewer hours in Fieldglass than
          worked.
        </p>
      )}
      {result && <ImportResultDialog result={result} onClose={() => setResult(null)} />}
    </section>
  );
}

function Money({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="bg-navy px-2 py-2">
      <div className={cn('text-base font-semibold tabular-nums', tone)}>{fmtMoney(value)}</div>
      <div className="text-2xs uppercase tracking-wider text-silver/70">{label}</div>
    </div>
  );
}

/** A row's Fieldglass state, and the tick for "entered". */
export function FieldglassStatusCell({
  row,
  busy,
  onToggle,
}: {
  row: TimesheetRow;
  busy: boolean;
  onToggle: (entered: boolean) => void;
}) {
  const fg = row.fieldglass;
  if (!fg) return <span className="text-silver/40">—</span>;
  const chip = !fg.registered
    ? { label: 'Not in Fieldglass', variant: 'destructive' as const }
    : fg.status === 'SUBMITTED' && fg.resubmittedAt
      ? { label: 'Resubmitted', variant: 'info' as const }
      : fg.status
        ? STATUS_CHIP[fg.status]
        : fg.enteredAt
          ? { label: 'Entered', variant: 'accent' as const }
          : { label: 'To enter', variant: 'default' as const };
  const differs = fg.hours !== null && Math.abs(fg.hours - row.total) >= 0.01;
  return (
    <div className="flex flex-col items-start gap-0.5">
      <span className="flex items-center gap-1.5">
        {fg.registered && !fg.status && (
          <input
            type="checkbox"
            checked={!!fg.enteredAt}
            disabled={busy}
            onChange={(e) => onToggle(e.target.checked)}
            aria-label={`${row.worker} entered in Fieldglass`}
            title={fg.enteredAt ? `Entered${fg.enteredBy ? ` by ${fg.enteredBy}` : ''}` : 'Tick once entered in Fieldglass'}
            className="h-4 w-4 accent-gold"
          />
        )}
        <Badge variant={chip.variant} size="sm">
          {chip.label}
        </Badge>
        {fg.note && (
          <span title={fg.note}>
            <MessageSquare className="h-3.5 w-3.5 text-silver/70" aria-label={`Note: ${fg.note}`} />
          </span>
        )}
      </span>
      {fg.status === 'REJECTED' && (
        <>
          {fg.comment && (
            <span className="max-w-[14rem] truncate text-xs2 text-alert" title={fg.comment}>
              “{fg.comment}”
            </span>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => onToggle(true)}
            className="inline-flex items-center gap-1 text-xs2 font-medium text-gold hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright disabled:opacity-50"
            title="Fixed in Fieldglass and sent back to the buyer"
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            Mark resubmitted
          </button>
        </>
      )}
      {differs && (
        <span className="text-xs2 tabular-nums text-warning" title="Fieldglass has different hours for this week">
          Fieldglass {fg.hours!.toFixed(2)}h
        </span>
      )}
      {fg.enteredAt && fg.enteredHours !== null && Math.abs(fg.enteredHours - row.total) >= 0.01 && !fg.status && (
        <span className="text-xs2 tabular-nums text-warning">Entered at {fg.enteredHours.toFixed(2)}h — hours changed</span>
      )}
    </div>
  );
}

/** A value with one-tap copy — the whole desk is copy, switch tab, paste. */
export function CopyValue({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  const [done, setDone] = useState(false);
  if (!value) {
    return (
      <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
        <span className="text-silver/70">{label}</span>
        <span className="text-silver/40">—</span>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="text-silver/70">{label}</span>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(
            () => {
              setDone(true);
              window.setTimeout(() => setDone(false), 1200);
            },
            () => toast.error('Clipboard blocked — select the value instead.'),
          );
        }}
        aria-label={`Copy ${label}: ${value}`}
        className="group inline-flex max-w-[70%] items-center gap-1.5 rounded-md border border-navy-secondary px-2 py-1 text-right text-white transition-colors hover:border-gold/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
      >
        <span className={cn('truncate tabular-nums', mono && 'font-mono')}>{value}</span>
        {done ? (
          <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
        ) : (
          <ClipboardCopy className="h-3.5 w-3.5 shrink-0 text-silver/60 group-hover:text-gold" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

/**
 * Enter mode — worker after worker, what Fieldglass's time entry asks for:
 * the worker, their Worker ID, the site, the week ending, then each day's
 * time in, meal break, time out and hours. "Entered — next" ticks them
 * off; Skip leaves them for later.
 */
export function EnterInFieldglass({
  open,
  onClose,
  data,
  weekStartIso,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  data: TimesheetWeekResponse;
  weekStartIso: string;
  onChanged: () => void;
}) {
  // The queue as it stood on opening — ticking one off moves on, never
  // reshuffles the list under the finger.
  const [queue, setQueue] = useState<TimesheetRow[]>([]);
  const [at, setAt] = useState(0);
  const [detail, setDetail] = useState<TimesheetAssociateDetailResponse | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    // Rejected ones last — fix, then resubmit.
    setQueue([
      ...data.rows.filter((r) => toWork(r) && r.fieldglass?.status !== 'REJECTED'),
      ...data.rows.filter((r) => toWork(r) && r.fieldglass?.status === 'REJECTED'),
    ]);
    setAt(0);
    // Only on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const row = queue[at] ?? null;
  useEffect(() => {
    if (!open || !row) return;
    let live = true;
    setDetail(null);
    getAssociateTimesheetDetail({ associateId: row.associateId, weekStart: weekStartIso, clientId: row.clientId ?? undefined })
      .then((d) => live && setDetail(d))
      .catch(() => live && setDetail(null));
    return () => {
      live = false;
    };
  }, [open, row, weekStartIso]);

  const entered = async () => {
    if (!row?.clientId) return;
    setBusy(true);
    try {
      await markFieldglassEntered({ weekStart: weekStartIso, associateId: row.associateId, clientId: row.clientId, entered: true });
      onChanged();
      setAt((i) => i + 1);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not mark it entered.');
    } finally {
      setBusy(false);
    }
  };

  const worked = useMemo(() => detail?.days.filter((d) => d.netHours > 0) ?? [], [detail]);
  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()} width="max-w-lg">
      <DrawerHeader>
        <DrawerTitle>Enter in Fieldglass</DrawerTitle>
        <DrawerDescription>
          {row ? `${at + 1} of ${queue.length} · week ending ${data.weekEnding}` : `Week ending ${data.weekEnding}`}
        </DrawerDescription>
      </DrawerHeader>
      <DrawerBody>
        {!row ? (
          <div className="py-10 text-center">
            <Check className="mx-auto h-8 w-8 text-success" aria-hidden="true" />
            <p className="mt-2 text-sm font-medium text-white">
              {queue.length > 0 ? `All ${queue.length} entered.` : 'Nothing left to enter this week.'}
            </p>
            <p className="mt-1 text-xs text-silver">Import the Fieldglass list after the buyer approves to see what’s paid.</p>
            <Button className="mt-4" variant="secondary" size="sm" onClick={onClose}>
              Done
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {row.fieldglass?.status === 'REJECTED' && (
              <div className="flex gap-2 rounded-md border border-alert/40 bg-alert/10 p-2.5 text-xs text-alert">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>
                  Rejected by the buyer
                  {row.fieldglass.comment ? (
                    <>
                      : <span className="font-medium">“{row.fieldglass.comment}”</span>
                    </>
                  ) : null}
                  . Open timesheet {row.fieldglass.timesheetId ?? ''} in Fieldglass, fix it, and resubmit.
                </span>
              </div>
            )}
            <div className="rounded-lg border border-navy-secondary p-3">
              <div className="divide-y divide-navy-secondary/60">
                <CopyValue label="Worker" value={row.worker} />
                <CopyValue label="Worker ID" value={row.fieldglass?.workerId ?? null} mono />
                <CopyValue label="Site" value={row.site} />
                <CopyValue label="Week ending" value={data.weekEnding} />
                <CopyValue label="Total hours" value={row.total.toFixed(2)} />
              </div>
            </div>
            <div>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-silver">Time in / time out</h3>
              {!detail ? (
                <Skeleton className="h-32 w-full" />
              ) : worked.length === 0 ? (
                <p className="text-sm text-silver">No worked days found.</p>
              ) : (
                <ul className="space-y-2">
                  {worked.map((d) => (
                    <li key={d.date} className="rounded-lg border border-navy-secondary p-2.5">
                      <div className="text-sm font-semibold text-white">
                        {d.weekday} {d.monthDay}
                        {d.overnight && <span className="ml-1.5 text-xs2 font-normal text-sky">☾ overnight</span>}
                      </div>
                      <div className="divide-y divide-navy-secondary/40">
                        <CopyValue label="Time in" value={d.timeIn} />
                        {d.breaks.map((b, i) => (
                          <CopyValue key={i} label={i === 0 ? 'Meal break' : 'Break'} value={b} />
                        ))}
                        <CopyValue label="Time out" value={d.timeOut} />
                        <CopyValue label="Hours" value={d.netHours.toFixed(2)} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="sticky bottom-0 -mx-1 flex gap-2 bg-navy px-1 pb-1 pt-2">
              <Button variant="ghost" onClick={() => setAt((i) => i + 1)} disabled={busy}>
                <SkipForward className="h-4 w-4" />
                Skip
              </Button>
              <Button className="flex-1" onClick={() => void entered()} loading={busy}>
                <Check className="h-4 w-4" />
                {row.fieldglass?.status === 'REJECTED' ? 'Resubmitted — next' : 'Entered — next'}
              </Button>
            </div>
          </div>
        )}
      </DrawerBody>
    </Drawer>
  );
}

/** What the imported Fieldglass list said — and what needs a look. */
function ImportResultDialog({ result, onClose }: { result: FieldglassImportResult; onClose: () => void }) {
  const order = ['APPROVED', 'INVOICED', 'SUBMITTED', 'DRAFT', 'REJECTED'] as const;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Fieldglass list imported</DialogTitle>
          <DialogDescription>
            Matched {result.matched} of {result.rows} timesheet{result.rows === 1 ? '' : 's'}
            {result.weeks.length > 1 ? ` across ${result.weeks.length} weeks` : ''}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap gap-1.5">
            {order
              .filter((k) => result.statuses[k])
              .map((k) => (
                <Badge key={k} variant={STATUS_CHIP[k].variant} size="sm">
                  {result.statuses[k]} {STATUS_CHIP[k].label.toLowerCase()}
                </Badge>
              ))}
          </div>
          {result.variances.length > 0 && (
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-warning">Hours differ</h3>
              <ul className="space-y-1">
                {result.variances.map((v) => (
                  <li key={`${v.associateId}-${v.weekEnd}`} className="flex justify-between gap-3">
                    <span className="truncate text-white">{v.worker}</span>
                    <span className="shrink-0 tabular-nums text-silver">
                      Alto {v.alto.toFixed(2)}h · Fieldglass {v.fieldglass.toFixed(2)}h
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.unmatched.length > 0 && (
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-alert">Not found in Alto</h3>
              <p className="mb-1 text-xs text-silver">No approved Alto hours for this worker that week — check the name, the client, or the approvals.</p>
              <ul className="space-y-1">
                {result.unmatched.map((u, i) => (
                  <li key={i} className="flex justify-between gap-3">
                    <span className="truncate text-white">{u.worker}</span>
                    <span className="shrink-0 tabular-nums text-silver">
                      {u.hours.toFixed(2)}h · week ending {u.weekEnd}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.variances.length === 0 && result.unmatched.length === 0 && (
            <p className="flex items-center gap-1.5 text-success">
              <Check className="h-4 w-4" aria-hidden="true" />
              Everything in Fieldglass matches Alto’s hours.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
