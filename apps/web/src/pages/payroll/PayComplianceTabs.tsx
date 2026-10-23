import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bell, Download, FileSignature, PiggyBank, ScrollText, Send, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useConfirm, usePrompt } from '@/lib/confirm';
import { fmtDate, fmtMoney, parseYmd } from '@/lib/format';
import {
  downloadNewHireFile,
  fileNewHireReports,
  getNewHireSettings,
  getRothCatchUp,
  getWageStatementRules,
  listNewHireReports,
  listPayNotices,
  markNewHireReportsSubmitted,
  remindPayNotice,
  ROTH_STATUS_LABEL,
  setNewHireSettings,
  type NewHireReportRow,
  type PayNotice,
  type RothCatchUpRow,
  type RothCatchUpStatus,
} from '@/lib/payComplianceApi';
import { Badge, Button, Card, CardContent, EmptyState, ErrorBanner, Field, SectionTitle, Select, SkeletonRows } from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';

/**
 * The 2026 pay-compliance tabs of Payroll → Compliance: state new-hire
 * reports (per hire and state, with each state's deadline), state pay
 * notices and their signatures, the Roth catch-up rule with the year's
 * limits, and what each state requires on a paystub.
 */

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback);

const STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO',
  'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
];

/* ===== New-hire reporting ================================================= */

export function NewHireReportsTab() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const auth = useAuth();
  const canExport = auth.can('export:payroll-pii');
  const canSetMultistate = auth.can('manage:org');
  const reportsQ = useQuery({ queryKey: ['pay-compliance', 'new-hire'], queryFn: listNewHireReports });
  const settingsQ = useQuery({ queryKey: ['pay-compliance', 'new-hire-settings'], queryFn: getNewHireSettings });
  const [busyState, setBusyState] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['pay-compliance', 'new-hire'] });

  const rows = reportsQ.data?.reports ?? null;
  const due = useMemo(() => (rows ?? []).filter((r) => r.status === 'DUE'), [rows]);
  const byState = useMemo(() => {
    const m = new Map<string, NewHireReportRow[]>();
    for (const r of due) m.set(r.state, [...(m.get(r.state) ?? []), r]);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [due]);

  const multistate = useMutation({
    mutationFn: (s: string | null) => setNewHireSettings(s),
    onSuccess: () => {
      toast.success('Reporting state saved. New hires report there from now on.');
      void qc.invalidateQueries({ queryKey: ['pay-compliance'] });
    },
    onError: (e) => toast.error(errText(e, 'Could not save.')),
  });

  const downloadAndMark = async (state: string, list: NewHireReportRow[]) => {
    const ready = list.filter((r) => r.blockedBy.length === 0);
    if (ready.length === 0) return;
    setBusyState(state);
    try {
      const ids = await downloadNewHireFile(state);
      const ok = await confirm({
        title: `Did you upload the ${state} file?`,
        description: `It has ${ids.length} hire${ids.length === 1 ? '' : 's'} and contains Social Security numbers. Upload it to the ${state} new-hire portal, delete your copy, then confirm here to mark them reported.`,
        confirmLabel: 'Mark reported',
      });
      if (!ok) return;
      const confirmation = await prompt({
        title: 'Confirmation number',
        description: 'The number the state portal gave you, if any.',
        reasonLabel: 'Confirmation number',
        reasonPlaceholder: 'Optional',
        reasonMaxLength: 120,
        required: false,
        confirmLabel: 'Mark reported',
      });
      const res = await markNewHireReportsSubmitted(ids, confirmation?.trim() || null);
      toast.success(`${res.marked} hire${res.marked === 1 ? '' : 's'} marked reported to ${state}.`);
      refresh();
    } catch (e) {
      toast.error(errText(e, 'Download failed.'));
    } finally {
      setBusyState(null);
    }
  };

  const fileThroughService = async (state: string) => {
    setBusyState(state);
    try {
      const res = await fileNewHireReports(state);
      toast.success(`Filed ${res.filed} hire${res.filed === 1 ? '' : 's'} with ${state}. Confirmation ${res.confirmation}.`);
      refresh();
    } catch (e) {
      toast.error(errText(e, 'Filing failed.'));
    } finally {
      setBusyState(null);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0 max-w-xl space-y-2 text-sm text-ink-muted">
            {/* One line up front; the rule's detail behind "Learn more". */}
            <details className="group">
              <summary className="cursor-pointer list-none text-ink [&::-webkit-details-marker]:hidden">
                Report each new hire to the state within 20 days.{' '}
                <span className="text-accent underline underline-offset-2 group-open:hidden">Learn more</span>
              </summary>
              <p className="mt-1">
                Some states want it sooner; each state’s deadline is beside it below. An employer in more than one state may report everyone to one state
                after telling the federal Office of Child Support Services which.
              </p>
            </details>
            {reportsQ.data?.filing && (
              <p className="flex flex-wrap items-center gap-2 text-xs" data-testid="new-hire-filing-status">
                <Badge variant={reportsQ.data.filing.kind === 'ELECTRONIC' ? 'success' : 'default'}>
                  {reportsQ.data.filing.kind === 'ELECTRONIC' ? 'Files electronically' : 'Manual upload'}
                </Badge>
                <span>{reportsQ.data.filing.note}</span>
              </p>
            )}
          </div>
          {canSetMultistate && (
            <Field label="Report every hire to one state" hint="Leave on “Each worker’s state” unless you registered as a multistate employer.">
              <Select
                value={settingsQ.data?.multistateState ?? ''}
                disabled={!settingsQ.data || multistate.isPending}
                onChange={(e) => multistate.mutate(e.target.value || null)}
              >
                <option value="">Each worker’s state</option>
                {STATES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </CardContent>
      </Card>

      {reportsQ.error && (
        <ErrorBanner action={<Button size="sm" variant="secondary" onClick={refresh}>Retry</Button>}>{errText(reportsQ.error, 'Could not load new-hire reports.')}</ErrorBanner>
      )}
      {!rows && !reportsQ.error && <SkeletonRows count={4} rowHeight="h-12" />}

      {rows && due.length === 0 && (
        <EmptyState icon={UserPlus} title="No reports due" description="Every new hire has been reported to the state." />
      )}

      {byState.map(([state, list]) => {
        const ready = list.filter((r) => r.blockedBy.length === 0).length;
        const service = list[0]?.filingService ?? null;
        const employerGaps = employerGapsOf(list);
        return (
          <Card key={state}>
            <CardContent>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
                  <span className="font-display text-lg text-ink">{state}</span>
                  <span>
                    {list.length} due · {ready} ready
                  </span>
                  {list.some((r) => r.overdue) && (
                    <Badge variant="destructive">
                      <AlertTriangle className="mr-1 h-3 w-3" aria-hidden />
                      {list.filter((r) => r.overdue).length} late
                    </Badge>
                  )}
                  <span className="text-xs">
                    Deadline {list[0]?.deadlineDays ?? 20} days{list[0]?.confirmDeadlineWithState ? ' (confirm with the state)' : ''}
                  </span>
                </div>
                {canExport ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {ready === 0 && <span className="text-xs text-ink-muted" data-testid={`new-hire-why-${state}`}>No reports ready: fix the missing details first.</span>}
                    {service && (
                      <Button size="sm" onClick={() => void fileThroughService(state)} loading={busyState === state} disabled={!!busyState || ready === 0}>
                        <Send className="h-4 w-4" aria-hidden /> File with {service}
                      </Button>
                    )}
                    <Button size="sm" variant={service ? 'secondary' : 'primary'} onClick={() => void downloadAndMark(state, list)} loading={!service && busyState === state} disabled={!!busyState || ready === 0}>
                      <Download className="h-4 w-4" aria-hidden /> Download file
                    </Button>
                  </div>
                ) : (
                  <span className="text-xs text-ink-muted">Filing is restricted to HR and Finance.</span>
                )}
              </div>
              {/* An employer's missing EIN or address blocks every hire it employs: said once, here. */}
              {employerGaps.map((g) => (
                <p key={g.id} role="status" className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-warning/30 bg-warning/[0.06] px-3 py-2 text-sm text-ink" data-testid="new-hire-employer-gap">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                  <span>{employerGapSentence(g)}</span>
                  <Link to="/admin/employers" className="font-medium text-accent underline underline-offset-2">
                    Open employers
                  </Link>
                </p>
              ))}
              <DataGrid<NewHireReportRow>
                id={`new-hire-${state}`}
                caption={`New-hire reports due in ${state}`}
                rows={list}
                rowKey={(r) => r.id}
                urlState={false}
                columns={[
                  { key: 'name', header: 'Employee', accessor: (r) => r.name, sortable: true, primary: true, className: 'font-medium text-ink' },
                  // Labelled fields on a phone card ("Hired", "Due"), not two bare dates side by side.
                  { key: 'hire', header: 'Hired', accessor: (r) => r.hireDate, sortable: true, className: 'whitespace-nowrap text-ink-muted', cell: (r) => (r.hireDate ? fmtDate(parseYmd(r.hireDate)) : '—') },
                  { key: 'due', header: 'Due', accessor: (r) => r.dueDate, sortable: true, className: 'whitespace-nowrap text-ink-muted', cell: (r) => (r.dueDate ? fmtDate(parseYmd(r.dueDate)) : '—') },
                  {
                    key: 'status',
                    header: 'Status',
                    accessor: (r) => newHireRowStatus(r),
                    cell: (r) => {
                      const missing = personGapText(r);
                      if (missing) {
                        return (
                          <span className="inline-flex flex-wrap items-center gap-1.5">
                            {r.overdue && <Badge variant="destructive">Late</Badge>}
                            <span className="text-sm text-warning">{missing}</span>
                          </span>
                        );
                      }
                      if (r.blockedBy.length) return <span className="text-sm text-ink-muted">Waiting on the employer’s details</span>;
                      return r.overdue ? <Badge variant="destructive">Late</Badge> : <Badge variant="default">Ready</Badge>;
                    },
                  },
                ]}
              />
            </CardContent>
          </Card>
        );
      })}

    </div>
  );
}

/** "Missing SSN, address": the person's own gaps, short — the employer's are said once above the list. */
export function personGapText(r: Pick<NewHireReportRow, 'missing' | 'blockedBy'>): string | null {
  const person = r.missing?.person ?? legacyPersonGaps(r.blockedBy);
  if (person.length === 0) return null;
  return `Missing ${person.map((g) => (g === 'ssn' ? 'SSN' : 'address')).join(', ')}`;
}

function newHireRowStatus(r: NewHireReportRow): string {
  const missing = personGapText(r);
  if (missing) return missing;
  if (r.blockedBy.length) return 'Waiting on the employer’s details';
  return r.overdue ? 'Late' : 'Ready';
}

/** An API without the split (older build): read the person's gaps from the words. */
function legacyPersonGaps(blockedBy: string[]): Array<'ssn' | 'address'> {
  const out: Array<'ssn' | 'address'> = [];
  if (blockedBy.some((b) => /SSN/i.test(b))) out.push('ssn');
  if (blockedBy.some((b) => /^Home address/i.test(b))) out.push('address');
  return out;
}

interface EmployerGaps {
  id: string;
  name: string;
  gaps: Array<'ein' | 'address'>;
}

/** Each employer whose own record blocks these hires, with what it lacks — once, however many hires it blocks. */
export function employerGapsOf(rows: NewHireReportRow[]): EmployerGaps[] {
  const by = new Map<string, EmployerGaps>();
  for (const r of rows) {
    const gaps = r.missing?.employer ?? [];
    if (gaps.length === 0 || !r.employer) continue;
    const had = by.get(r.employer.id) ?? { id: r.employer.id, name: r.employer.name, gaps: [] };
    for (const g of gaps) if (!had.gaps.includes(g)) had.gaps.push(g);
    by.set(r.employer.id, had);
  }
  return [...by.values()];
}

/** "Alto HR's EIN and business address are missing." */
export function employerGapSentence(g: Pick<EmployerGaps, 'name' | 'gaps'>): string {
  const what = g.gaps.map((x) => (x === 'ein' ? 'EIN' : 'business address'));
  const list = what.length === 2 ? `${what[0]} and ${what[1]}` : what[0]!;
  return `${g.name}’s ${list} ${what.length === 1 ? 'is' : 'are'} missing, so no hire it employs can be reported.`;
}

/* ===== Pay notices ======================================================== */

export function PayNoticesTab() {
  const q = useQuery({ queryKey: ['pay-compliance', 'notices'], queryFn: listPayNotices });
  const remind = useMutation({
    mutationFn: (id: string) => remindPayNotice(id),
    onSuccess: () => toast.success('Reminder sent.'),
    onError: (e) => toast.error(errText(e, 'Could not send the reminder.')),
  });
  const rows = q.data?.notices ?? null;
  const unsigned = (rows ?? []).filter((n) => n.status === 'SENT');

  return (
    <Card>
      <CardContent>
        <p className="mb-3 max-w-2xl text-sm text-silver">
          New York, California, Illinois and Washington require a written notice of pay rate and payday at hire. New York, California and Illinois
          also require one when the rate changes. Notices go out automatically and the employee signs in the app.
        </p>
        {q.error && <ErrorBanner action={<Button size="sm" variant="secondary" onClick={() => void q.refetch()}>Retry</Button>}>{errText(q.error, 'Could not load pay notices.')}</ErrorBanner>}
        {!rows && !q.error && <SkeletonRows count={4} rowHeight="h-12" />}
        {rows && rows.length === 0 && (
          <EmptyState icon={FileSignature} title="No pay notices yet" description="They appear when someone in NY, CA, IL or WA is hired or gets a new rate." />
        )}
        {rows && rows.length > 0 && (
          <>
            <div className="mb-2 text-sm text-silver">
              <span className="font-medium text-ink">{unsigned.length}</span> waiting for a signature
            </div>
            <DataGrid<PayNotice>
              id="pay-notices"
              caption="State pay notices"
              rows={rows}
              rowKey={(n) => n.id}
              urlState={false}
              search={{ placeholder: 'Name, state, form…' }}
              columns={[
                { key: 'name', header: 'Employee', accessor: (n) => n.name, sortable: true, primary: true, className: 'font-medium text-ink' },
                { key: 'form', header: 'Notice', accessor: (n) => n.formTitle, sortable: true, cardMeta: true, className: 'text-silver' },
                { key: 'trigger', header: 'Why', accessor: (n) => n.trigger, cardMeta: true, className: 'text-silver', cell: (n) => (n.trigger === 'HIRE' ? 'Hire' : n.trigger === 'RATE_CHANGE' ? 'Rate change' : 'Sent by HR') },
                { key: 'sent', header: 'Sent', accessor: (n) => n.sentAt, sortable: true, className: 'whitespace-nowrap text-silver', cell: (n) => fmtDate(new Date(n.sentAt)) },
                {
                  key: 'status',
                  header: 'Status',
                  accessor: (n) => n.status,
                  sortable: true,
                  cell: (n) => (
                    <div className="flex flex-wrap gap-1">
                      {n.status === 'ACKNOWLEDGED' ? <Badge variant="success">Signed</Badge> : n.overdue ? <Badge variant="destructive">Not signed after 7 days</Badge> : <Badge variant="pending">Waiting</Badge>}
                      {n.missing.length > 0 && <Badge variant="pending" title={n.missing.join(', ')}>Missing facts</Badge>}
                      {n.untranslatedLanguage && <Badge variant="info">English only</Badge>}
                    </div>
                  ),
                },
                {
                  key: 'actions',
                  header: '',
                  accessor: () => '',
                  searchable: false,
                  cell: (n) => (
                    <div className="flex gap-2">
                      <a className="text-sm text-gold underline-offset-2 hover:underline" href={`/api/pay-compliance/pay-notices/${n.id}/pdf`} target="_blank" rel="noreferrer">
                        PDF
                      </a>
                      {n.status === 'SENT' && (
                        <button type="button" className="inline-flex items-center gap-1 text-sm text-gold underline-offset-2 hover:underline" onClick={() => remind.mutate(n.id)}>
                          <Bell className="h-3.5 w-3.5" aria-hidden /> Remind
                        </button>
                      )}
                    </div>
                  ),
                },
              ]}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* ===== Roth catch-up and limits ========================================== */

const ROTH_VARIANT: Record<RothCatchUpStatus, 'default' | 'success' | 'pending' | 'destructive' | 'info'> = {
  NOT_ELIGIBLE: 'default',
  AGE_UNKNOWN: 'pending',
  PRE_TAX_OR_ROTH: 'success',
  ROTH_BY_ELECTION: 'info',
  ROTH_DEEMED: 'info',
  CATCH_UP_STOPPED: 'destructive',
};

export function RothCatchUpTab() {
  const q = useQuery({ queryKey: ['pay-compliance', 'roth'], queryFn: () => getRothCatchUp() });
  const l = q.data?.limits;
  const rows = q.data?.people ?? null;
  const shown = (rows ?? []).filter((r) => r.status !== 'NOT_ELIGIBLE');
  return (
    <div className="space-y-4">
      {l && (
        <Card>
          <CardContent>
            <SectionTitle title={`${l.year} limits${l.fallback ? ' (this year’s figures are not published yet; last year’s apply)' : ''}`} />
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              {[
                ['401(k) / 403(b)', l.deferral402g],
                ['Catch-up, 50+', l.catchUp50],
                ['Catch-up, ages 60–63', l.superCatchUp60to63],
                ['HSA, family', l.hsaFamily],
                ['HSA, self-only', l.hsaSelf],
                ['Health FSA', l.healthFsa],
                ['Dependent care FSA', l.dependentCareFsa],
                ['Roth catch-up wage line', l.rothCatchUpWageThreshold],
              ].map(([label, v]) => (
                <div key={label as string}>
                  <dt className="text-xs text-silver">{label}</dt>
                  <dd className="tabular-nums text-ink">{fmtMoney(v as number)}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-silver">
              From {l.year}, anyone 50 or older whose Social Security wages here last year were over {fmtMoney(l.rothCatchUpWageThreshold)} must make
              catch-up contributions as Roth. Payroll does this automatically where the plan allows; otherwise the catch-up stops and the pre-run check says so.
            </p>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardContent>
          {q.error && <ErrorBanner action={<Button size="sm" variant="secondary" onClick={() => void q.refetch()}>Retry</Button>}>{errText(q.error, 'Could not load.')}</ErrorBanner>}
          {!rows && !q.error && <SkeletonRows count={4} rowHeight="h-12" />}
          {rows && shown.length === 0 && (
            <EmptyState icon={PiggyBank} title="Nobody is eligible for catch-up" description="People 50 and older with a 401(k) or 403(b) show here." />
          )}
          {shown.length > 0 && (
            <DataGrid<RothCatchUpRow>
              id="roth-catch-up"
              caption="Catch-up contributions"
              rows={shown}
              rowKey={(r) => `${r.associateId}:${r.plan}`}
              urlState={false}
              search={{ placeholder: 'Name, plan…' }}
              columns={[
                { key: 'name', header: 'Employee', accessor: (r) => r.name, sortable: true, primary: true, className: 'font-medium text-ink' },
                { key: 'plan', header: 'Plan', accessor: (r) => r.plan, sortable: true, cardMeta: true, className: 'text-silver' },
                { key: 'age', header: 'Age at year end', accessor: (r) => r.age ?? -1, sortable: true, className: 'tabular-nums text-silver', cell: (r) => (r.age ?? '—') },
                {
                  key: 'wages',
                  header: 'Last year’s Social Security wages',
                  accessor: (r) => r.priorYearFicaWages ?? -1,
                  sortable: true,
                  className: 'tabular-nums text-silver',
                  cell: (r) => (r.priorYearFicaWages == null ? '—' : fmtMoney(r.priorYearFicaWages)),
                },
                { key: 'status', header: 'Catch-up', accessor: (r) => r.status, sortable: true, cell: (r) => <Badge variant={ROTH_VARIANT[r.status]}>{ROTH_STATUS_LABEL[r.status]}</Badge> },
              ]}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ===== Paystub rules ====================================================== */

export function PaystubRulesTab() {
  const q = useQuery({ queryKey: ['pay-compliance', 'rules'], queryFn: getWageStatementRules });
  return (
    <Card>
      <CardContent>
        <p className="mb-3 max-w-2xl text-sm text-silver">
          What each state requires on a paystub. Before a run is finalized, the checks warn about anyone whose paystub would be missing something, such as
          the employer’s address or phone, or a paid sick leave balance.
        </p>
        {q.error && <ErrorBanner action={<Button size="sm" variant="secondary" onClick={() => void q.refetch()}>Retry</Button>}>{errText(q.error, 'Could not load.')}</ErrorBanner>}
        {!q.data && !q.error && <SkeletonRows count={4} rowHeight="h-12" />}
        {q.data && (
          <ul className="grid gap-3 sm:grid-cols-2">
            {q.data.rules.map((r) => (
              <li key={r.state} className="rounded-lg border border-navy-secondary p-3">
                <div className="mb-1 flex items-center gap-2">
                  <ScrollText className="h-4 w-4 text-gold" aria-hidden />
                  <span className="font-medium text-ink">{r.state}</span>
                  <span className="text-xs text-silver">{r.citation}</span>
                </div>
                <p className="text-sm text-silver">{r.elements.map((e) => e.label).join(' · ')}</p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
