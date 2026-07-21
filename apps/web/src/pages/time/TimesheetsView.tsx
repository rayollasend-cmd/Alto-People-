import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  FileSpreadsheet,
  RefreshCw,
  CheckCircle2,
} from 'lucide-react';
import type { TimesheetWeekResponse } from '@alto-people/shared';
import { getTimesheetWeek, exportTimesheetXlsx } from '@/lib/timeApi';
import { upsertAttestation } from '@/lib/complianceScorecardApi';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  PageHeader,
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

export function TimesheetsView() {
  const { can } = useAuth();
  const canAttest = can('manage:compliance');

  const [weekStart, setWeekStart] = useState<Date>(() => lastCompletedWeekStart(new Date()));
  const [data, setData] = useState<TimesheetWeekResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [filing, setFiling] = useState(false);

  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getTimesheetWeek({ weekStart: weekStart.toISOString() });
      setData(res);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not load timesheets.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [weekStart]);

  useEffect(() => {
    void load();
  }, [load]);

  const onDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      await exportTimesheetXlsx({ weekStart: weekStart.toISOString() });
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
    if (!data || filing) return;
    if (
      !window.confirm(
        `Mark the Fieldglass timesheet for the week ending ${data.weekEnding} as filed? This ticks the weekly compliance attestation.`,
      )
    )
      return;
    setFiling(true);
    try {
      await upsertAttestation({
        key: 'FIELDGLASS_TIMESHEET',
        periodStart: mondayOfIsoWeek(data.weekEndIso),
        outcome: 'YES',
        actionTakenAt: new Date().toISOString(),
        notes: `Filed via Timesheets for week ending ${data.weekEnding}`,
        evidenceDocumentId: null,
      });
      toast.success('Marked filed — compliance attestation recorded.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not record attestation.');
    } finally {
      setFiling(false);
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

        <div className="ml-auto flex flex-wrap items-center gap-2">
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
          {canAttest && (
            <Button
              variant="primary"
              size="sm"
              onClick={onMarkFiled}
              loading={filing}
              disabled={!data}
              title="Record that this week's Fieldglass timesheet was filed"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              Mark filed
            </Button>
          )}
        </div>
      </div>

      {data && data.pendingCount > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-gold/40 bg-gold/10 p-3 text-sm text-gold">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Provisional — {data.pendingCount} time{' '}
            {data.pendingCount === 1 ? 'entry is' : 'entries are'} still pending approval this
            week and are <strong>not</strong> included below. Approve them, then refresh before
            filing.
          </span>
        </div>
      )}

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
                    <TableCell className="font-medium text-white">{r.worker}</TableCell>
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

      {data && rows.length > 0 && (
        <p className="text-xs text-silver/70">
          {rows.length} worker{rows.length === 1 ? '' : 's'} · {data.totalHours.toFixed(2)} total
          hours · week ending {data.weekEnding}. Hours are net of unpaid breaks, billed flat under
          &ldquo;Others&rdquo; per the SOW.
        </p>
      )}
    </div>
  );
}
