import { useEffect, useState } from 'react';
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
import { hasCapability } from '@/lib/roles';
import {
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
  Input,
  PageHeader,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';

const STATUS_VARIANT: Record<
  ProbationStatus,
  'success' | 'pending' | 'destructive' | 'outline'
> = {
  ACTIVE: 'pending',
  PASSED: 'success',
  EXTENDED: 'outline',
  FAILED: 'destructive',
};

export function ProbationHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:onboarding') : false;
  const [summary, setSummary] = useState<ProbationSummary | null>(null);
  const [rows, setRows] = useState<ProbationRow[] | null>(null);
  const [filter, setFilter] = useState<ProbationStatus | 'ALL'>('ACTIVE');
  const [showNew, setShowNew] = useState(false);
  const [decideRow, setDecideRow] = useState<ProbationRow | null>(null);
  const [extendRow, setExtendRow] = useState<ProbationRow | null>(null);

  const refresh = () => {
    setRows(null);
    listProbations(filter === 'ALL' ? undefined : filter)
      .then((r) => setRows(r.probations))
      .catch(() => setRows([]));
    getProbationSummary()
      .then(setSummary)
      .catch(() => setSummary(null));
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

      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          {(['ACTIVE', 'PASSED', 'EXTENDED', 'FAILED', 'ALL'] as const).map(
            (s) => (
              <Button
                key={s}
                size="sm"
                variant={filter === s ? 'primary' : 'ghost'}
                onClick={() => setFilter(s)}
              >
                {s}
              </Button>
            ),
          )}
        </div>
        {canManage && (
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> Start probation
          </Button>
        )}
      </div>

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
                  <TableHead>Period</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Decision</TableHead>
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
                          {p.associateName}
                        </div>
                        <div className="text-xs text-silver">
                          {p.currentTitle ?? p.associateEmail}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-silver">
                        {p.startDate} → {p.endDate}
                        {overdue && (
                          <Badge variant="destructive" className="ml-2">
                            Overdue
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[p.status]}>
                          {p.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-silver max-w-xs truncate">
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
      ? 'text-destructive'
      : tone === 'warn'
        ? 'text-amber-400'
        : 'text-white';
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <Icon className={`h-5 w-5 ${toneClass}`} />
        <div>
          <div className="text-xs uppercase tracking-wider text-silver">
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
  const [associateId, setAssociateId] = useState('');
  const [startDate, setStartDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [endDate, setEndDate] = useState(
    new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  );
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!associateId.trim()) {
      toast.error('Associate ID required.');
      return;
    }
    setSaving(true);
    try {
      await startProbation({
        associateId: associateId.trim(),
        startDate,
        endDate,
      });
      toast.success('Probation started.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
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
          <Label>Associate ID</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={associateId}
            onChange={(e) => setAssociateId(e.target.value)}
          />
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
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
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
          Period: {row.startDate} → {row.endDate}
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
          <textarea
            className="mt-1 w-full h-32 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm"
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

  const submit = async () => {
    setSaving(true);
    try {
      await extendProbation(row.id, { newEndDate, notes: notes.trim() || null });
      toast.success('Probation extended.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
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
          Current period: {row.startDate} → {row.endDate}
        </div>
        <div>
          <Label>New end date</Label>
          <Input
            type="date"
            className="mt-1"
            value={newEndDate}
            onChange={(e) => setNewEndDate(e.target.value)}
          />
        </div>
        <div>
          <Label>Reason</Label>
          <textarea
            className="mt-1 w-full h-24 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm"
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
