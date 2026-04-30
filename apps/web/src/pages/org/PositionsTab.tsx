import { useEffect, useState } from 'react';
import { Briefcase, Plus, Trash2, Users } from 'lucide-react';
import type {
  AssociateOrgSummary,
  CostCenter,
  Department,
  JobProfile,
  Position,
  PositionHeadcount,
  PositionStatus,
} from '@alto-people/shared';
import {
  assignPosition,
  createPosition,
  deletePosition,
  getHeadcount,
  listPositions,
  setPositionStatus,
  updatePosition,
  vacatePosition,
} from '@/lib/positionsApi';
import {
  listCostCenters,
  listDepartments,
  listJobProfiles,
  listOrgAssociates,
} from '@/lib/orgApi';
import { ApiError } from '@/lib/api';
import { useConfirm } from '@/lib/confirm';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  Drawer,
  DrawerBody,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  Input,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
import { toast } from 'sonner';

const STATUS_VARIANT: Record<PositionStatus, 'default' | 'pending' | 'success' | 'destructive' | 'accent'> = {
  PLANNED: 'pending',
  OPEN: 'accent',
  FILLED: 'success',
  FROZEN: 'default',
  CLOSED: 'default',
};

export function PositionsTab({
  clientId,
  canManage,
}: {
  clientId: string;
  canManage: boolean;
}) {
  const [rows, setRows] = useState<Position[] | null>(null);
  const [headcount, setHeadcount] = useState<PositionHeadcount | null>(null);
  const [associates, setAssociates] = useState<AssociateOrgSummary[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [jobProfiles, setJobProfiles] = useState<JobProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drawerTarget, setDrawerTarget] = useState<Position | 'new' | null>(null);

  const refresh = async () => {
    try {
      setError(null);
      const [p, h, a, d, c, j] = await Promise.all([
        listPositions({ clientId: clientId || undefined }),
        getHeadcount(clientId || undefined),
        listOrgAssociates(clientId || undefined),
        listDepartments(clientId || undefined),
        listCostCenters(clientId || undefined),
        listJobProfiles(clientId || undefined),
      ]);
      setRows(p.positions);
      setHeadcount(h);
      setAssociates(a.associates);
      setDepartments(d.departments);
      setCostCenters(c.costCenters);
      setJobProfiles(j.jobProfiles);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  };

  useEffect(() => {
    setRows(null);
    refresh();
  }, [clientId]);

  return (
    <section>
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="text-base font-medium text-white">Positions</h2>
        {canManage && clientId && (
          <Button size="sm" onClick={() => setDrawerTarget('new')}>
            <Plus className="h-4 w-4" />
            New position
          </Button>
        )}
      </div>

      {headcount && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
          <HeadcountTile label="Total" value={headcount.total.toString()} />
          <HeadcountTile label="FTE auth" value={headcount.fteAuthorized} />
          <HeadcountTile label="FTE filled" value={headcount.fteFilled} />
          <HeadcountTile label="Open" value={(headcount.byStatus.OPEN ?? 0).toString()} />
          <HeadcountTile label="Filled" value={(headcount.byStatus.FILLED ?? 0).toString()} />
        </div>
      )}

      {error && <p role="alert" className="text-sm text-alert mb-3">{error}</p>}
      {!rows && <SkeletonRows count={4} rowHeight="h-12" />}
      {rows && rows.length === 0 && (
        <EmptyState
          icon={Briefcase}
          title="No positions yet"
          description={
            clientId
              ? 'Create authorized seats to track headcount, hire against requisitions, and report attrition.'
              : 'Pick a client to start adding positions.'
          }
          action={
            canManage && clientId ? (
              <Button onClick={() => setDrawerTarget('new')} size="sm">
                <Plus className="h-4 w-4" />
                New position
              </Button>
            ) : undefined
          }
        />
      )}
      {rows && rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Department</TableHead>
              <TableHead>Filled by</TableHead>
              <TableHead>FTE</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((p) => (
              <TableRow
                key={p.id}
                className="group cursor-pointer"
                onClick={(e) => {
                  const t = e.target as HTMLElement;
                  if (t.closest('button, a, input, [data-no-row-click]')) return;
                  setDrawerTarget(p);
                }}
              >
                <TableCell className="font-medium tabular-nums">{p.code}</TableCell>
                <TableCell>{p.title}</TableCell>
                <TableCell className="text-silver">{p.departmentName ?? '—'}</TableCell>
                <TableCell className="text-silver">
                  {p.filledByName ? (
                    <div className="flex items-center gap-2">
                      <Avatar name={p.filledByName} size="xs" />
                      <span>{p.filledByName}</span>
                    </div>
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell className="tabular-nums">{p.fteAuthorized}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[p.status]}>{p.status}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Drawer
        open={drawerTarget !== null}
        onOpenChange={(o) => !o && setDrawerTarget(null)}
        width="max-w-lg"
      >
        {drawerTarget && (
          <PositionDrawer
            target={drawerTarget}
            clientId={clientId}
            canManage={canManage}
            associates={associates}
            departments={departments}
            costCenters={costCenters}
            jobProfiles={jobProfiles}
            onClose={() => setDrawerTarget(null)}
            onSaved={() => {
              setDrawerTarget(null);
              refresh();
            }}
          />
        )}
      </Drawer>
    </section>
  );
}

function HeadcountTile({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-[10px] uppercase tracking-widest text-silver/80">
          {label}
        </div>
        <div className="font-display text-2xl text-white tabular-nums mt-1">
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

function PositionDrawer({
  target,
  clientId,
  canManage,
  associates,
  departments,
  costCenters,
  jobProfiles,
  onClose,
  onSaved,
}: {
  target: Position | 'new';
  clientId: string;
  canManage: boolean;
  associates: AssociateOrgSummary[];
  departments: Department[];
  costCenters: CostCenter[];
  jobProfiles: JobProfile[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const confirm = useConfirm();
  const isNew = target === 'new';
  const initial = isNew ? null : target;
  const [code, setCode] = useState(initial?.code ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [jobProfileId, setJobProfileId] = useState(initial?.jobProfileId ?? '');
  const [departmentId, setDepartmentId] = useState(initial?.departmentId ?? '');
  const [costCenterId, setCostCenterId] = useState(initial?.costCenterId ?? '');
  const [managerId, setManagerId] = useState(initial?.managerAssociateId ?? '');
  const [fte, setFte] = useState(initial?.fteAuthorized ?? '1.00');
  const [targetStartDate, setTargetStartDate] = useState(
    initial?.targetStartDate ?? '',
  );
  const [minRate, setMinRate] = useState(initial?.minHourlyRate ?? '');
  const [maxRate, setMaxRate] = useState(initial?.maxHourlyRate ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assignToId, setAssignToId] = useState('');

  const submit = async () => {
    if (!code.trim() || !title.trim()) return;
    setError(null);
    setSubmitting(true);
    try {
      const payload = {
        clientId,
        code: code.trim(),
        title: title.trim(),
        jobProfileId: jobProfileId || null,
        departmentId: departmentId || null,
        costCenterId: costCenterId || null,
        managerAssociateId: managerId || null,
        fteAuthorized: Number(fte),
        targetStartDate: targetStartDate || null,
        minHourlyRate: minRate ? Number(minRate) : null,
        maxHourlyRate: maxRate ? Number(maxRate) : null,
        notes: notes.trim() || null,
      };
      if (isNew) {
        await createPosition(payload);
        toast.success('Position created');
      } else {
        await updatePosition(initial!.id, payload);
        toast.success('Position updated');
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const transition = async (status: PositionStatus) => {
    if (isNew) return;
    setSubmitting(true);
    try {
      await setPositionStatus(initial!.id, status);
      toast.success(`Status → ${status}`);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update status.');
      setSubmitting(false);
    }
  };

  const assign = async () => {
    if (isNew || !assignToId) return;
    setSubmitting(true);
    try {
      await assignPosition(initial!.id, { associateId: assignToId });
      toast.success('Position filled');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Assign failed.');
      setSubmitting(false);
    }
  };

  const vacate = async () => {
    if (isNew) return;
    if (!(await confirm({ title: 'Vacate this position?', description: 'Status moves to OPEN.', destructive: true }))) return;
    setSubmitting(true);
    try {
      await vacatePosition(initial!.id);
      toast.success('Position vacated');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Vacate failed.');
      setSubmitting(false);
    }
  };

  const remove = async () => {
    if (isNew) return;
    if (!(await confirm({ title: `Close position ${initial!.code}?`, destructive: true }))) return;
    setSubmitting(true);
    try {
      await deletePosition(initial!.id);
      toast.success('Position closed');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Close failed.');
      setSubmitting(false);
    }
  };

  return (
    <>
      <DrawerHeader>
        <DrawerTitle>
          {isNew ? 'New position' : `${initial!.code} · ${initial!.title}`}
        </DrawerTitle>
        <DrawerDescription>
          {isNew
            ? 'Authorized seat in the org — distinct from the person filling it.'
            : (
              <span className="inline-flex items-center gap-2">
                <Badge variant={STATUS_VARIANT[initial!.status]}>{initial!.status}</Badge>
                {initial!.filledByName ? (
                  <>filled by {initial!.filledByName}</>
                ) : (
                  <>vacant</>
                )}
              </span>
            )}
        </DrawerDescription>
      </DrawerHeader>
      <DrawerBody>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="pos-code" required>Code</Label>
              <Input
                id="pos-code"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                maxLength={40}
                placeholder="LINE-COOK-1"
                disabled={!canManage}
              />
            </div>
            <div>
              <Label htmlFor="pos-fte">FTE</Label>
              <Input
                id="pos-fte"
                type="number"
                step="0.05"
                min="0.01"
                max="2"
                value={fte}
                onChange={(e) => setFte(e.target.value)}
                disabled={!canManage}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="pos-title" required>Title</Label>
            <Input
              id="pos-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              disabled={!canManage}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="pos-jp">Job profile</Label>
              <select
                id="pos-jp"
                value={jobProfileId}
                onChange={(e) => setJobProfileId(e.target.value)}
                disabled={!canManage}
                className="w-full h-10 px-3 py-2 rounded-md bg-navy-secondary/40 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white text-sm"
              >
                <option value="">—</option>
                {jobProfiles.map((j) => (
                  <option key={j.id} value={j.id}>{j.code} · {j.title}</option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="pos-dept">Department</Label>
              <select
                id="pos-dept"
                value={departmentId}
                onChange={(e) => setDepartmentId(e.target.value)}
                disabled={!canManage}
                className="w-full h-10 px-3 py-2 rounded-md bg-navy-secondary/40 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white text-sm"
              >
                <option value="">—</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="pos-cc">Cost center</Label>
              <select
                id="pos-cc"
                value={costCenterId}
                onChange={(e) => setCostCenterId(e.target.value)}
                disabled={!canManage}
                className="w-full h-10 px-3 py-2 rounded-md bg-navy-secondary/40 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white text-sm"
              >
                <option value="">—</option>
                {costCenters.map((c) => (
                  <option key={c.id} value={c.id}>{c.code}</option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="pos-mgr">Reporting manager</Label>
              <select
                id="pos-mgr"
                value={managerId}
                onChange={(e) => setManagerId(e.target.value)}
                disabled={!canManage}
                className="w-full h-10 px-3 py-2 rounded-md bg-navy-secondary/40 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white text-sm"
              >
                <option value="">—</option>
                {associates.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.firstName} {a.lastName}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <Label htmlFor="pos-target">Target start</Label>
              <Input
                id="pos-target"
                type="date"
                value={targetStartDate ?? ''}
                onChange={(e) => setTargetStartDate(e.target.value)}
                disabled={!canManage}
              />
            </div>
            <div>
              <Label htmlFor="pos-min">Min $/hr</Label>
              <Input
                id="pos-min"
                type="number"
                step="0.5"
                value={minRate ?? ''}
                onChange={(e) => setMinRate(e.target.value)}
                disabled={!canManage}
              />
            </div>
            <div>
              <Label htmlFor="pos-max">Max $/hr</Label>
              <Input
                id="pos-max"
                type="number"
                step="0.5"
                value={maxRate ?? ''}
                onChange={(e) => setMaxRate(e.target.value)}
                disabled={!canManage}
              />
            </div>
          </div>

          <div>
            <Label htmlFor="pos-notes">Notes</Label>
            <Input
              id="pos-notes"
              value={notes ?? ''}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={1000}
              disabled={!canManage}
            />
          </div>

          {!isNew && canManage && initial!.status !== 'FILLED' && (
            <div className="pt-3 border-t border-navy-secondary space-y-2">
              <div className="text-[10px] uppercase tracking-widest text-silver/80">
                Assign to
              </div>
              <div className="flex gap-2">
                <select
                  value={assignToId}
                  onChange={(e) => setAssignToId(e.target.value)}
                  className="flex-1 h-10 px-3 py-2 rounded-md bg-navy-secondary/40 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white text-sm"
                >
                  <option value="">— choose an associate —</option>
                  {associates.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.firstName} {a.lastName}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  onClick={assign}
                  disabled={!assignToId || submitting}
                >
                  <Users className="h-4 w-4" />
                  Fill
                </Button>
              </div>
            </div>
          )}

          {error && <p role="alert" className="text-sm text-alert">{error}</p>}
        </div>
      </DrawerBody>
      <DrawerFooter className="flex-wrap justify-between">
        {!isNew && canManage ? (
          <div className="flex gap-2">
            {initial!.status === 'FILLED' && (
              <Button variant="outline" onClick={vacate} disabled={submitting}>
                Vacate
              </Button>
            )}
            {initial!.status !== 'OPEN' && initial!.status !== 'FILLED' && (
              <Button variant="outline" onClick={() => transition('OPEN')} disabled={submitting}>
                Open
              </Button>
            )}
            {initial!.status !== 'FROZEN' && initial!.status !== 'FILLED' && (
              <Button variant="outline" onClick={() => transition('FROZEN')} disabled={submitting}>
                Freeze
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={remove}
              disabled={submitting || initial!.status === 'FILLED'}
              className="text-alert hover:text-alert"
            >
              <Trash2 className="h-4 w-4" />
              Close
            </Button>
          </div>
        ) : (
          <span />
        )}
        <div className="flex gap-2 ml-auto">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          {canManage && (
            <Button
              onClick={submit}
              loading={submitting}
              disabled={!code.trim() || !title.trim()}
            >
              {isNew ? 'Create' : 'Save'}
            </Button>
          )}
        </div>
      </DrawerFooter>
    </>
  );
}
