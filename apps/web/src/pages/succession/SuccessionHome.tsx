import { useEffect, useMemo, useState } from 'react';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { Crown, Download, Plus, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  createSuccessionCandidate,
  deleteSuccessionCandidate,
  getSuccessionPosition,
  getSuccessionSummary,
  listSuccessionPositions,
  READINESS_LABELS,
  type SuccessionCandidateRow,
  type SuccessionPositionDetail,
  type SuccessionPositionRow,
  type SuccessionReadiness,
  type SuccessionSummary,
  updateSuccessionCandidate,
} from '@/lib/succession115Api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
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
  ErrorBanner,
  FilterBar,
  FilterChip,
  Input,
  MetricCard,
  PageHeader,
  Select,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@/components/ui';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { Label } from '@/components/ui/Label';
import { ymdLocal } from '@/lib/format';
import { downloadCsv } from '@/lib/csv';

const READINESS_VARIANT: Record<
  SuccessionReadiness,
  'success' | 'pending' | 'outline' | 'accent'
> = {
  READY_NOW: 'success',
  READY_1_2_YEARS: 'pending',
  READY_3_PLUS_YEARS: 'outline',
  EMERGENCY_COVER: 'accent',
};

const READINESS_KEYS = Object.keys(READINESS_LABELS) as SuccessionReadiness[];

export function SuccessionHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:performance') : false;
  const [rows, setRows] = useState<SuccessionPositionRow[] | null>(null);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [summary, setSummary] = useState<SuccessionSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [readinessFilter, setReadinessFilter] = useState<Set<SuccessionReadiness>>(
    new Set(),
  );
  const [atRiskOnly, setAtRiskOnly] = useState(false);
  // Per-position successor lists, loaded lazily for the readiness filter and
  // the bench CSV export (the positions list itself only carries counts).
  const [candMap, setCandMap] = useState<Map<string, SuccessionCandidateRow[]> | null>(
    null,
  );
  const [candLoading, setCandLoading] = useState(false);

  const refreshPositions = () => {
    setRows(null);
    setRowsError(null);
    setCandMap(null);
    listSuccessionPositions()
      .then((r) => setRows(r.positions))
      .catch((err) =>
        setRowsError(
          err instanceof ApiError ? err.message : 'Failed to load positions.',
        ),
      );
  };
  const refreshSummary = () => {
    setSummaryError(null);
    getSuccessionSummary()
      .then(setSummary)
      .catch((err) => {
        setSummary(null);
        setSummaryError(
          err instanceof ApiError ? err.message : 'Failed to load the readiness summary.',
        );
      });
  };
  const refresh = () => {
    refreshPositions();
    refreshSummary();
  };
  useEffect(() => {
    refresh();
  }, []);

  const ensureCandidates = async (
    positions: SuccessionPositionRow[],
  ): Promise<Map<string, SuccessionCandidateRow[]> | null> => {
    if (candMap) return candMap;
    setCandLoading(true);
    try {
      const withSuccessors = positions.filter((p) => p.successorCount > 0);
      const details = await Promise.all(
        withSuccessors.map(
          async (p) =>
            [p.id, (await getSuccessionPosition(p.id)).candidates] as const,
        ),
      );
      const map = new Map(details);
      setCandMap(map);
      return map;
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Failed to load successor details.',
      );
      return null;
    } finally {
      setCandLoading(false);
    }
  };

  const toggleReadiness = (r: SuccessionReadiness) => {
    setReadinessFilter((prev) => {
      const next = new Set(prev);
      if (next.has(r)) next.delete(r);
      else next.add(r);
      return next;
    });
    if (!candMap && rows) void ensureCandidates(rows);
  };

  const filtered = useMemo(() => {
    if (!rows) return null;
    const q = filter.trim().toLowerCase();
    return rows.filter((r) => {
      if (
        q &&
        !(
          r.title.toLowerCase().includes(q) ||
          r.code.toLowerCase().includes(q) ||
          (r.clientName ?? '').toLowerCase().includes(q) ||
          (r.departmentName ?? '').toLowerCase().includes(q)
        )
      )
        return false;
      if (atRiskOnly && !(r.incumbent === null || r.successorCount === 0))
        return false;
      if (readinessFilter.size > 0 && candMap) {
        const cands = candMap.get(r.id) ?? [];
        if (!cands.some((c) => readinessFilter.has(c.readiness))) return false;
      }
      return true;
    });
  }, [rows, filter, atRiskOnly, readinessFilter, candMap]);

  const onExportCsv = async () => {
    if (!rows || !filtered) return;
    const map = await ensureCandidates(rows);
    if (!map) return;
    const out: Array<Array<string | number>> = [
      [
        'Position',
        'Code',
        'Department',
        'Incumbent',
        'Successor count',
        'Coverage',
        'Successor',
        'Readiness',
        'Notes',
      ],
    ];
    for (const p of filtered) {
      const cands = map.get(p.id) ?? [];
      if (cands.length === 0) {
        out.push([
          p.title,
          p.code,
          p.departmentName ?? '',
          p.incumbent?.name ?? 'Vacant',
          0,
          'Uncovered',
          '',
          '',
          '',
        ]);
      } else {
        for (const c of cands) {
          out.push([
            p.title,
            p.code,
            p.departmentName ?? '',
            p.incumbent?.name ?? 'Vacant',
            cands.length,
            'Covered',
            c.associateName,
            READINESS_LABELS[c.readiness],
            c.notes ?? '',
          ]);
        }
      }
    }
    downloadCsv(`succession-bench-${ymdLocal()}.csv`, out);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Succession planning"
        subtitle="Designate successors for each position. Track who's ready now, in 1–2 years, or beyond."
        breadcrumbs={[{ label: 'Performance' }, { label: 'Succession' }]}
        secondaryActions={
          <Button
            size="sm"
            variant="outline"
            onClick={onExportCsv}
            disabled={!filtered || filtered.length === 0}
            loading={candLoading}
          >
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        }
      />

      {summaryError ? (
        <ErrorBanner>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{summaryError}</span>
            <Button size="sm" variant="outline" onClick={refreshSummary}>
              Retry
            </Button>
          </div>
        </ErrorBanner>
      ) : (
        summary && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <MetricCard label="Positions" value={summary.positionCount} />
            <MetricCard
              label="With successor"
              value={`${summary.positionsWithSuccessor} / ${summary.positionCount}`}
              hint={`${summary.coverage}% coverage`}
            />
            <MetricCard
              label="Ready now"
              value={summary.byReadiness.READY_NOW}
            />
            <MetricCard
              label="Emergency cover"
              value={summary.byReadiness.EMERGENCY_COVER}
            />
          </div>
        )
      )}

      <FilterBar>
        {READINESS_KEYS.map((r) => (
          <FilterChip
            key={r}
            active={readinessFilter.has(r)}
            onClick={() => toggleReadiness(r)}
          >
            {READINESS_LABELS[r]}
          </FilterChip>
        ))}
        <FilterChip
          active={atRiskOnly}
          onClick={() => setAtRiskOnly((v) => !v)}
        >
          At risk only
        </FilterChip>
        <Input
          placeholder="Filter positions, codes, departments…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="ml-auto max-w-sm"
        />
      </FilterBar>
      {readinessFilter.size > 0 && !candMap && candLoading && (
        <div className="text-xs text-silver text-right">
          Loading successor details to apply the readiness filter…
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {rowsError ? (
            <div className="p-6">
              <ErrorBanner>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>{rowsError}</span>
                  <Button size="sm" variant="outline" onClick={refreshPositions}>
                    Retry
                  </Button>
                </div>
              </ErrorBanner>
            </div>
          ) : filtered === null ? (
            <div className="p-6">
              <SkeletonRows count={4} />
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Crown}
              title={rows && rows.length > 0 ? 'No matches' : 'No positions'}
              description={
                rows && rows.length > 0
                  ? 'No position matches the current filters.'
                  : 'Create positions in Org structure first; once they exist you can name successors here.'
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Position</TableHead>
                  <TableHead className="hidden md:table-cell">Department</TableHead>
                  <TableHead className="hidden md:table-cell">Incumbent</TableHead>
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
                      <div className="md:hidden text-xs2 text-silver/70 truncate">
                        {p.departmentName ?? '—'} · {p.incumbent ? p.incumbent.name : 'Vacant'}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-silver hidden md:table-cell">
                      {p.departmentName ?? '—'}
                    </TableCell>
                    <TableCell className="text-sm hidden md:table-cell">
                      {p.incumbent ? (
                        <AssociateLink associateId={p.incumbent.id}>
                          {p.incumbent.name}
                        </AssociateLink>
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // One in-flight action at a time — a double-click on Remove used to
  // fire the write twice.
  const [actionKey, setActionKey] = useState<string | null>(null);
  const act = async (key: string, fn: () => Promise<void>) => {
    if (actionKey) return;
    setActionKey(key);
    try {
      await fn();
    } finally {
      setActionKey(null);
    }
  };

  const refresh = () => {
    setData(null);
    setLoadError(null);
    getSuccessionPosition(positionId)
      .then(setData)
      .catch((err) =>
        setLoadError(
          err instanceof ApiError ? err.message : 'Failed to load this position.',
        ),
      );
  };
  useEffect(() => {
    refresh();
  }, [positionId]);

  const changeReadiness = async (
    candidateId: string,
    readiness: SuccessionReadiness,
  ) => {
    const prev = data;
    // Optimistic: flip the badge/select immediately, revert on failure.
    setData((d) =>
      d
        ? {
            ...d,
            candidates: d.candidates.map((c) =>
              c.id === candidateId ? { ...c, readiness } : c,
            ),
          }
        : d,
    );
    try {
      await updateSuccessionCandidate(candidateId, { readiness });
      toast.success(`Readiness set to ${READINESS_LABELS[readiness]}.`);
    } catch (err) {
      setData(prev);
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  const removeCandidate = async (candidateId: string) =>
    act(`remove-${candidateId}`, async () => {
      const prev = data;
      setData((d) =>
        d
          ? { ...d, candidates: d.candidates.filter((c) => c.id !== candidateId) }
          : d,
      );
      try {
        await deleteSuccessionCandidate(candidateId);
        toast.success('Successor removed.');
      } catch (err) {
        setData(prev);
        toast.error(err instanceof ApiError ? err.message : 'Failed.');
      }
    });

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{data?.position.title ?? 'Position'}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {loadError ? (
          <ErrorBanner>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{loadError}</span>
              <Button size="sm" variant="outline" onClick={refresh}>
                Retry
              </Button>
            </div>
          </ErrorBanner>
        ) : !data ? (
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
                {data.position.incumbent ? (
                  <AssociateLink associateId={data.position.incumbent.id}>
                    {data.position.incumbent.name}
                  </AssociateLink>
                ) : (
                  'Vacant'
                )}
              </span>
            </div>

            <div className="space-y-2 pt-2 border-t border-navy-secondary">
              <div className="flex items-center justify-between">
                <div className="text-sm uppercase tracking-wider text-silver">
                  Successors
                </div>
                {canManage && data.candidates.length > 0 && (
                  <Button size="sm" onClick={() => setAdding(true)}>
                    <Plus className="mr-1 h-3 w-3" /> Add
                  </Button>
                )}
              </div>
              {data.candidates.length === 0 ? (
                <EmptyState
                  icon={Users}
                  title="No successors named yet"
                  description="Name at least one successor so this position isn't a single point of failure."
                  action={
                    canManage ? (
                      <Button size="sm" onClick={() => setAdding(true)}>
                        <Plus className="mr-1 h-3 w-3" /> Add successor
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <div className="space-y-1">
                  {data.candidates.map((c) => (
                    <CandidateRow
                      key={c.id}
                      candidate={c}
                      canManage={canManage}
                      onReadinessChange={(r) => changeReadiness(c.id, r)}
                      onRemove={() => removeCandidate(c.id)}
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
  onReadinessChange,
  onRemove,
}: {
  candidate: SuccessionCandidateRow;
  canManage: boolean;
  onReadinessChange: (readiness: SuccessionReadiness) => void;
  onRemove: () => void;
}) {
  const confirm = useConfirm();
  return (
    <div className="flex items-center gap-2 p-2 rounded border border-navy-secondary">
      <div className="flex-1">
        <div className="text-sm text-white">
          <AssociateLink associateId={candidate.associateId}>
            {candidate.associateName}
          </AssociateLink>
        </div>
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
        <Select
          size="sm"
          value={candidate.readiness}
          onChange={(e) =>
            onReadinessChange(e.target.value as SuccessionReadiness)
          }
        >
          {READINESS_KEYS.map((k) => (
            <option key={k} value={k}>
              {READINESS_LABELS[k]}
            </option>
          ))}
        </Select>
      ) : (
        <Badge variant={READINESS_VARIANT[candidate.readiness]}>
          {READINESS_LABELS[candidate.readiness]}
        </Badge>
      )}
      {canManage && (
        <button
          onClick={async () => {
            if (!(await confirm({ title: 'Remove this successor?', destructive: true }))) return;
            onRemove();
          }}
          className="text-silver hover:text-alert"
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
  const [associate, setAssociate] = useState<PickedAssociate | null>(null);
  const [readiness, setReadiness] = useState<SuccessionReadiness>('READY_1_2_YEARS');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!associate) {
      toast.error('Pick an associate.');
      return;
    }
    setSaving(true);
    try {
      await createSuccessionCandidate({
        positionId,
        associateId: associate.id,
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
          <Label>Associate</Label>
          <div className="mt-1">
            <AssociatePicker value={associate} onChange={setAssociate} />
          </div>
        </div>
        <div>
          <Label>Readiness</Label>
          <Select
            className="mt-1"
            value={readiness}
            onChange={(e) => setReadiness(e.target.value as SuccessionReadiness)}
          >
            {READINESS_KEYS.map((k) => (
              <option key={k} value={k}>
                {READINESS_LABELS[k]}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Notes (optional)</Label>
          <Textarea
            className="mt-1 h-24"
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
