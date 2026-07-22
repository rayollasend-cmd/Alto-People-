import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  FileSpreadsheet,
  Lock,
  RefreshCw,
  CheckCircle2,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type {
  TimesheetWeekResponse,
  TimesheetAssociateDetailResponse,
  TimesheetIssueKind,
  ClientListItem,
} from '@alto-people/shared';
import { listClients } from '@/lib/clientsApi';
import {
  getTimesheetWeek,
  exportTimesheetXlsx,
  getAssociateTimesheetDetail,
  fileTimesheetWeek,
} from '@/lib/timeApi';
import { upsertAttestation } from '@/lib/complianceScorecardApi';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Drawer,
  DrawerBody,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  PageHeader,
  Select,
  Skeleton,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';

/** Saturday 00:00 (local) that starts the Sat→Fri week containing `d`. */
function startOfSaturdayWeek(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 1) % 7)); // Sat→0, Sun→1 … Fri→6
  return x;
}

/** The last fully-completed Sat→Fri week relative to now. */
function lastCompletedWeekStart(now: Date): Date {
  const cur = startOfSaturdayWeek(now);
  cur.setDate(cur.getDate() - 7);
  return cur;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Monday (YYYY-MM-DD) of the ISO week containing the given Friday date — the
 *  period the FIELDGLASS_TIMESHEET weekly attestation is keyed on. */
function mondayOfIsoWeek(fridayIso: string): string {
  const d = new Date(`${fridayIso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // back to Monday
  return d.toISOString().slice(0, 10);
}

const fmtDay = (d: Date) =>
  d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

const hoursCell = (n: number) => (n === 0 ? '0.00' : n.toFixed(2));

const ISSUE_LABEL: Record<TimesheetIssueKind, string> = {
  MISSING_CLOCKOUT: 'Missing clock-out',
  PENDING_APPROVAL: 'Pending approval',
  OVER_HOURS: 'Over hours',
};

export function TimesheetsView() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const canAttest = can('manage:compliance');

  const [weekStart, setWeekStart] = useState<Date>(() => lastCompletedWeekStart(new Date()));
  const [data, setData] = useState<TimesheetWeekResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [filingBusy, setFilingBusy] = useState(false);

  // Fieldglass individual-timesheet drill-down.
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<TimesheetAssociateDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [showSchedule, setShowSchedule] = useState(false);

  // Per-client filter — file one Fieldglass SOW at a time. '' = all clients.
  const [clientId, setClientId] = useState('');
  const [clients, setClients] = useState<ClientListItem[]>([]);

  useEffect(() => {
    let live = true;
    listClients({ status: 'ACTIVE' })
      .then((r) => live && setClients(r.clients))
      .catch(() => {
        /* dropdown just stays at "All clients" */
      });
    return () => {
      live = false;
    };
  }, []);

  const clientArg = clientId || undefined;

  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart]);

  // No-show (scheduled but zero worked) or a delta of 2h+ either way.
  const scheduleFlags = useMemo(
    () =>
      (data?.scheduleComparison ?? []).filter(
        (s) => (s.scheduledHours > 0 && s.actualHours === 0) || Math.abs(s.delta) >= 2,
      ),
    [data],
  );

  const openDetail = useCallback(
    async (associateId: string) => {
      setDetailOpen(true);
      setDetail(null);
      setDetailLoading(true);
      try {
        const res = await getAssociateTimesheetDetail({
          associateId,
          weekStart: weekStart.toISOString(),
          clientId: clientArg,
        });
        setDetail(res);
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : 'Could not load the timesheet.');
        setDetailOpen(false);
      } finally {
        setDetailLoading(false);
      }
    },
    [weekStart, clientArg],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getTimesheetWeek({ weekStart: weekStart.toISOString(), clientId: clientArg });
      setData(res);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not load timesheets.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [weekStart, clientArg]);

  useEffect(() => {
    void load();
  }, [load]);

  const onDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      await exportTimesheetXlsx({ weekStart: weekStart.toISOString(), clientId: clientArg });
      toast.success('Downloaded the Fieldglass timesheet workbook.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Download failed.');
    } finally {
      setDownloading(false);
    }
  };

  const onCopy = async () => {
    if (!data || data.rows.length === 0) return;
    // Tab-separated so it pastes cleanly into Fieldglass / a spreadsheet.
    const header = ['Worker', 'Site', 'End', 'ST', 'OT', 'DT', 'Others', 'NB', 'Total'];
    const lines = [header.join('\t')];
    for (const r of data.rows) {
      lines.push(
        [r.worker, r.site, data.weekEnding, r.st, r.ot, r.dt, r.others, r.nb, r.total]
          .map(String)
          .join('\t'),
      );
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast.success(`Copied ${data.rows.length} rows to the clipboard.`);
    } catch {
      toast.error('Clipboard blocked — use Download instead.');
    }
  };

  const onMarkFiled = async () => {
    if (!data || filingBusy) return;
    const already = !!data.filing;
    if (
      !window.confirm(
        already
          ? `Re-file the week ending ${data.weekEnding}? This updates the recorded snapshot to the current hours.`
          : `Mark the Fieldglass timesheet for the week ending ${data.weekEnding} as filed? This records a snapshot of the current hours${canAttest ? ' and ticks the weekly compliance attestation' : ''}.`,
      )
    )
      return;
    setFilingBusy(true);
    try {
      const updated = await fileTimesheetWeek({ weekStart: weekStart.toISOString(), clientId: clientArg });
      setData(updated);
      // Attestation is best-effort and only for compliance-managers; the
      // filing snapshot is already recorded regardless.
      if (canAttest) {
        try {
          await upsertAttestation({
            key: 'FIELDGLASS_TIMESHEET',
            periodStart: mondayOfIsoWeek(updated.weekEndIso),
            outcome: 'YES',
            actionTakenAt: new Date().toISOString(),
            notes: `Filed via Timesheets for week ending ${updated.weekEnding}`,
            evidenceDocumentId: null,
          });
        } catch {
          /* filing recorded; attestation can be re-ticked on the scorecard */
        }
      }
      toast.success(already ? 'Re-filed — snapshot updated.' : 'Marked filed.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not record the filing.');
    } finally {
      setFilingBusy(false);
    }
  };

  const rows = data?.rows ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Timesheets"
        subtitle="Fieldglass-ready weekly hours (Saturday → Friday). Approved time only, net of unpaid breaks."
      />

      {/* Week picker + actions */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center rounded-md border border-navy-secondary bg-navy-secondary/30 p-0.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setWeekStart((w) => addDays(w, -7))}
            title="Previous week"
            aria-label="Previous week"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="px-3 text-sm text-white tabular-nums whitespace-nowrap">
            {fmtDay(weekStart)} – {fmtDay(weekEnd)}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setWeekStart((w) => addDays(w, 7))}
            title="Next week"
            aria-label="Next week"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setWeekStart(lastCompletedWeekStart(new Date()))}
          title="Jump to the last completed week"
        >
          Last completed week
        </Button>
        <Select
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          className="h-8 w-auto text-sm"
          title="File one Fieldglass client/SOW at a time"
          aria-label="Client filter"
        >
          <option value="">All clients</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            variant={showSchedule ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setShowSchedule((v) => !v)}
            disabled={!data || data.scheduleComparison.length === 0}
            title="Compare published schedule vs hours actually worked"
          >
            <CalendarClock className="h-3.5 w-3.5" />
            Scheduled vs actual
            {scheduleFlags.length > 0 && (
              <span className="ml-1 rounded-full bg-gold/20 px-1.5 text-[11px] text-gold">
                {scheduleFlags.length}
              </span>
            )}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void load()} loading={loading}>
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onCopy}
            disabled={rows.length === 0}
            title="Copy the grid (tab-separated) for pasting into Fieldglass"
          >
            <ClipboardCopy className="h-3.5 w-3.5" />
            Copy
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onDownload}
            loading={downloading}
            disabled={rows.length === 0}
          >
            <FileSpreadsheet className="h-3.5 w-3.5" />
            Download .xlsx
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onMarkFiled}
            loading={filingBusy}
            disabled={!data || rows.length === 0}
            title="Record a snapshot of this week's hours as filed into Fieldglass"
          >
            {data?.filing ? <RefreshCw className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            {data?.filing ? 'Re-file' : 'Mark filed'}
          </Button>
        </div>
      </div>

      {data?.filing &&
        (data.filing.drift.length > 0 ? (
          <div className="rounded-md border border-gold/40 bg-gold/10 p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-medium text-gold">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                Filed {new Date(data.filing.filedAt).toLocaleDateString()} — {data.filing.drift.length}{' '}
                worker{data.filing.drift.length === 1 ? '' : 's'} changed since. Re-file to match
                Fieldglass.
              </div>
              <Button variant="secondary" size="sm" onClick={onMarkFiled} loading={filingBusy}>
                <RefreshCw className="h-3.5 w-3.5" />
                Re-file
              </Button>
            </div>
            <ul className="space-y-1 text-xs">
              {data.filing.drift.map((d) => (
                <li key={d.associateId} className="flex flex-wrap gap-x-2">
                  <span className="font-medium text-white">{d.worker}</span>
                  <span className="text-silver/70">
                    filed {d.filedHours.toFixed(2)}h → now {d.currentHours.toFixed(2)}h (
                    {d.delta > 0 ? '+' : ''}
                    {d.delta.toFixed(2)})
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-md border border-navy-secondary bg-navy/40 p-2.5 text-sm text-silver">
            <Lock className="h-4 w-4 text-gold" />
            Filed{data.filing.filedBy ? ` by ${data.filing.filedBy}` : ''} ·{' '}
            {new Date(data.filing.filedAt).toLocaleString()} ·{' '}
            {data.filing.filedTotalHours.toFixed(2)}h — in sync.
          </div>
        ))}

      {data && data.issues.length > 0 ? (
        <div className="rounded-md border border-gold/40 bg-gold/10 p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-gold">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {data.issues.length} {data.issues.length === 1 ? 'issue' : 'issues'} to review before
              filing
            </div>
            <Button variant="ghost" size="sm" onClick={() => navigate('/time-attendance')}>
              Review in Time &amp; Attendance
            </Button>
          </div>
          <ul className="space-y-1 text-xs">
            {data.issues.map((iss, i) => (
              <li key={`${iss.associateId ?? i}-${iss.kind}`} className="flex flex-wrap gap-x-2">
                <span className="shrink-0 font-semibold text-gold/90">
                  {ISSUE_LABEL[iss.kind]}
                </span>
                <span className="font-medium text-white">{iss.worker}</span>
                <span className="text-silver/70">— {iss.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : data && rows.length > 0 ? (
        <div className="flex items-center gap-2 rounded-md border border-navy-secondary bg-navy/40 p-2.5 text-sm text-silver">
          <CheckCircle2 className="h-4 w-4 text-gold" />
          No issues — this week looks ready to file.
        </div>
      ) : null}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>ID</TableHead>
                <TableHead className="text-right">Revision</TableHead>
                <TableHead>Worker</TableHead>
                <TableHead>Site</TableHead>
                <TableHead>End</TableHead>
                <TableHead className="text-right">ST</TableHead>
                <TableHead className="text-right">OT</TableHead>
                <TableHead className="text-right">DT</TableHead>
                <TableHead className="text-right">Others</TableHead>
                <TableHead className="text-right">NB</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={12} className="p-0">
                    <SkeletonRows count={8} />
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={12}>
                    <EmptyState
                      title="No approved hours this week"
                      description="Nothing to report to Fieldglass for the selected week. Approve time in the queue, then refresh."
                    />
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={`${r.associateId}-${r.site}`}>
                    <TableCell>
                      <Badge variant={r.status === 'PENDING' ? 'pending' : 'success'}>
                        {r.status === 'PENDING' ? 'Pending Approval' : 'Ready to submit'}
                      </Badge>
                    </TableCell>
                    {/* ID + Revision are Fieldglass-assigned on entry — shown to keep
                        the columns aligned with the Fieldglass list for eyeballing. */}
                    <TableCell className="text-silver/50">—</TableCell>
                    <TableCell className="text-right tabular-nums text-silver/60">0</TableCell>
                    <TableCell className="font-medium">
                      <button
                        type="button"
                        onClick={() => void openDetail(r.associateId)}
                        className="text-left text-gold hover:underline focus:underline focus:outline-none"
                        title="Open this worker's daily timesheet"
                      >
                        {r.worker}
                      </button>
                    </TableCell>
                    <TableCell className="text-silver">{r.site}</TableCell>
                    <TableCell className="tabular-nums text-silver">{data?.weekEnding}</TableCell>
                    <TableCell className="text-right tabular-nums text-silver">{hoursCell(r.st)}</TableCell>
                    <TableCell className="text-right tabular-nums text-silver">{hoursCell(r.ot)}</TableCell>
                    <TableCell className="text-right tabular-nums text-silver">{hoursCell(r.dt)}</TableCell>
                    <TableCell className="text-right tabular-nums text-white">{hoursCell(r.others)}</TableCell>
                    <TableCell className="text-right tabular-nums text-silver">{hoursCell(r.nb)}</TableCell>
                    <TableCell className="text-right tabular-nums font-semibold text-white">{hoursCell(r.total)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {showSchedule && data && data.scheduleComparison.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="flex items-center gap-2 border-b border-navy-secondary p-3 text-sm font-medium text-white">
              <CalendarClock className="h-4 w-4 text-gold" />
              Scheduled vs actual
              <span className="text-xs font-normal text-silver/60">
                (published assigned shifts vs approved hours worked)
              </span>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Worker</TableHead>
                    <TableHead className="text-right">Scheduled</TableHead>
                    <TableHead className="text-right">Actual</TableHead>
                    <TableHead className="text-right">Δ</TableHead>
                    <TableHead>Flag</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.scheduleComparison.map((s) => {
                    const noShow = s.scheduledHours > 0 && s.actualHours === 0;
                    const notable = Math.abs(s.delta) >= 2;
                    return (
                      <TableRow key={s.associateId}>
                        <TableCell className="font-medium text-white">{s.worker}</TableCell>
                        <TableCell className="text-right tabular-nums text-silver">
                          {s.scheduledHours.toFixed(2)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-silver">
                          {s.actualHours.toFixed(2)}
                        </TableCell>
                        <TableCell
                          className={`text-right tabular-nums ${notable ? 'font-semibold text-gold' : 'text-silver/70'}`}
                        >
                          {s.delta > 0 ? '+' : ''}
                          {s.delta.toFixed(2)}
                        </TableCell>
                        <TableCell>
                          {noShow ? (
                            <Badge variant="destructive">No-show</Badge>
                          ) : notable ? (
                            <Badge variant="pending">
                              {s.delta > 0 ? 'Over' : 'Under'}
                            </Badge>
                          ) : (
                            <span className="text-silver/40">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {data && rows.length > 0 && (
        <p className="text-xs text-silver/70">
          {rows.length} worker{rows.length === 1 ? '' : 's'} · {data.totalHours.toFixed(2)} total
          hours · week ending {data.weekEnding}. Hours are net of unpaid breaks, billed flat under
          &ldquo;Others&rdquo; per the SOW.
        </p>
      )}

      {/* Fieldglass individual-timesheet drill-down */}
      <Drawer
        open={detailOpen}
        onOpenChange={(o) => !o && setDetailOpen(false)}
        width="max-w-3xl"
      >
        <DrawerHeader>
          <DrawerTitle>{detail?.worker ?? 'Timesheet'}</DrawerTitle>
          <DrawerDescription>
            {detail ? `Period ${detail.periodLabel} · ${detail.site}` : 'Loading…'}
          </DrawerDescription>
        </DrawerHeader>
        <DrawerBody>
          {detailLoading || !detail ? (
            <div className="space-y-3">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                <span>
                  <span className="text-silver/60">Status: </span>
                  <Badge variant={detail.status === 'PENDING' ? 'pending' : 'success'}>
                    {detail.status === 'PENDING' ? 'Pending Approval' : 'Ready to submit'}
                  </Badge>
                </span>
                <span>
                  <span className="text-silver/60">Total worked: </span>
                  <span className="font-semibold text-white tabular-nums">
                    {detail.totalHours.toFixed(2)}h
                  </span>
                </span>
              </div>

              {detail.pendingCount > 0 && (
                <div className="flex items-start gap-2 rounded-md border border-gold/40 bg-gold/10 p-2.5 text-xs text-gold">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    {detail.pendingCount}{' '}
                    {detail.pendingCount === 1 ? 'entry is' : 'entries are'} still pending approval
                    and excluded from the totals below.
                  </span>
                </div>
              )}

              <div className="overflow-x-auto rounded-md border border-navy-secondary">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-navy-secondary/40">
                      <th className="p-2 text-left font-medium text-silver/70 whitespace-nowrap">
                        Time in / time out
                      </th>
                      {detail.days.map((d) => (
                        <th key={d.date} className="p-2 text-center whitespace-nowrap">
                          <div className="font-semibold text-white">{d.weekday}</div>
                          <div className="text-[11px] tabular-nums text-silver/60">{d.monthDay}</div>
                        </th>
                      ))}
                      <th className="p-2 text-center font-semibold text-white">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-t border-navy-secondary">
                      <td className="p-2 text-silver/70">Time In</td>
                      {detail.days.map((d) => (
                        <td key={d.date} className="p-2 text-center tabular-nums text-silver whitespace-nowrap">
                          {d.timeIn ?? '—'}
                        </td>
                      ))}
                      <td />
                    </tr>
                    <tr className="border-t border-navy-secondary">
                      <td className="p-2 text-silver/70">Meal Break</td>
                      {detail.days.map((d) => (
                        <td key={d.date} className="p-2 text-center text-[11px] text-silver/80 whitespace-nowrap">
                          {d.breaks.length > 0
                            ? d.breaks.map((b, i) => <div key={i}>{b}</div>)
                            : '—'}
                        </td>
                      ))}
                      <td />
                    </tr>
                    <tr className="border-t border-navy-secondary">
                      <td className="p-2 text-silver/70">Time Out</td>
                      {detail.days.map((d) => (
                        <td key={d.date} className="p-2 text-center tabular-nums text-silver whitespace-nowrap">
                          {d.timeOut ?? '—'}
                        </td>
                      ))}
                      <td />
                    </tr>
                    <tr className="border-t border-navy-secondary bg-navy-secondary/30">
                      <td className="p-2 font-medium text-white">Total Worked</td>
                      {detail.days.map((d) => (
                        <td key={d.date} className="p-2 text-center tabular-nums font-medium text-white">
                          {d.netHours.toFixed(2)}
                        </td>
                      ))}
                      <td className="p-2 text-center tabular-nums font-semibold text-white">
                        {detail.totalHours.toFixed(2)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-white">Accounting (USD)</h3>
                <div className="overflow-x-auto rounded-md border border-navy-secondary">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-navy-secondary/40 text-silver/70">
                        <th className="p-2 text-left font-medium">Rates</th>
                        <th className="p-2 text-right font-medium">Pay Rate</th>
                        <th className="p-2 text-right font-medium">Rate</th>
                        <th className="p-2 text-right font-medium">Quantity</th>
                        <th className="p-2 text-right font-medium">Days</th>
                        <th className="p-2 text-right font-medium">Amount (USD)</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-t border-navy-secondary">
                        <td className="p-2 text-silver whitespace-nowrap">{detail.rateLabel}</td>
                        <td className="p-2 text-right tabular-nums text-silver">
                          {detail.payRate.toFixed(2)}
                        </td>
                        <td className="p-2 text-right tabular-nums text-silver">
                          {detail.billRate != null ? detail.billRate.toFixed(2) : '—'}
                        </td>
                        <td className="p-2 text-right tabular-nums text-silver">
                          {detail.totalHours.toFixed(2)}
                        </td>
                        <td className="p-2 text-right text-silver/60">—</td>
                        <td className="p-2 text-right tabular-nums text-white">
                          {detail.amount != null ? detail.amount.toFixed(2) : '—'}
                        </td>
                      </tr>
                      <tr className="border-t border-navy-secondary bg-navy-secondary/30 font-medium">
                        <td className="p-2 text-white">Subtotal</td>
                        <td className="p-2" />
                        <td className="p-2" />
                        <td className="p-2 text-right tabular-nums text-white">
                          {detail.totalHours.toFixed(2)}
                        </td>
                        <td className="p-2 text-right text-silver/60">—</td>
                        <td className="p-2 text-right tabular-nums text-white">
                          {detail.amount != null ? detail.amount.toFixed(2) : '—'}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                {detail.billRate == null && (
                  <p className="text-xs text-gold/80">
                    Set this client&rsquo;s <strong>Fieldglass bill rate</strong> (client → Basics)
                    to compute the Amount.
                  </p>
                )}
              </div>

              <p className="text-xs text-silver/60">
                Times shown in {detail.timeZone}. Overnight shifts appear under their clock-in day.
                Meal breaks are unpaid and excluded from Total Worked. Pay Rate is what Alto pays the
                associate; Rate is the client bill rate.
              </p>
            </div>
          )}
        </DrawerBody>
      </Drawer>
    </div>
  );
}
