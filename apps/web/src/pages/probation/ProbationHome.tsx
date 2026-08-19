import { useEffect, useState } from 'react';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { CheckCircle2, Clock, Plus, ShieldQuestion, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  decideProbation,
  extendProbation,
  getProbationSummary,
  listProbations,
  startProbation,
  type ProbationRow,
  type ProbationStatus,
  type ProbationSummary,
} from '@/lib/probation116Api';
import { useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/format';
import { hasCapability } from '@/lib/roles';
import {
  AssociatePicker,
  type PickedAssociate,
  Badge,
  Button,
  Card,
  CardContent,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  ErrorBanner,
  Input,
  PageHeader,
  SegmentedControl,
  Skeleton,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
import { StatusBadge } from '@/lib/status';

// Deliberate departures from the shared vocabulary (visible per the status
// contract): an ACTIVE probation is a watch state, not a healthy one, so it
// reads amber instead of the canonical green. EXTENDED is domain-only — the
// original period ended without a decision, rendered muted.
const PROBATION_STATUS_TONES = { ACTIVE: 'pending', EXTENDED: 'outline' } as const;

/** Parse a YYYY-MM-DD string as a local date (no timezone shift). */
function parseLocalDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function ProbationHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:onboarding') : false;
  const [summary, setSummary] = useState<ProbationSummary | null>(null);
  const [summaryFailed, setSummaryFailed] = useState(false);
  const [rows, setRows] = useState<ProbationRow[] | null>(null);
  const [filter, setFilter] = useState<ProbationStatus | 'ALL'>('ACTIVE');
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [decideRow, setDecideRow] = useState<ProbationRow | null>(null);
  const [extendRow, setExtendRow] = useState<ProbationRow | null>(null);

  const refresh = () => {
    setError(null);
    setRows(null);
    listProbations(filter === 'ALL' ? undefined : filter)
      .then((r) => setRows(r.probations))
      .catch((err) => {
        setRows([]);
        setError(
          err instanceof ApiError ? err.message : 'Failed to load probations.',
        );
      });
    getProbationSummary()
      .then(setSummary)
      .catch(() => {
        setSummary(null);
        setSummaryFailed(true);
      });
  };
  useEffect(() => {
    refresh();
  }, [filter]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Probation"
        subtitle="Track new-hire probation periods. Pass, extend, or fail before the end date."
        breadcrumbs={[{ label: 'Workforce' }, { label: 'Probation' }]}
      />

      {/* Reserve the strip while loading (it used to pop in and shove the
          page down); on failure say so quietly instead of vanishing —
          an absent row read as "zero probations". */}
      {!summary && !summaryFailed && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-[76px] rounded-lg" />
          ))}
        </div>
      )}
      {summaryFailed && !summary && (
        <p className="text-xs text-silver/70">
          Couldn&apos;t load the summary counts — the list below is unaffected.
        </p>
      )}
      {summary && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <KpiCard label="Active" value={String(summary.active)} icon={Clock} />
          <KpiCard
            label="Ending in 14 days"
            value={String(summary.endingSoon)}
            icon={Clock}
            tone={summary.endingSoon > 0 ? 'warn' : undefined}
          />
          <KpiCard
            label="Overdue"
            value={String(summary.overdue)}
            icon={ShieldQuestion}
            tone={summary.overdue > 0 ? 'bad' : undefined}
          />
          <KpiCard
            label="Passed (90d)"
            value={String(summary.passedLast90Days)}
            icon={CheckCircle2}
          />
          <KpiCard
            label="Failed (90d)"
            value={String(summary.failedLast90Days)}
            icon={XCircle}
          />
        </div>
      )}

      <div className="flex items-center justify-between flex-wrap gap-2">
        <SegmentedControl
          ariaLabel="Filter by probation status"
          options={[
            { value: 'ACTIVE', label: 'Active' },
            { value: 'PASSED', label: 'Passed' },
            { value: 'EXTENDED', label: 'Extended' },
            { value: 'FAILED', label: 'Failed' },
            { value: 'ALL', label: 'All' },
          ]}
          value={filter}
          onChange={setFilter}
        />
        {canManage && (
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> Start probation
          </Button>
        )}
      </div>

      {error && (
        <ErrorBanner
          action={
            <Button size="sm" variant="secondary" onClick={refresh}>
              Retry
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      )}

      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6">
              <SkeletonRows count={4} />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={ShieldQuestion}
              title="No probations"
              description={
                filter === 'ACTIVE'
                  ? 'No active probations. Start one when a new hire begins.'
                  : 'Nothing matches this filter.'
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Associate</TableHead>
                  <TableHead className="hidden md:table-cell">Period</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden lg:table-cell">Decision</TableHead>
                  {canManage && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => {
                  const overdue =
                    p.status === 'ACTIVE' && new Date(p.endDate) < new Date();
                  return (
                    <TableRow key={p.id} className="group">
                      <TableCell>
                        <div className="font-medium text-white">
                          <AssociateLink associateId={p.associateId}>
                            {p.associateName}
                          </AssociateLink>
                        </div>
                        <div className="text-xs text-silver">
                          {p.currentTitle ?? p.associateEmail}
                        </div>
                        <div className="text-xs2 text-silver/70 md:hidden">
                          {fmtDate(parseLocalDate(p.startDate))} →{' '}
                          {fmtDate(parseLocalDate(p.endDate))}
                          {overdue && ' · Overdue'}
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm text-silver">
                        {fmtDate(parseLocalDate(p.startDate))} →{' '}
                        {fmtDate(parseLocalDate(p.endDate))}
                        {overdue && (
                          <Badge variant="destructive" className="ml-2">
                            Overdue
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={p.status} overrides={PROBATION_STATUS_TONES} />
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-xs text-silver max-w-xs truncate">
                        {p.decision ?? '—'}
                      </TableCell>
                      {canManage && (
                        <TableCell className="text-right space-x-2">
                          {p.status === 'ACTIVE' && (
                            <>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setExtendRow(p)}
                              >
                                Extend
                              </Button>
                              <Button
                                size="sm"
                                onClick={() => setDecideRow(p)}
                              >
                                Decide
                              </Button>
                            </>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {showNew && (
        <NewProbationDrawer
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
      {decideRow && (
        <DecideDrawer
          row={decideRow}
          onClose={() => setDecideRow(null)}
          onSaved={() => {
            setDecideRow(null);
            refresh();
          }}
        />
      )}
      {extendRow && (
        <ExtendDrawer
          row={extendRow}
          onClose={() => setExtendRow(null)}
          onSaved={() => {
            setExtendRow(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function KpiCard({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: 'warn' | 'bad';
}) {
  const toneClass =
    tone === 'bad'
      ? 'text-alert'
      : tone === 'warn'
        ? 'text-warning'
        : 'text-white';
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <Icon className={`h-5 w-5 ${toneClass}`} />
        <div>
          <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">
            {label}
          </div>
          <div className={`text-2xl font-semibold mt-0.5 ${toneClass}`}>
            {value}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function NewProbationDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [assoc, setAssoc] = useState<PickedAssociate | null>(null);
  const [startDate, setStartDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [endDate, setEndDate] = useState(
    new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  );
  const [saving, setSaving] = useState(false);

  const start = parseLocalDate(startDate);
  const end = parseLocalDate(endDate);
  const durationDays =
    start && end
      ? Math.round((end.getTime() - start.getTime()) / MS_PER_DAY)
      : null;

  const submit = async () => {
    if (!assoc) {
      toast.error('Pick an associate.');
      return;
    }
    setSaving(true);
    try {
      await startProbation({
        associateId: assoc.id,
        startDate,
        endDate,
      });
      toast.success('Probation started.');
      onSaved();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Could not start probation.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Start probation</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Associate</Label>
          <div className="mt-1">
            <AssociatePicker value={assoc} onChange={setAssoc} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Start date</Label>
            <Input
              type="date"
              className="mt-1"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div>
            <Label>End date</Label>
            <Input
              type="date"
              className="mt-1"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
        </div>
        {end && durationDays !== null && durationDays > 0 && (
          <div className="text-xs text-silver">
            {durationDays} days, ends {fmtDate(end)}
          </div>
        )}
        <div className="text-xs text-silver">
          Default is 90 days. Adjust to your company's policy.
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Start'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function DecideDrawer({
  row,
  onClose,
  onSaved,
}: {
  row: ProbationRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [decision, setDecision] = useState<'PASSED' | 'FAILED'>('PASSED');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      await decideProbation(row.id, { decision, notes: notes.trim() || null });
      toast.success(decision === 'PASSED' ? 'Probation passed.' : 'Probation failed.');
      onSaved();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Could not save the decision.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Decide probation — {row.associateName}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="text-sm text-silver">
          Period: {fmtDate(parseLocalDate(row.startDate))} →{' '}
          {fmtDate(parseLocalDate(row.endDate))}
        </div>
        <div>
          <Label>Decision</Label>
          <div className="flex gap-2 mt-1">
            <Button
              variant={decision === 'PASSED' ? 'primary' : 'ghost'}
              onClick={() => setDecision('PASSED')}
            >
              <CheckCircle2 className="mr-2 h-4 w-4" /> Pass
            </Button>
            <Button
              variant={decision === 'FAILED' ? 'destructive' : 'ghost'}
              onClick={() => setDecision('FAILED')}
            >
              <XCircle className="mr-2 h-4 w-4" /> Fail
            </Button>
          </div>
        </div>
        <div>
          <Label>Notes</Label>
          <Textarea
            className="mt-1 h-32"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Why this decision — performance highlights, concerns, etc."
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Save decision'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function ExtendDrawer({
  row,
  onClose,
  onSaved,
}: {
  row: ProbationRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [newEndDate, setNewEndDate] = useState(
    new Date(new Date(row.endDate).getTime() + 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10),
  );
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const origEnd = parseLocalDate(row.endDate);
  const newEnd = parseLocalDate(newEndDate);
  const deltaDays =
    origEnd && newEnd
      ? Math.round((newEnd.getTime() - origEnd.getTime()) / MS_PER_DAY)
      : null;

  const submit = async () => {
    setSaving(true);
    try {
      await extendProbation(row.id, { newEndDate, notes: notes.trim() || null });
      toast.success('Probation extended.');
      onSaved();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Could not extend probation.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Extend probation — {row.associateName}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="text-sm text-silver">
          Current period: {fmtDate(parseLocalDate(row.startDate))} →{' '}
          {fmtDate(parseLocalDate(row.endDate))}
        </div>
        <div>
          <Label>New end date</Label>
          <Input
            type="date"
            className="mt-1"
            value={newEndDate}
            onChange={(e) => setNewEndDate(e.target.value)}
          />
          {deltaDays !== null && deltaDays !== 0 && (
            <div className="mt-1 text-xs text-silver">
              {deltaDays > 0 ? `+${deltaDays}` : deltaDays} days vs. original end
            </div>
          )}
        </div>
        <div>
          <Label>Reason</Label>
          <Textarea
            className="mt-1 h-24"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Why extend — what needs to improve…"
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Extend'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
