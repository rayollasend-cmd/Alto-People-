import { useEffect, useMemo, useState } from 'react';
import { Crown, Plus, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  createSuccessionCandidate,
  deleteSuccessionCandidate,
  getSuccessionPosition,
  getSuccessionSummary,
  listSuccessionPositions,
  READINESS_LABELS,
  type SuccessionPositionDetail,
  type SuccessionPositionRow,
  type SuccessionReadiness,
  type SuccessionSummary,
  updateSuccessionCandidate,
} from '@/lib/succession115Api';
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

const READINESS_VARIANT: Record<
  SuccessionReadiness,
  'success' | 'pending' | 'outline' | 'accent'
> = {
  READY_NOW: 'success',
  READY_1_2_YEARS: 'pending',
  READY_3_PLUS_YEARS: 'outline',
  EMERGENCY_COVER: 'accent',
};

export function SuccessionHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:performance') : false;
  const [rows, setRows] = useState<SuccessionPositionRow[] | null>(null);
  const [summary, setSummary] = useState<SuccessionSummary | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const refresh = () => {
    setRows(null);
    listSuccessionPositions()
      .then((r) => setRows(r.positions))
      .catch(() => setRows([]));
    getSuccessionSummary()
      .then(setSummary)
      .catch(() => setSummary(null));
  };
  useEffect(() => {
    refresh();
  }, []);

  const filtered = useMemo(() => {
    if (!rows) return null;
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.code.toLowerCase().includes(q) ||
        (r.clientName ?? '').toLowerCase().includes(q) ||
        (r.departmentName ?? '').toLowerCase().includes(q),
    );
  }, [rows, filter]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Succession planning"
        subtitle="Designate successors for each position. Track who's ready now, in 1–2 years, or beyond."
        breadcrumbs={[{ label: 'Performance' }, { label: 'Succession' }]}
      />

      {summary && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiCard label="Positions" value={String(summary.positionCount)} />
          <KpiCard
            label="With successor"
            value={`${summary.positionsWithSuccessor} / ${summary.positionCount}`}
            sub={`${summary.coverage}% coverage`}
          />
          <KpiCard
            label="Ready now"
            value={String(summary.byReadiness.READY_NOW)}
          />
          <KpiCard
            label="Emergency cover"
            value={String(summary.byReadiness.EMERGENCY_COVER)}
          />
        </div>
      )}

      <div className="flex justify-end">
        <Input
          placeholder="Filter positions, codes, departments…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="max-w-sm"
        />
      </div>

      <Card>
        <CardContent className="p-0">
          {filtered === null ? (
            <div className="p-6">
              <SkeletonRows count={4} />
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Crown}
              title="No positions"
              description="Create positions in Org structure first; once they exist you can name successors here."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Position</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Incumbent</TableHead>
                  <TableHead>Successors</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((p) => (
                  <TableRow
                    key={p.id}
                    className="group cursor-pointer"
                    onClick={() => setOpenId(p.id)}
                  >
                    <TableCell>
                      <div className="font-medium text-white">{p.title}</div>
                      <div className="text-xs text-silver font-mono">{p.code}</div>
                    </TableCell>
                    <TableCell className="text-sm text-silver">
                      {p.departmentName ?? '—'}
                    </TableCell>
                    <TableCell className="text-sm">
                      {p.incumbent ? (
                        p.incumbent.name
                      ) : (
                        <span className="text-silver">Vacant</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {p.successorCount === 0 ? (
                        <Badge variant="outline">None</Badge>
                      ) : (
                        <Badge variant="success">
                          {p.successorCount} named
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenId(p.id);
                        }}
                      >
                        Manage
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {openId && (
        <PositionDrawer
          positionId={openId}
          canManage={canManage}
          onClose={() => {
            setOpenId(null);
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
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wider text-silver">{label}</div>
        <div className="text-2xl font-semibold text-white mt-1">{value}</div>
        {sub && <div className="text-xs text-silver mt-1">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function PositionDrawer({
  positionId,
  canManage,
  onClose,
}: {
  positionId: string;
  canManage: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<SuccessionPositionDetail | null>(null);
  const [adding, setAdding] = useState(false);

  const refresh = () => {
    setData(null);
    getSuccessionPosition(positionId)
      .then(setData)
      .catch(() => setData(null));
  };
  useEffect(() => {
    refresh();
  }, [positionId]);

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{data?.position.title ?? 'Loading…'}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {!data ? (
          <SkeletonRows count={3} />
        ) : (
          <>
            <div className="text-sm text-silver">
              {data.position.code}
              {data.position.clientName && ` · ${data.position.clientName}`}
            </div>
            <div className="text-sm">
              <span className="text-silver">Currently held by: </span>
              <span className="text-white">
                {data.position.incumbent ? data.position.incumbent.name : 'Vacant'}
              </span>
            </div>

            <div className="space-y-2 pt-2 border-t border-navy-secondary">
              <div className="flex items-center justify-between">
                <div className="text-sm uppercase tracking-wider text-silver">
                  Successors
                </div>
                {canManage && (
                  <Button size="sm" onClick={() => setAdding(true)}>
                    <Plus className="mr-1 h-3 w-3" /> Add
                  </Button>
                )}
              </div>
              {data.candidates.length === 0 ? (
                <div className="text-sm text-silver py-3">
                  <Users className="inline h-4 w-4 mr-1" />
                  No successors named yet.
                </div>
              ) : (
                <div className="space-y-1">
                  {data.candidates.map((c) => (
                    <CandidateRow
                      key={c.id}
                      candidate={c}
                      canManage={canManage}
                      onChange={refresh}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>Close</Button>
      </DrawerFooter>
      {adding && data && (
        <AddCandidateDrawer
          positionId={positionId}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            refresh();
          }}
        />
      )}
    </Drawer>
  );
}

function CandidateRow({
  candidate,
  canManage,
  onChange,
}: {
  candidate: SuccessionPositionDetail['candidates'][number];
  canManage: boolean;
  onChange: () => void;
}) {
  return (
    <div className="flex items-center gap-2 p-2 rounded border border-navy-secondary">
      <div className="flex-1">
        <div className="text-sm text-white">{candidate.associateName}</div>
        <div className="text-xs text-silver">
          {candidate.currentTitle ?? candidate.associateEmail}
        </div>
        {candidate.notes && (
          <div className="text-xs text-silver mt-1 italic">
            “{candidate.notes}”
          </div>
        )}
      </div>
      {canManage ? (
        <select
          className="text-xs bg-midnight border border-navy-secondary rounded p-1 text-white"
          value={candidate.readiness}
          onChange={async (e) => {
            try {
              await updateSuccessionCandidate(candidate.id, {
                readiness: e.target.value as SuccessionReadiness,
              });
              onChange();
            } catch (err) {
              toast.error(err instanceof ApiError ? err.message : 'Failed.');
            }
          }}
        >
          {(Object.keys(READINESS_LABELS) as SuccessionReadiness[]).map((k) => (
            <option key={k} value={k}>
              {READINESS_LABELS[k]}
            </option>
          ))}
        </select>
      ) : (
        <Badge variant={READINESS_VARIANT[candidate.readiness]}>
          {READINESS_LABELS[candidate.readiness]}
        </Badge>
      )}
      {canManage && (
        <button
          onClick={async () => {
            if (!window.confirm('Remove this successor?')) return;
            try {
              await deleteSuccessionCandidate(candidate.id);
              onChange();
            } catch (err) {
              toast.error(err instanceof ApiError ? err.message : 'Failed.');
            }
          }}
          className="text-silver hover:text-destructive"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function AddCandidateDrawer({
  positionId,
  onClose,
  onSaved,
}: {
  positionId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [associateId, setAssociateId] = useState('');
  const [readiness, setReadiness] = useState<SuccessionReadiness>('READY_1_2_YEARS');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!associateId.trim()) {
      toast.error('Associate ID required.');
      return;
    }
    setSaving(true);
    try {
      await createSuccessionCandidate({
        positionId,
        associateId: associateId.trim(),
        readiness,
        notes: notes.trim() || null,
      });
      toast.success('Successor added.');
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
        <DrawerTitle>Add successor</DrawerTitle>
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
        <div>
          <Label>Readiness</Label>
          <select
            className="mt-1 w-full bg-midnight border border-navy-secondary rounded p-2 text-white text-sm"
            value={readiness}
            onChange={(e) => setReadiness(e.target.value as SuccessionReadiness)}
          >
            {(Object.keys(READINESS_LABELS) as SuccessionReadiness[]).map((k) => (
              <option key={k} value={k}>
                {READINESS_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Notes (optional)</Label>
          <textarea
            className="mt-1 w-full h-24 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Why this person, gaps to close…"
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
