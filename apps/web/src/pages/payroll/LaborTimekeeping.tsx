import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarClock, Clock, Scale } from 'lucide-react';
import { useAuth, useTerm } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtMoney, parseYmd } from '@/lib/format';
import {
  clearSiteRounding,
  getOtEqualization,
  getScheduleChanges,
  setScheduleChangeExemption,
  type ExemptReason,
  getTimekeeping,
  setOtEqualization,
  setRounding,
  type OtEqualizationRow,
  type RoundingMode,
  type ScheduleChangeRow,
} from '@/lib/laborLiveApi';
import { Badge, Button, Card, CardContent, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, Field, MetricCard, SectionTitle, SegmentedControl, Select, SkeletonRows, Textarea } from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { QueryError } from '@/components/ui/QueryError';

/**
 * Timekeeping rules: punch rounding (neutral, or always in the worker's
 * favor — never only the employer's), overtime offered fewest-overtime-first
 * with how it has been shared lately, and the predictability pay recorded
 * for late schedule changes.
 */

const MODE_LABEL: Record<RoundingMode, string> = { NONE: 'Exact minutes', NEAREST: 'Nearest', EMPLOYEE_FAVOR: 'In the worker’s favor' };
const MODE_HELP: Record<RoundingMode, string> = {
  NONE: 'Pay the minutes punched.',
  NEAREST: 'Each punch rounds to the nearest increment — under half rounds down, half or more rounds up (for 15 minutes: 1–7 down, 8–14 up). Neutral over time, as the Department of Labor requires.',
  EMPLOYEE_FAVOR: 'Clock-ins round down and clock-outs round up, so nobody is ever paid less than they worked.',
};
const describeRounding = (mode: RoundingMode, inc: number) => (mode === 'NONE' ? 'Exact minutes' : `${MODE_LABEL[mode]} ${inc} minutes`);

function RoundingCard({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['labor-rules', 'timekeeping'], queryFn: getTimekeeping });
  const [mode, setMode] = useState<RoundingMode>('NONE');
  const [inc, setInc] = useState(15);
  const [siteId, setSiteId] = useState('');
  const [siteMode, setSiteMode] = useState<RoundingMode>('NEAREST');
  const [siteInc, setSiteInc] = useState(15);
  useEffect(() => {
    if (q.data) {
      setMode(q.data.rounding.mode);
      setInc(q.data.rounding.increment);
    }
  }, [q.data]);
  const save = useMutation({
    mutationFn: (input: { siteId?: string | null; mode: RoundingMode; increment: number }) => setRounding(input),
    onSuccess: () => {
      toast.success('Rounding saved. The next pay run uses it; punches themselves never change.');
      setSiteId('');
      void qc.invalidateQueries({ queryKey: ['labor-rules', 'timekeeping'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save rounding.'),
  });
  const clear = useMutation({
    mutationFn: (id: string) => clearSiteRounding(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['labor-rules', 'timekeeping'] }),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not remove it.'),
  });

  if (q.isError) return <QueryError what="timekeeping rules" query={q} />;
  if (!q.data) return <SkeletonRows count={3} />;
  const d = q.data;
  const dirty = mode !== d.rounding.mode || inc !== d.rounding.increment;
  const free = d.sites.filter((s) => !d.siteRounding.some((r) => r.siteId === s.id));

  return (
    <Card>
      <CardContent className="space-y-4 p-4 sm:p-5">
        <SectionTitle as="h3" icon={Clock} title="Punch rounding" description="Applied when pay is worked out — the punch on the timesheet stays exactly as recorded, with “rounded from” beside it." />
        <div className="space-y-3">
          <SegmentedControl<RoundingMode>
            ariaLabel="How punches round"
            value={mode}
            onChange={(v) => canManage && setMode(v)}
            options={(['NONE', 'NEAREST', 'EMPLOYEE_FAVOR'] as RoundingMode[]).map((m) => ({ value: m, label: MODE_LABEL[m] }))}
          />
          <p className="text-sm text-ink-muted">{MODE_HELP[mode]}</p>
          {mode !== 'NONE' && (
            <Field label="To the nearest">
              {(p) => (
                <Select {...p} value={String(inc)} onChange={(e) => setInc(Number(e.target.value))} disabled={!canManage} className="max-w-[12rem]">
                  <option value="5">5 minutes</option>
                  <option value="6">6 minutes (tenth of an hour)</option>
                  <option value="15">15 minutes (quarter hour)</option>
                </Select>
              )}
            </Field>
          )}
          <p className="text-xs text-ink-muted">Rounding that only ever favors the employer — clock-ins up, clock-outs down — isn’t offered: it fails the DOL’s neutrality rule.</p>
          {canManage && (
            <Button size="sm" onClick={() => save.mutate({ siteId: null, mode, increment: inc })} disabled={!dirty} loading={save.isPending && !siteId}>
              Save for the organization
            </Button>
          )}
        </div>

        <div className="space-y-2 border-t border-line pt-4">
          <h4 className="text-sm font-semibold text-ink">Sites with their own rounding</h4>
          {d.siteRounding.length === 0 ? (
            <p className="text-sm text-ink-muted">Every site uses the organization’s rounding.</p>
          ) : (
            <ul className="divide-y divide-line">
              {d.siteRounding.map((r) => (
                <li key={r.siteId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span className="text-ink">{r.siteName}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-ink-muted">{describeRounding(r.mode, r.increment)}</span>
                    {canManage && (
                      <Button size="sm" variant="ghost" onClick={() => clear.mutate(r.siteId)} aria-label={`Use the organization’s rounding at ${r.siteName}`}>
                        Use the organization’s
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {canManage && free.length > 0 && (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Site" className="min-w-[12rem] flex-1">
                {(p) => (
                  <Select {...p} value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                    <option value="">Pick one…</option>
                    {free.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Rounding">
                {(p) => (
                  <Select {...p} value={siteMode} onChange={(e) => setSiteMode(e.target.value as RoundingMode)}>
                    {(['NONE', 'NEAREST', 'EMPLOYEE_FAVOR'] as RoundingMode[]).map((m) => (
                      <option key={m} value={m}>
                        {MODE_LABEL[m]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {siteMode !== 'NONE' && (
                <Field label="Minutes">
                  {(p) => (
                    <Select {...p} value={String(siteInc)} onChange={(e) => setSiteInc(Number(e.target.value))}>
                      <option value="5">5</option>
                      <option value="6">6</option>
                      <option value="15">15</option>
                    </Select>
                  )}
                </Field>
              )}
              <Button size="sm" variant="outline" disabled={!siteId} loading={save.isPending && !!siteId} onClick={() => save.mutate({ siteId, mode: siteMode, increment: siteInc })}>
                Add
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function OvertimeCard({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const term = useTerm();
  const tk = useQuery({ queryKey: ['labor-rules', 'timekeeping'], queryFn: getTimekeeping });
  const report = useQuery({ queryKey: ['labor-rules', 'ot-equalization'], queryFn: () => getOtEqualization(4) });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => setOtEqualization(enabled),
    onSuccess: (r) => {
      toast.success(r.otEqualization ? 'Overtime is now offered fewest-overtime-first.' : 'Overtime offers no longer follow the rotation.');
      void qc.invalidateQueries({ queryKey: ['labor-rules', 'timekeeping'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not change it.'),
  });
  const on = tk.data?.otEqualization ?? false;
  return (
    <Card>
      <CardContent className="space-y-4 p-4 sm:p-5">
        <SectionTitle as="h3" icon={Scale} title="Overtime, offered fairly" description="When an open shift would put someone into overtime, people who wouldn’t go over are asked first, then whoever has worked the least overtime in the last four weeks. Skipping someone needs a reason, and the record keeps it." />
        {tk.isError ? (
          <QueryError what="the overtime setting" query={tk} />
        ) : !tk.data ? (
          <SkeletonRows count={1} />
        ) : (
          <SegmentedControl<'on' | 'off'>
            ariaLabel="Offer overtime fewest-overtime-first"
            value={on ? 'on' : 'off'}
            onChange={(v) => canManage && toggle.mutate(v === 'on')}
            options={[
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
          />
        )}
        <div className="space-y-2 border-t border-line pt-4">
          <h4 className="text-sm font-semibold text-ink">How overtime was shared, last four weeks</h4>
          {report.isError ? (
            <QueryError what="the overtime report" query={report} />
          ) : !report.data ? (
            <SkeletonRows count={3} />
          ) : report.data.people.length === 0 ? (
            <EmptyState size="sm" icon={Scale} title="No approved time in the last four weeks" description="Once timesheets are approved, overtime per person shows here." />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <MetricCard label="Average overtime" value={`${report.data.averageOvertimeHours} h`} hint={`Per ${term('worker').toLowerCase()}, since ${fmtDate(parseYmd(report.data.since))}`} />
                <MetricCard label="Most minus least" value={`${report.data.spread} h`} hint="The gap the rotation narrows" />
              </div>
              <DataGrid<OtEqualizationRow>
                id="ot-equalization"
                caption="Overtime and offers per person"
                rows={report.data.people}
                rowKey={(r) => r.associateId}
                urlState={false}
                search={report.data.people.length > 10 ? { placeholder: 'Search people…' } : false}
                exportCsv={{ filename: 'overtime-equalization' }}
                columns={[
                  { key: 'name', header: 'Name', accessor: (r) => r.name, sortable: true, primary: true, className: 'font-medium text-ink' },
                  { key: 'ot', header: 'Overtime hours', accessor: (r) => r.overtimeHours, sortable: true, searchable: false, cardMeta: true },
                  { key: 'offered', header: 'Offered', accessor: (r) => r.offered, sortable: true, searchable: false },
                  { key: 'accepted', header: 'Took it', accessor: (r) => r.accepted, sortable: true, searchable: false },
                  { key: 'declined', header: 'Passed', accessor: (r) => r.declined, sortable: true, searchable: false },
                  { key: 'skipped', header: 'Skipped, with a reason', accessor: (r) => r.skipped, sortable: true, searchable: false },
                ]}
              />
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function LaborTimekeepingTab() {
  const { can } = useAuth();
  const canManage = can('manage:org');
  return (
    <div className="space-y-4">
      <RoundingCard canManage={canManage} />
      <OvertimeCard canManage={canManage} />
    </div>
  );
}

/* ----- Predictability pay ------------------------------------------------------ */

const CHANGE_LABEL: Record<ScheduleChangeRow['change'], string> = { added: 'Shift added', reduced: 'Hours cut', cancelled: 'Shift cancelled', moved: 'Shift moved' };
const EXEMPT_LABEL: Record<string, string> = {
  EMPLOYEE_REQUESTED: 'they asked for it',
  MUTUAL_SWAP: 'a swap they agreed to',
  VOLUNTARY_PICKUP: 'they picked it up',
  EMERGENCY: 'an emergency',
};

function premiumText(r: ScheduleChangeRow): string {
  const parts = [r.premiumCents ? fmtMoney(r.premiumCents / 100) : '', r.premiumHours ? `${r.premiumHours} h of pay` : ''].filter(Boolean);
  return parts.join(' + ') || '—';
}

function statusOf(r: ScheduleChangeRow): { label: string; variant: 'success' | 'pending' | 'outline' | 'info' } {
  if (r.exempt) return { label: `Not owed — ${EXEMPT_LABEL[r.exemptReason ?? ''] ?? 'excused'}`, variant: 'outline' };
  if (!r.live) return { label: 'Shadow only', variant: 'info' };
  if (r.paid) return { label: 'Paid', variant: 'success' };
  return { label: 'Owed next run', variant: 'pending' };
}

export function LaborScheduleChangesTab() {
  const { can } = useAuth();
  const canExcuse = can('manage:org') || can('process:payroll');
  const [excusing, setExcusing] = useState<ScheduleChangeRow | null>(null);
  const q = useQuery({ queryKey: ['labor-rules', 'schedule-changes'], queryFn: getScheduleChanges });
  if (q.isError) return <QueryError what="schedule changes" query={q} />;
  if (!q.data) return <SkeletonRows count={4} />;
  const owed = q.data.changes.filter((r) => r.live && !r.exempt && !r.paid);
  return (
    <div className="space-y-4">
      <SectionTitle
        icon={CalendarClock}
        title="Predictability pay"
        description={`Late changes to a published schedule where a fair-workweek law applies. ${owed.length === 0 ? 'Nothing owed right now.' : `${owed.length} premium${owed.length === 1 ? '' : 's'} will be paid on the next run.`} Changes made while the state’s rules are still being tested are kept as a record, not paid.`}
      />
      {q.data.changes.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState icon={CalendarClock} title="No late schedule changes" description={`When a published shift is added, moved, cut or cancelled inside the notice window at a site with a fair-workweek law, it shows here.`} />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <DataGrid<ScheduleChangeRow>
              id="schedule-change-premiums"
              caption="Late schedule changes and the premium each owes"
              rows={q.data.changes}
              rowKey={(r) => r.id}
              urlState={false}
              search={{ placeholder: 'Search people or places…' }}
              exportCsv={{ filename: 'predictability-pay' }}
              columns={[
                { key: 'name', header: 'Name', accessor: (r) => r.name, sortable: true, primary: true, className: 'font-medium text-ink' },
                { key: 'what', header: 'Change', accessor: (r) => CHANGE_LABEL[r.change], sortable: true, cardMeta: true },
                { key: 'when', header: 'Shift on', accessor: (r) => r.workDate, sortable: true, cell: (r) => fmtDate(parseYmd(r.workDate)) },
                { key: 'notice', header: 'Notice', accessor: (r) => r.noticeDays, sortable: true, searchable: false, cell: (r) => `${r.noticeDays.toFixed(1)} days` },
                { key: 'where', header: 'Site', accessor: (r) => r.siteName ?? '', sortable: true },
                { key: 'owed', header: 'Premium', accessor: (r) => r.premiumCents + r.premiumHours * 100, sortable: true, searchable: false, cell: premiumText },
                { key: 'status', header: 'Status', accessor: (r) => statusOf(r).label, sortable: true, cell: (r) => <Badge variant={statusOf(r).variant} size="sm">{statusOf(r).label}</Badge> },
                ...(canExcuse
                  ? [
                      {
                        key: 'act',
                        header: 'Actions',
                        accessor: () => '',
                        searchable: false,
                        cell: (r: ScheduleChangeRow) =>
                          r.paid ? null : (
                            <Button size="xs" variant="ghost" onClick={() => setExcusing(r)}>
                              {r.exempt ? 'Change reason' : 'Mark as exempt'}
                            </Button>
                          ),
                      },
                    ]
                  : []),
              ]}
            />
          </CardContent>
        </Card>
      )}
      {q.data.truncated && <p className="text-xs text-ink-muted">Showing the latest 200.</p>}
      {excusing && <ExemptDialog row={excusing} onClose={() => setExcusing(null)} />}
    </div>
  );
}

/**
 * Fair-workweek laws excuse a late change the worker asked for, a swap they
 * agreed to, a shift they picked up, or an emergency. Scheduling doesn't stop
 * to ask on every drag, so the reason is recorded here, with a note, before
 * payroll pays it — and it can be taken back.
 */
function ExemptDialog({ row, onClose }: { row: ScheduleChangeRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState<ExemptReason | ''>((row.exemptReason as ExemptReason | null) ?? '');
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: (exemptReason: ExemptReason | null) => setScheduleChangeExemption(row.id, { exemptReason, note: note.trim() || undefined }),
    onSuccess: (r) => {
      toast.success(r.exempt ? `${row.name}’s premium is excused.` : `${row.name}’s premium is owed again.`);
      void qc.invalidateQueries({ queryKey: ['labor-rules', 'schedule-changes'] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save that.'),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Why doesn’t {row.name} get the premium?</DialogTitle>
          <DialogDescription>
            {CHANGE_LABEL[row.change]} on {fmtDate(parseYmd(row.workDate))} with {row.noticeDays.toFixed(1)} days’ notice — {premiumText(row)}. Only the reasons the law allows
            excuse it, and the note stays on the record.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Reason" required>
            {(p) => (
              <Select {...p} value={reason} onChange={(e) => setReason(e.target.value as ExemptReason | '')}>
                <option value="">Choose a reason</option>
                <option value="EMPLOYEE_REQUESTED">They asked for the change</option>
                <option value="MUTUAL_SWAP">A swap they agreed to</option>
                <option value="VOLUNTARY_PICKUP">They picked the shift up</option>
                <option value="EMERGENCY">An emergency (threat, outage, act of nature)</option>
              </Select>
            )}
          </Field>
          <Field label="What happened" required hint="For example: asked by text on Tuesday to swap with Ana.">
            {(p) => <Textarea {...p} rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
        </div>
        <DialogFooter>
          {row.exempt && (
            <Button variant="ghost" onClick={() => save.mutate(null)} loading={save.isPending}>
              It’s owed after all
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => reason && save.mutate(reason)} disabled={!reason || note.trim().length < 3} loading={save.isPending}>
            Excuse the premium
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
