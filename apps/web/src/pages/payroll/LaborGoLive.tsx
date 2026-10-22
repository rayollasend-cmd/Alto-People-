import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Landmark, Scale } from 'lucide-react';
import { useAuth, useTerm } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtMoney, parseYmd } from '@/lib/format';
import { backToShadow, getChangeReport, getLaborActivations, goLive, type ChangeReportPerson, type LaborActivation, type LaborJurisdiction } from '@/lib/laborLiveApi';
import {
  Badge,
  Button,
  Card,
  CardContent,
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
 * Labor rules, state by state: shadow, waiting on a second person, or live.
 * Going live shows what the last runs would have paid under the state's rules,
 * records counsel's sign-off and the attestation, and goes to a second person.
 * Back to shadow is one click with a reason.
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

function StatusLine({ j }: { j: LaborJurisdiction }) {
  const a = j.current;
  if (!a) return <p className="text-sm text-ink-muted">Paid by federal rules. {j.label}’s rules run in shadow beside each pay run.</p>;
  if (a.status === 'PENDING')
    return (
      <p className="text-sm text-ink-muted">
        Waiting on a second person{a.requestedBy ? ` — asked by ${a.requestedBy}` : ''}. Counsel: {a.counselName}, {a.counselFirm}.
      </p>
    );
  return (
    <p className="text-sm text-ink-muted">
      Paying by {j.label}’s rules since {a.activatedAt ? fmtDate(a.activatedAt) : 'today'}
      {a.activatedBy ? `, approved by ${a.activatedBy}` : ''}. Counsel: {a.counselName}, {a.counselFirm} (signed {fmtDate(parseYmd(a.counselSignedOn))}).
    </p>
  );
}

function statusBadge(a: LaborActivation | null) {
  if (!a) return <Badge variant="outline">In shadow</Badge>;
  if (a.status === 'PENDING') return <Badge variant="pending">Waiting on approval</Badge>;
  return <Badge variant="success">Live</Badge>;
}

export function LaborGoLiveTab() {
  const { can } = useAuth();
  const term = useTerm();
  const canManage = can('manage:org');
  const q = useQuery({ queryKey: ['labor-rules', 'activations'], queryFn: getLaborActivations });
  const [reviewing, setReviewing] = useState<LaborJurisdiction | null>(null);
  const [ending, setEnding] = useState<LaborActivation | null>(null);

  if (q.isError) return <QueryError what="the go-live status" query={q} />;
  if (!q.data) return <SkeletonRows count={4} />;
  const live = q.data.jurisdictions.filter((j) => j.current?.status === 'LIVE').length;

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Paying by state rules"
        description={`${live === 0 ? 'No state pays by its own rules yet' : `${live} state${live === 1 ? '' : 's'} pay${live === 1 ? 's' : ''} by its own rules`}. A state goes live with counsel’s sign-off and a second person; going back to shadow is immediate.`}
      />
      <ul className="space-y-3" aria-label="States with a rule pack">
        {/* Where people work first: a state with no stores is listed, quietly, after them. */}
        {[...q.data.jurisdictions].sort((a, b) => Number(b.sites.length > 0 || !!b.current) - Number(a.sites.length > 0 || !!a.current) || a.label.localeCompare(b.label)).map((j) => {
          const siteLive = j.sites.filter((s) => s.activation?.status === 'LIVE');
          return (
            <li key={j.jurisdiction}>
              <Card>
                <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Landmark className="h-4 w-4 text-ink-muted" aria-hidden="true" />
                      <h3 className="text-base font-semibold text-ink">{j.label}</h3>
                      {statusBadge(j.current)}
                      <span className="text-xs text-ink-muted">
                        {j.sites.length === 0 ? `No ${term('label.stores').toLowerCase()} here yet` : `${j.sites.length} ${j.sites.length === 1 ? term('label.store').toLowerCase() : term('label.stores').toLowerCase()}`}
                      </span>
                    </div>
                    <StatusLine j={j} />
                    {siteLive.length > 0 && !j.current && (
                      <p className="text-xs text-ink-muted">
                        Live on its own: {siteLive.map((s) => s.name).join(', ')}.
                      </p>
                    )}
                  </div>
                  {canManage && (
                    <div className="flex shrink-0 flex-wrap gap-2">
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
                          {j.current.status === 'PENDING' ? 'Withdraw' : 'Back to shadow'}
                        </Button>
                      )}
                      {siteLive.map((s) => (
                        <Button key={s.id} size="sm" variant="ghost" onClick={() => setEnding(s.activation)}>
                          {s.name}: back to shadow
                        </Button>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ul>
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
      toast.success(activation?.status === 'PENDING' ? 'Withdrawn.' : 'Back to shadow. The next pay run uses federal rules here.');
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
          <DialogTitle>{activation?.status === 'PENDING' ? 'Withdraw this go-live?' : 'Go back to shadow?'}</DialogTitle>
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
            {activation?.status === 'PENDING' ? 'Withdraw' : 'Back to shadow'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function NoLiveStates() {
  return <EmptyState icon={Landmark} title="No rule packs yet" description="State rule packs ship with citations; once one covers a state where you work, it appears here." />;
}
