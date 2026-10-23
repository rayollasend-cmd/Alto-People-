import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Landmark, Scale } from 'lucide-react';
import { useAuth, useTerm } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtDateOnlyRange, fmtMoney, parseYmd } from '@/lib/format';
import { backToShadow, getChangeReport, getLaborActivations, getLaborLastRun, goLive, type ChangeReportPerson, type LaborActivation, type LaborJurisdiction, type LaborLastRun } from '@/lib/laborLiveApi';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Drawer,
  DrawerBody,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  Field,
  Input,
  MetricCard,
  SectionTitle,
  Select,
  SkeletonRows,
  Textarea,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { QueryError } from '@/components/ui/QueryError';

/**
 * Labor rules, state by state: testing (not paying yet), waiting on a second
 * person, or live. Each state's row leads with what its rules would have paid
 * on the last run. Going live shows what the last runs would have paid under
 * the state's rules, records counsel's sign-off and the attestation, and goes
 * to a second person. Turning it off is one click with a reason.
 */

const RULE_LABEL: Record<'OVERTIME' | 'MEAL' | 'REST' | 'REST_BETWEEN_SHIFTS' | 'SPREAD_OF_HOURS' | 'SPLIT_SHIFT', string> = {
  OVERTIME: 'Overtime and double time',
  MEAL: 'Meal premiums',
  REST: 'Rest premiums',
  REST_BETWEEN_SHIFTS: 'Rest between shifts',
  SPREAD_OF_HOURS: 'Spread of hours',
  SPLIT_SHIFT: 'Split shifts',
};

const signedMoney = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmtMoney(Math.abs(n))}`;

/** Only what isn't already in the Status column: who asked, who approved, and counsel. */
function StatusDetail({ j }: { j: LaborJurisdiction }) {
  const a = j.current;
  if (!a) return null;
  if (a.status === 'PENDING')
    return (
      <p className="mt-1 text-xs text-ink-muted">
        {a.requestedBy ? `Asked by ${a.requestedBy}. ` : ''}Counsel: {a.counselName}, {a.counselFirm}.
      </p>
    );
  return (
    <p className="mt-1 text-xs text-ink-muted">
      Since {a.activatedAt ? fmtDate(a.activatedAt) : 'today'}
      {a.activatedBy ? `, approved by ${a.activatedBy}` : ''}. Counsel: {a.counselName}, {a.counselFirm} (signed {fmtDate(parseYmd(a.counselSignedOn))}).
    </p>
  );
}

export const laborStatusLabel = (a: LaborActivation | null) => (!a ? 'Testing (not paying yet)' : a.status === 'PENDING' ? 'Waiting on approval' : 'Live');

function statusBadge(a: LaborActivation | null) {
  if (!a) return <Badge variant="outline">{laborStatusLabel(a)}</Badge>;
  if (a.status === 'PENDING') return <Badge variant="pending">{laborStatusLabel(a)}</Badge>;
  return <Badge variant="success">{laborStatusLabel(a)}</Badge>;
}

const sitesText = (n: number) => (n === 0 ? 'No sites yet' : `${n} site${n === 1 ? '' : 's'}`);

/** "Would have paid $120.00 more" — the number a state's row leads with. */
export function lastRunSentence(r: LaborLastRun | undefined, live: boolean): string {
  if (!r) return 'No finished run to test yet';
  if (r.replayed === 0) return 'Nobody here was on the last run';
  const d = r.amountDifference;
  if (Math.abs(d) < 0.005) return live ? 'No change last run' : 'Would have paid the same';
  const more = d > 0 ? 'more' : 'less';
  if (live) return d > 0 ? `Its rules added ${fmtMoney(d)} last run` : `Its rules paid ${fmtMoney(-d)} less last run`;
  return `Would have paid ${fmtMoney(Math.abs(d))} ${more}`;
}

type StateRow = LaborJurisdiction & { last?: LaborLastRun };

export function LaborGoLiveTab() {
  const { can } = useAuth();
  const canManage = can('manage:org');
  const q = useQuery({ queryKey: ['labor-rules', 'activations'], queryFn: getLaborActivations });
  // The replay is slower than the list; the grid shows first and the column fills in.
  const last = useQuery({ queryKey: ['labor-rules', 'last-run'], queryFn: getLaborLastRun });
  const [reviewing, setReviewing] = useState<LaborJurisdiction | null>(null);
  const [ending, setEnding] = useState<LaborActivation | null>(null);
  const rows = useMemo<StateRow[] | undefined>(() => {
    if (!q.data) return undefined;
    const byState = new Map((last.data?.states ?? []).map((r) => [r.jurisdiction, r]));
    // Where people work first: a state with no sites is listed, quietly, after them.
    return [...q.data.jurisdictions]
      .sort((a, b) => Number(b.sites.length > 0 || !!b.current) - Number(a.sites.length > 0 || !!a.current) || a.label.localeCompare(b.label))
      .map((j) => ({ ...j, last: byState.get(j.jurisdiction) }));
  }, [q.data, last.data]);

  if (q.isError) return <QueryError what="the go-live status" query={q} />;
  if (!q.data || !rows) return <SkeletonRows count={4} />;
  const live = q.data.jurisdictions.filter((j) => j.current?.status === 'LIVE').length;

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Paying by state rules"
        description={`${live === 0 ? 'No state pays by its own rules yet' : `${live} state${live === 1 ? '' : 's'} pay${live === 1 ? 's' : ''} by its own rules`}. Until a state goes live, its rules are tested beside each pay run and pay follows federal rules. Going live takes counsel’s sign-off and a second person; turning it off is immediate.`}
      />
      <DataGrid<StateRow>
        id="labor-go-live-states"
        caption="States with a rule pack"
        rows={rows}
        rowKey={(j) => j.jurisdiction}
        urlState={false}
        search={false}
        noun={{ one: 'state', many: 'states' }}
        columns={[
          {
            key: 'state',
            header: 'State',
            accessor: (j) => j.label,
            sortable: true,
            primary: true,
            cell: (j) => {
              const siteLive = j.sites.filter((s) => s.activation?.status === 'LIVE');
              return (
                <div className="min-w-0">
                  <span className="font-medium text-ink">{j.label}</span>
                  {siteLive.length > 0 && !j.current && <p className="mt-1 text-xs text-ink-muted">Live on its own: {siteLive.map((s) => s.name).join(', ')}.</p>}
                </div>
              );
            },
          },
          {
            key: 'status',
            header: 'Status',
            accessor: (j) => laborStatusLabel(j.current),
            sortable: true,
            cell: (j) => (
              <div className="min-w-0">
                {statusBadge(j.current)}
                <StatusDetail j={j} />
              </div>
            ),
          },
          { key: 'sites', header: 'Sites', accessor: (j) => j.sites.length, sortable: true, cardMeta: true, cell: (j) => sitesText(j.sites.length) },
          {
            key: 'last',
            header: 'Last test run',
            accessor: (j) => j.last?.amountDifference ?? null,
            csv: (j) => j.last?.amountDifference ?? '',
            sortable: true,
            cell: (j) =>
              j.sites.length === 0 ? (
                <span className="text-ink-muted">—</span>
              ) : last.isError ? (
                <span className="text-ink-muted">Couldn’t replay</span>
              ) : !last.data ? (
                <span className="text-ink-muted">Checking…</span>
              ) : (
                <div className="min-w-0" data-testid={`labor-last-${j.jurisdiction}`}>
                  <span className={j.last && Math.abs(j.last.amountDifference) >= 0.005 ? 'font-medium text-ink' : 'text-ink-muted'}>{lastRunSentence(j.last, j.current?.status === 'LIVE')}</span>
                  {j.last && (
                    <p className="mt-0.5 text-xs text-ink-muted">
                      {fmtDateOnlyRange(j.last.periodStart, j.last.periodEnd)}
                      {j.last.people > 0 ? ` · ${j.last.people} ${j.last.people === 1 ? 'person' : 'people'}` : ''}
                    </p>
                  )}
                </div>
              ),
          },
          ...(canManage
            ? [
                {
                  key: 'go',
                  header: 'Go-live',
                  accessor: () => null,
                  csv: () => '',
                  searchable: false,
                  stopRowClick: true,
                  cell: (j: StateRow) => {
                    const siteLive = j.sites.filter((s) => s.activation?.status === 'LIVE');
                    return (
                      <div className="flex flex-wrap gap-2">
                        {!j.current && (
                          <Button size="sm" variant={j.sites.length > 0 ? 'primary' : 'outline'} onClick={() => setReviewing(j)}>
                            Review and go live
                          </Button>
                        )}
                        {j.current?.status === 'PENDING' && (
                          <Button asChild size="sm" variant="outline">
                            <Link to="/approvals?tab=requests">Open the approval</Link>
                          </Button>
                        )}
                        {j.current && (
                          <Button size="sm" variant="ghost" onClick={() => setEnding(j.current)}>
                            {j.current.status === 'PENDING' ? 'Withdraw' : 'Stop paying by these rules'}
                          </Button>
                        )}
                        {siteLive.map((s) => (
                          <Button key={s.id} size="sm" variant="ghost" onClick={() => setEnding(s.activation)}>
                            {s.name}: stop
                          </Button>
                        ))}
                      </div>
                    );
                  },
                },
              ]
            : []),
        ]}
      />
      {reviewing && <GoLiveDrawer j={reviewing} attestation={q.data.attestation} onClose={() => setReviewing(null)} />}
      <EndDialog activation={ending} onClose={() => setEnding(null)} />
    </div>
  );
}

function GoLiveDrawer({ j, attestation, onClose }: { j: LaborJurisdiction; attestation: string; onClose: () => void }) {
  const qc = useQueryClient();
  const term = useTerm();
  const [siteId, setSiteId] = useState<string>('');
  const report = useQuery({ queryKey: ['labor-rules', 'change-report', j.jurisdiction, siteId], queryFn: () => getChangeReport(j.jurisdiction, siteId || null) });
  const [counselName, setCounselName] = useState('');
  const [counselFirm, setCounselFirm] = useState('');
  const [signedOn, setSignedOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [attested, setAttested] = useState(false);
  const valid = counselName.trim().length >= 2 && counselFirm.trim().length >= 2 && /^\d{4}-\d{2}-\d{2}$/.test(signedOn) && attested;
  const save = useMutation({
    mutationFn: () => goLive({ jurisdiction: j.jurisdiction, siteId: siteId || null, counselName, counselFirm, counselSignedOn: signedOn, attestation }),
    onSuccess: (r) => {
      toast.success(r.pending ? 'Sent for approval. A second person decides in Approvals.' : `${siteId ? 'This site' : j.label} now pays by ${j.label}’s rules.`);
      void qc.invalidateQueries({ queryKey: ['labor-rules'] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not go live.'),
  });
  const d = report.data;
  const byRule = useMemo(() => (d ? (Object.entries(d.byRule) as Array<[keyof typeof RULE_LABEL, number | undefined]>).filter((r): r is [keyof typeof RULE_LABEL, number] => r[1] != null && Math.abs(r[1]) >= 0.005 && r[0] in RULE_LABEL) : []), [d]);

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Go live in {j.label}</DrawerTitle>
        <DrawerDescription>What changes, what counsel signs, and who approves.</DrawerDescription>
      </DrawerHeader>
      <DrawerBody className="space-y-6">
        {j.sites.length > 0 && (
          <Field label="Where">
            {(p) => (
              <Select {...p} value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                <option value="">All of {j.label}</option>
                {j.sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    Only {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}

        <section aria-labelledby="what-changes" className="space-y-3">
          <SectionTitle id="what-changes" as="h3" title="What would have changed" description="The last pay runs, replayed under these rules. Nothing is paid until this goes live." />
          {report.isError ? (
            <QueryError what="the change report" query={report} />
          ) : !d ? (
            <SkeletonRows count={3} />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <MetricCard label="People affected" value={String(d.people)} hint={`Over ${d.runs.length} pay run${d.runs.length === 1 ? '' : 's'}`} />
                <MetricCard label="Pay change" value={signedMoney(d.amountDifference)} hint={d.premiumAmount ? `${fmtMoney(d.premiumAmount)} of it premiums` : 'No premiums'} />
              </div>
              {d.runs.length === 0 ? (
                <p className="text-sm text-ink-muted">No finalized pay runs to replay yet — the rules will still apply from the first run after going live.</p>
              ) : d.rows.length === 0 ? (
                <p className="text-sm text-ink-muted">Nobody would have been paid differently in these runs.</p>
              ) : (
                <>
                  {byRule.length > 0 && (
                    <ul className="space-y-1 text-sm" aria-label="Change by rule">
                      {byRule.map(([k, v]) => (
                        <li key={k} className="flex justify-between gap-3 border-b border-line py-1">
                          <span className="text-ink-muted">{RULE_LABEL[k]}</span>
                          <span className="tabular-nums text-ink">{signedMoney(v)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <DataGrid<ChangeReportPerson>
                    id="labor-go-live-report"
                    caption={`Who would have been paid differently in ${j.label}`}
                    rows={d.rows}
                    rowKey={(r) => r.associateId}
                    urlState={false}
                    search={d.rows.length > 8 ? { placeholder: `Search ${term('workers').toLowerCase()}…` } : false}
                    exportCsv={{ filename: `labor-go-live-${j.jurisdiction}` }}
                    columns={[
                      { key: 'name', header: 'Name', accessor: (r) => r.name, sortable: true, primary: true, className: 'font-medium text-ink' },
                      { key: 'paid', header: 'Paid', accessor: (r) => r.paid, sortable: true, searchable: false, cell: (r) => fmtMoney(r.paid) },
                      { key: 'live', header: 'Under these rules', accessor: (r) => r.live, sortable: true, searchable: false, cell: (r) => fmtMoney(r.live) },
                      { key: 'diff', header: 'Change', accessor: (r) => r.difference, sortable: true, searchable: false, cardMeta: true, cell: (r) => <span className="tabular-nums">{signedMoney(r.difference)}</span> },
                      { key: 'prem', header: 'Premium hours', accessor: (r) => r.premiumHours, sortable: true, searchable: false },
                    ]}
                  />
                </>
              )}
              <section aria-labelledby="what-signs" className="space-y-2">
                <h4 id="what-signs" className="text-sm font-semibold text-ink">What counsel signs</h4>
                <ul className="space-y-2">
                  {d.signables.map((s) => (
                    <li key={s.id} className="rounded-md border border-line p-3 text-sm">
                      <div className="font-medium text-ink">{s.label}</div>
                      <p className="mt-1 text-xs text-ink-muted">{s.source}</p>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-ink-muted">These exact versions are pinned. A newer version is not paid until it’s signed again.</p>
              </section>
            </>
          )}
        </section>

        <section aria-labelledby="sign-off" className="space-y-3">
          <SectionTitle id="sign-off" as="h3" title="Counsel’s sign-off" />
          <Field label="Counsel’s name" required>
            {(p) => <Input {...p} value={counselName} maxLength={120} onChange={(e) => setCounselName(e.target.value)} autoComplete="off" />}
          </Field>
          <Field label="Firm or role" required hint="For example, “Whit & Co LLP” or “General counsel”.">
            {(p) => <Input {...p} value={counselFirm} maxLength={160} onChange={(e) => setCounselFirm(e.target.value)} autoComplete="off" />}
          </Field>
          <Field label="Signed on" required>
            {(p) => <Input {...p} type="date" value={signedOn} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setSignedOn(e.target.value)} />}
          </Field>
          <label className="flex items-start gap-3 rounded-md border border-line p-3 text-sm text-ink coarse:min-h-11">
            <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 coarse:h-6 coarse:w-6" checked={attested} onChange={(e) => setAttested(e.target.checked)} />
            <span>{attestation}</span>
          </label>
          <p className="text-xs text-ink-muted">A second person with organization admin rights approves this in Approvals. If nobody else could, it goes live now and the record says so.</p>
        </section>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => save.mutate()} disabled={!valid} loading={save.isPending}>
          <Scale className="h-4 w-4" aria-hidden="true" />
          Submit for approval
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function EndDialog({ activation, onClose }: { activation: LaborActivation | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const end = useMutation({
    mutationFn: () => backToShadow(activation!.id, reason.trim()),
    onSuccess: () => {
      toast.success(activation?.status === 'PENDING' ? 'Withdrawn.' : 'Turned off. The next pay run uses federal rules here.');
      setReason('');
      void qc.invalidateQueries({ queryKey: ['labor-rules'] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not change it.'),
  });
  return (
    <Dialog open={!!activation} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{activation?.status === 'PENDING' ? 'Withdraw this go-live?' : 'Stop paying by these rules?'}</DialogTitle>
          <DialogDescription>
            {activation?.status === 'PENDING'
              ? 'The approval request is cancelled.'
              : 'From the next pay run, people here are paid by federal rules again. Runs already finalized don’t change.'}
          </DialogDescription>
        </DialogHeader>
        <Field label="Why" required hint="Kept on the record.">
          {(p) => <Textarea {...p} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Keep it
          </Button>
          <Button variant="destructive" onClick={() => end.mutate()} disabled={reason.trim().length < 3} loading={end.isPending}>
            {activation?.status === 'PENDING' ? 'Withdraw' : 'Stop paying by these rules'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function NoLiveStates() {
  return <EmptyState icon={Landmark} title="No rule packs yet" description="State rule packs ship with citations; once one covers a state where you work, it appears here." />;
}
