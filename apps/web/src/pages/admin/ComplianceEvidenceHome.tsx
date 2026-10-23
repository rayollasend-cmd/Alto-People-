import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { CONTROL_STATUSES, CONTROL_STATUS_LABELS, ROLE_LABELS, controlStatusOf, type ComplianceControlView, type ControlStatus, type EvidenceRow } from '@alto-people/shared';
import { controlStatusBadge } from '@/components/trust/TrustBlocks';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { getComplianceEvidence, getControlHistory, signOffEvidence } from '@/lib/complianceEvidenceApi';
import { fmtDateTime } from '@/lib/format';
import { useUrlParam } from '@/lib/useUrlState';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { AccessReviewPanel } from './AccessReviewPanel';
import { SecurityContactCard } from './SecurityContactCard';

const EVIDENCE_STATUS_LABEL: Record<string, string> = { PASS: 'Passed', FAIL: 'Failed', WARN: 'Needs attention' };

/**
 * IS EVERY SOC 2 CONTROL PRODUCING CURRENT EVIDENCE? (Brief 2-5; F500 G4)
 *
 * Status first: the four statuses as tiles that filter the table (the
 * Trust Center counts the same way). Then the controls — each with what it
 * means, its latest result and, when it isn't passing, what to do. The
 * security contact, a setting, sits last. Evidence is append-only; a
 * sign-off is its own row.
 */

/** A control's status: the one vocabulary the Trust Center shows too (controlStatusOf). */
const statusOfRow = (c: ComplianceControlView): ControlStatus => c.status ?? controlStatusOf(c);

const age = (d: number | null) => (d === null ? '—' : d === 0 ? 'Today' : d === 1 ? '1 day' : `${d} days`);

const STATUS_FILTERS = ['all', ...CONTROL_STATUSES] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];
const TILE_TONE: Record<ControlStatus, 'good' | 'warning' | 'alert' | 'neutral'> = { PASSING: 'good', NEEDS_SIGNOFF: 'warning', FAILING: 'alert', NO_EVIDENCE: 'neutral' };
const TILE_HINT: Record<ControlStatus, string> = {
  PASSING: 'Latest evidence passed inside its window, signed off where needed',
  NEEDS_SIGNOFF: 'Evidence is in; a named person must sign it off',
  FAILING: 'The latest evidence failed, or warned where no one signs off',
  NO_EVIDENCE: 'Nothing collected yet, or the latest is past its window',
};

export function ComplianceEvidenceHome() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['compliance-evidence', 'overview'], queryFn: getComplianceEvidence });
  const [openId, setOpenId] = useUrlParam<string>('control', '');
  const [status, setStatus] = useUrlParam<StatusFilter>('status', 'all', STATUS_FILTERS);
  const controls = useMemo(() => q.data?.controls ?? [], [q.data]);
  const total = controls.length;
  const byStatus = useMemo(() => {
    const out: Record<ControlStatus, number> = { PASSING: 0, NEEDS_SIGNOFF: 0, FAILING: 0, NO_EVIDENCE: 0 };
    for (const c of controls) out[statusOfRow(c)] += 1;
    return out;
  }, [controls]);
  const shown = useMemo(() => (status === 'all' ? controls : controls.filter((c) => statusOfRow(c) === status)), [controls, status]);
  const open = controls.find((c) => c.id === openId) ?? null;

  const columns: GridColumn<ComplianceControlView>[] = [
    {
      key: 'title',
      header: 'Control',
      accessor: (c) => c.title,
      sortable: true,
      primary: true,
      className: 'md:w-[35%]',
      cell: (c) => (
        <div className="min-w-0">
          <div className="font-medium text-ink">{c.title}</div>
          <div className="text-xs text-ink-muted">{c.plain}</div>
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
      className: 'md:w-[45%]',
      cell: (c) => {
        const s = statusOfRow(c);
        return (
          <div className="min-w-0">
            {c.latest ? <span>{c.latest.summary}</span> : <span className="text-ink-muted">Not collected yet</span>}
            {s !== 'PASSING' && (
              <button
                type="button"
                className="mt-1 block text-xs font-medium text-accent hover:underline"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenId(c.id);
                }}
              >
                What to do →
              </button>
            )}
          </div>
        );
      },
    },
    { key: 'age', header: 'Age', accessor: (c) => c.ageDays ?? Number.POSITIVE_INFINITY, sortable: true, align: 'right', cell: (c) => age(c.ageDays) },
    { key: 'window', header: 'Window', accessor: (c) => c.freshnessDays, sortable: true, align: 'right', defaultHidden: true, cell: (c) => `${c.freshnessDays} d` },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Compliance evidence"
        subtitle="Every SOC 2 control, its latest evidence and how old it is. Evidence is recorded by the jobs and scripts that run each control and cannot be edited. The Trust Center counts the same way."
      />
      {q.isError ? <QueryError what="compliance evidence" query={q} /> : null}

      {q.isError ? null : q.isPending ? (
        <Skeleton className="h-24" />
      ) : q.data ? (
        <MetricStrip label="Controls by status">
          {CONTROL_STATUSES.map((s) => (
            <MetricCard
              key={s}
              label={CONTROL_STATUS_LABELS[s]}
              value={s === 'PASSING' ? `${byStatus[s]} of ${total}` : byStatus[s]}
              hint={TILE_HINT[s]}
              tone={byStatus[s] > 0 ? TILE_TONE[s] : 'neutral'}
              selected={status === s}
              onClick={() => setStatus(status === s ? 'all' : s)}
            />
          ))}
        </MetricStrip>
      ) : null}

      {!q.isError && (
      <DataGrid<ComplianceControlView>
        id="compliance-evidence"
        caption="Controls"
        noun={{ one: 'control', many: 'controls' }}
        rows={q.data ? shown : null}
        columns={columns}
        rowKey={(c) => c.id}
        loading={q.isPending}
        urlState={false}
        urlKey="controls"
        exportCsv={false}
        search={{ placeholder: 'Search controls' }}
        activeFilters={status === 'all' ? 0 : 1}
        onClearFilters={() => setStatus('all')}
        empty={{ icon: ShieldCheck, title: 'No controls', description: 'The control catalog is empty.' }}
        onRowClick={(c) => setOpenId(c.id)}
        rowActionLabel={(c) => `Open ${c.title}`}
      />
      )}

      <SecurityContactCard canManage={can('manage:org')} />
      {open && <ControlDialog control={open} onClose={() => setOpenId('')} />}
    </div>
  );
}

/** One control: what it means, how it is checked, what to do, its history, and the sign-off where it needs one. */
function ControlDialog({ control, onClose }: { control: ComplianceControlView; onClose: () => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const history = useQuery({ queryKey: ['compliance-evidence', 'history', control.id], queryFn: () => getControlHistory(control.id) });
  const [note, setNote] = useState('');
  const latest: EvidenceRow | null = history.data?.evidence[0] ?? control.latest;
  const canSign = can('manage:org') && control.needsSignoff && !!latest && latest.signoffs.length === 0;
  const status = statusOfRow(control);

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
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {control.title} {controlStatusBadge(status)}
          </DialogTitle>
          <DialogDescription>{control.plain}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {status !== 'PASSING' && (
            <section aria-label="What to do" className="rounded-md border border-line bg-surface-raised px-3 py-2 text-sm">
              <div className="text-xs font-medium uppercase tracking-[0.14em] text-ink-muted">What to do</div>
              <p className="mt-1 text-ink">{control.remedy}</p>
              <p className="mt-1 text-xs text-ink-muted">
                Owner: {ROLE_LABELS[control.ownerRole]}
                {control.remedyHref && !control.remedyHref.startsWith('/admin/compliance-evidence') && (
                  <>
                    {' · '}
                    <Link to={control.remedyHref} className="font-medium text-accent hover:underline" onClick={onClose}>
                      Go there →
                    </Link>
                  </>
                )}
              </p>
            </section>
          )}
          <details className="text-sm text-ink-muted">
            <summary className="cursor-pointer select-none hover:text-ink">How it’s checked</summary>
            <p className="mt-1">{control.how}</p>
            <p className="mt-1 text-xs">
              Criteria {control.criteria.join(', ')} · evidence counts for {control.freshnessDays} {control.freshnessDays === 1 ? 'day' : 'days'}
            </p>
          </details>
          {/* Brief 2-5 step 6: the review this control signs off. */}
          {control.id === 'access-review' && can('manage:org') && <AccessReviewPanel />}
          {history.isPending ? (
            <Skeleton className="h-24" />
          ) : history.isError ? (
            <QueryError what="evidence history" query={history} />
          ) : (history.data?.evidence.length ?? 0) === 0 ? (
            <EmptyState size="sm" title="No evidence recorded yet" />
          ) : (
            <ul className="divide-y divide-line text-sm">
              {history.data!.evidence.slice(0, 20).map((e) => (
                <li key={e.id} className="py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={e.status === 'PASS' ? 'success' : e.status === 'FAIL' ? 'destructive' : 'pending'}>{EVIDENCE_STATUS_LABEL[e.status] ?? e.status}</Badge>
                    <span className="text-ink-muted">{fmtDateTime(e.collectedAt)}</span>
                    <span className="text-xs text-ink-muted">by {e.collectedBy}</span>
                  </div>
                  <div className="mt-1">{e.summary}</div>
                  {e.signoffs.map((s) => (
                    <div key={s.id} className="mt-1 text-xs text-ink-muted">
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
