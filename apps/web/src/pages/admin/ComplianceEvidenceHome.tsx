import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { CONTROL_STATUS_LABELS, controlStatusOf, type ComplianceControlView, type ControlStatus, type EvidenceRow } from '@alto-people/shared';
import { controlStatusBadge } from '@/components/trust/TrustBlocks';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { getComplianceEvidence, getControlHistory, signOffEvidence } from '@/lib/complianceEvidenceApi';
import { fmtDateTime } from '@/lib/format';

const EVIDENCE_STATUS_LABEL: Record<string, string> = { PASS: 'Passing', FAIL: 'Failing', WARN: 'Needs attention' };
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryError } from '@/components/ui/QueryError';
import { AccessReviewPanel } from './AccessReviewPanel';
import { SecurityContactCard } from './SecurityContactCard';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * IS EVERY SOC 2 CONTROL PRODUCING CURRENT EVIDENCE? (Brief 2-5)
 *
 * One hero, the controls with current evidence out of the catalog, and the
 * catalog behind it: each control's state, its latest result and how old
 * it is against the control's own window. A control with no collector yet
 * shows as "No evidence" — the page is the to-do list until every row is
 * current. Evidence is append-only; a sign-off is its own row.
 */

/**
 * A control's status: the one vocabulary the Trust Center shows too
 * (packages/shared complianceEvidence.ts controlStatusOf) — Passing,
 * Needs sign-off, Failing, No evidence (F500 SH-4).
 */
const statusOfRow = (c: ComplianceControlView): ControlStatus => c.status ?? controlStatusOf(c);

const age = (d: number | null) => (d === null ? '—' : d === 0 ? 'Today' : d === 1 ? '1 day' : `${d} days`);

const COLUMNS: GridColumn<ComplianceControlView>[] = [
  {
    key: 'title',
    header: 'Control',
    accessor: (c) => c.title,
    sortable: true,
    primary: true,
    cell: (c) => (
      <div>
        <div className="font-medium text-white">{c.title}</div>
        <div className="text-xs text-silver">{c.criteria.join(', ')}</div>
      </div>
    ),
  },
  {
    key: 'state',
    header: 'Status',
    accessor: (c) => CONTROL_STATUS_LABELS[statusOfRow(c)],
    sortable: true,
    cardMeta: true,
    cell: (c) => controlStatusBadge(statusOfRow(c)),
  },
  {
    key: 'latest',
    header: 'Latest result',
    accessor: (c) => c.latest?.summary ?? '',
    className: 'text-sm',
    cell: (c) => (c.latest ? <span>{c.latest.summary}</span> : <span className="text-silver">Collected from step {c.step}</span>),
  },
  { key: 'age', header: 'Age', accessor: (c) => c.ageDays ?? Number.POSITIVE_INFINITY, sortable: true, align: 'right', cell: (c) => age(c.ageDays) },
  { key: 'window', header: 'Window', accessor: (c) => c.freshnessDays, sortable: true, align: 'right', defaultHidden: true, cell: (c) => `${c.freshnessDays} d` },
];

export function ComplianceEvidenceHome() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['compliance-evidence', 'overview'], queryFn: getComplianceEvidence });
  const [open, setOpen] = useState<ComplianceControlView | null>(null);
  const controls = useMemo(() => q.data?.controls ?? [], [q.data]);
  const total = controls.length;
  // The Trust Center's count: controls PASSING by the one status.
  const byStatus = useMemo(() => {
    const out: Record<ControlStatus, number> = { PASSING: 0, NEEDS_SIGNOFF: 0, FAILING: 0, NO_EVIDENCE: 0 };
    for (const c of controls) out[statusOfRow(c)] += 1;
    return out;
  }, [controls]);
  const passing = byStatus.PASSING;
  const attention = byStatus.NEEDS_SIGNOFF + byStatus.FAILING + byStatus.NO_EVIDENCE;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Compliance evidence"
        subtitle="Every SOC 2 control, its latest evidence and how old it is. Evidence is recorded by the jobs and scripts that run each control and cannot be edited."
        breadcrumbs={[{ label: 'Settings & trust', to: '/admin' }, { label: 'Compliance evidence' }]}
      />
      {q.isError ? <QueryError what="compliance evidence" query={q} /> : null}
      <SecurityContactCard canManage={can('manage:org')} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-gold" aria-hidden="true" />
            Controls passing
          </CardTitle>
          <CardDescription>A control passes when its latest evidence passed inside its window and, where it needs one, is signed off. The Trust Center counts the same way.</CardDescription>
        </CardHeader>
        <CardContent>
          {q.isPending ? (
            <Skeleton className="h-24" />
          ) : (
            <MetricCard
              label="Passing"
              value={`${passing} of ${total}`}
              hint={
                attention > 0
                  ? `${byStatus.FAILING} failing · ${byStatus.NEEDS_SIGNOFF} need sign-off · ${byStatus.NO_EVIDENCE} no evidence`
                  : 'Every control is passing'
              }
              accent={attention > 0}
            />
          )}
        </CardContent>
      </Card>

      <DataGrid<ComplianceControlView>
        id="compliance-evidence"
        caption="Controls"
        rows={controls}
        columns={COLUMNS}
        rowKey={(c) => c.id}
        loading={q.isPending}
        urlState={false}
        exportCsv={false}
        search={{ placeholder: 'Search controls' }}
        empty={{ icon: ShieldCheck, title: 'No controls', description: 'The control catalog is empty.' }}
        onRowClick={(c) => setOpen(c)}
        rowActionLabel={(c) => `Open ${c.title}`}
      />
      {open && <ControlDialog control={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** One control: how it is collected, its history, and the sign-off where it needs one. */
function ControlDialog({ control, onClose }: { control: ComplianceControlView; onClose: () => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const history = useQuery({ queryKey: ['compliance-evidence', 'history', control.id], queryFn: () => getControlHistory(control.id) });
  const [note, setNote] = useState('');
  const latest: EvidenceRow | null = history.data?.evidence[0] ?? control.latest;
  const canSign = can('manage:org') && control.needsSignoff && !!latest && latest.signoffs.length === 0;

  const sign = useMutation({
    mutationFn: () => signOffEvidence(latest!.id, note.trim() ? { note: note.trim() } : {}),
    onSuccess: async () => {
      toast.success('Signed off.');
      setNote('');
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['compliance-evidence', 'overview'] }),
        qc.invalidateQueries({ queryKey: ['compliance-evidence', 'history', control.id] }),
      ]);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not sign off.'),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && !sign.isPending && onClose()} confirmDiscard={note.trim().length > 0}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{control.title}</DialogTitle>
          <DialogDescription>{control.how}</DialogDescription>
        </DialogHeader>
        {/* Brief 2-5 step 6: the review this control signs off. */}
        {control.id === 'access-review' && can('manage:org') && <AccessReviewPanel />}
        <div className="space-y-4">
          {history.isPending ? (
            <Skeleton className="h-24" />
          ) : history.isError ? (
            <QueryError what="evidence history" query={history} />
          ) : (history.data?.evidence.length ?? 0) === 0 ? (
            <p className="text-sm text-silver">No evidence recorded yet. Its collector is built in step {control.step} of Brief 2-5.</p>
          ) : (
            <ul className="divide-y divide-navy-secondary/60 text-sm">
              {history.data!.evidence.slice(0, 20).map((e) => (
                <li key={e.id} className="py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={e.status === 'PASS' ? 'success' : e.status === 'FAIL' ? 'destructive' : 'pending'}>{EVIDENCE_STATUS_LABEL[e.status] ?? e.status}</Badge>
                    <span className="text-silver">{fmtDateTime(e.collectedAt)}</span>
                    <span className="text-xs text-silver">by {e.collectedBy}</span>
                  </div>
                  <div className="mt-1">{e.summary}</div>
                  {e.signoffs.map((s) => (
                    <div key={s.id} className="mt-1 text-xs text-silver">
                      Signed off by {s.signedOffByEmail ?? 'a former user'} on {fmtDateTime(s.createdAt)}
                      {s.note ? `: ${s.note}` : ''}
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          )}
          {canSign && (
            <Field label="Sign-off note" hint="Optional. Recorded with your name; the evidence itself never changes.">
              {(p) => <Textarea {...p} value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={1000} />}
            </Field>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={sign.isPending}>
            Close
          </Button>
          {canSign && (
            <Button onClick={() => sign.mutate()} loading={sign.isPending} disabled={sign.isPending}>
              Sign off the latest evidence
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
