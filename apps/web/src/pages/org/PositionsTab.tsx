import { useEffect, useState } from 'react';
import { Briefcase, Plus, Trash2, Users } from 'lucide-react';
import type {
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
} from '@/lib/orgApi';
import { ApiError } from '@/lib/api';
import { useConfirm } from '@/lib/confirm';
import { fmtMoney, fmtPercent, ymdLocal } from '@/lib/format';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import {
  Avatar,
  Badge,
  Button,
  Drawer,
  DrawerBody,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  MetricCard,
  Select,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { toast } from 'sonner';

const STATUS_VARIANT: Record<PositionStatus, 'default' | 'pending' | 'success' | 'destructive' | 'accent'> = {
  PLANNED: 'pending',
  OPEN: 'accent',
  FILLED: 'success',
  FROZEN: 'default',
  CLOSED: 'default',
};

const STATUS_LABELS: Record<PositionStatus, string> = {
  PLANNED: 'Planned',
  OPEN: 'Open',
  FILLED: 'Filled',
  FROZEN: 'Frozen',
  CLOSED: 'Closed',
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
  const [departments, setDepartments] = useState<Department[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [jobProfiles, setJobProfiles] = useState<JobProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drawerTarget, setDrawerTarget] = useState<Position | 'new' | null>(null);

  const refresh = async () => {
    try {
      setError(null);
      const [p, h, d, c, j] = await Promise.all([
        listPositions({ clientId: clientId || undefined }),
        getHeadcount(clientId || undefined),
        listDepartments(clientId || undefined),
        listCostCenters(clientId || undefined),
        listJobProfiles(clientId || undefined),
      ]);
      setRows(p.positions);
      setHeadcount(h);
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
          <MetricCard label="Total" value={headcount.total.toString()} />
          <MetricCard label="FTE auth" value={headcount.fteAuthorized} />
          <MetricCard label="FTE filled" value={headcount.fteFilled} />
          <MetricCard label="Open" value={(headcount.byStatus.OPEN ?? 0).toString()} />
          <MetricCard label="Filled" value={(headcount.byStatus.FILLED ?? 0).toString()} />
        </div>
      )}

      {error && (
        <ErrorBanner className="mb-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={() => void refresh()}>
              Retry
            </Button>
          </div>
        </ErrorBanner>
      )}
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
              <TableHead className="hidden md:table-cell">Department</TableHead>
              <TableHead>Filled by</TableHead>
              <TableHead className="hidden lg:table-cell text-right">FTE</TableHead>
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
                <TableCell>
                  {p.title}
                  <div className="text-xs2 text-silver/70 md:hidden">{p.departmentName ?? '—'}</div>
                </TableCell>
                <TableCell className="text-silver hidden md:table-cell">{p.departmentName ?? '—'}</TableCell>
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
                <TableCell className="text-right tabular-nums hidden lg:table-cell">{p.fteAuthorized}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[p.status]}>{STATUS_LABELS[p.status]}</Badge>
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

function PositionDrawer({
  target,
  clientId,
  canManage,
  departments,
  costCenters,
  jobProfiles,
  onClose,
  onSaved,
}: {
  target: Position | 'new';
  clientId: string;
  canManage: boolean;
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
  const [manager, setManager] = useState<PickedAssociate | null>(
    initial?.managerAssociateId
      ? { id: initial.managerAssociateId, name: initial.managerName ?? 'Current manager' }
      : null,
  );
  const [fte, setFte] = useState(initial?.fteAuthorized ?? '1.00');
  // New requisitions default to today — most are opened "hire ASAP".
  const [targetStartDate, setTargetStartDate] = useState(
    initial?.targetStartDate ?? (isNew ? ymdLocal() : ''),
  );
  const [minRate, setMinRate] = useState(initial?.minHourlyRate ?? '');
  const [maxRate, setMaxRate] = useState(initial?.maxHourlyRate ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assignTo, setAssignTo] = useState<PickedAssociate | null>(null);

  // Live band math: min ≤ max is validated inline; when the range is
  // sane we show the midpoint + spread so the admin can sanity-check
  // the band without a calculator.
  const minNum = minRate === '' ? null : Number(minRate);
  const maxNum = maxRate === '' ? null : Number(maxRate);
  const rangeInvalid =
    minNum !== null &&
    maxNum !== null &&
    Number.isFinite(minNum) &&
    Number.isFinite(maxNum) &&
    minNum > maxNum;
  const rangeStats =
    minNum !== null &&
    maxNum !== null &&
    Number.isFinite(minNum) &&
    Number.isFinite(maxNum) &&
    minNum > 0 &&
    minNum <= maxNum
      ? {
          midpoint: (minNum + maxNum) / 2,
          spreadPct: ((maxNum - minNum) / minNum) * 100,
        }
      : null;

  const submit = async () => {
    if (!code.trim() || !title.trim() || rangeInvalid) return;
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
        managerAssociateId: manager?.id ?? null,
        fteAuthorized: Number(fte),
        targetStartDate: targetStartDate || null,
        minHourlyRate: minRate ? Number(minRate) : null,
        maxHourlyRate: maxRate ? Number(maxRate) : null,
        notes: notes.trim() || null,
      };
      if (isNew) {
        await createPosition(payload);
        toast.success('Position created.');
      } else {
        await updatePosition(initial!.id, payload);
        toast.success('Position updated.');
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const transition = async (status: PositionStatus, successMessage: string) => {
    if (isNew) return;
    setSubmitting(true);
    try {
      await setPositionStatus(initial!.id, status);
      toast.success(successMessage);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update status.');
      setSubmitting(false);
    }
  };

  const freeze = async () => {
    if (isNew) return;
    const ok = await confirm({
      title: `Freeze ${initial!.code}?`,
      description:
        'Hiring pauses on a frozen position — it cannot be filled until it is reopened.',
      confirmLabel: 'Freeze position',
    });
    if (!ok) return;
    await transition('FROZEN', `${initial!.code} frozen — hiring is paused.`);
  };

  const assign = async () => {
    if (isNew || !assignTo) return;
    setSubmitting(true);
    try {
      await assignPosition(initial!.id, { associateId: assignTo.id });
      toast.success(`Position filled by ${assignTo.name}.`);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Assign failed.');
      setSubmitting(false);
    }
  };

  const vacate = async () => {
    if (isNew) return;
    if (!(await confirm({ title: 'Vacate this position?', description: 'Status moves to Open.', destructive: true }))) return;
    setSubmitting(true);
    try {
      await vacatePosition(initial!.id);
      toast.success('Position vacated.');
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
      toast.success('Position closed.');
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
                <Badge variant={STATUS_VARIANT[initial!.status]}>{STATUS_LABELS[initial!.status]}</Badge>
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
            <Field label="Code" required>
              {(p) => (
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  maxLength={40}
                  placeholder="LINE-COOK-1"
                  disabled={!canManage}
                  {...p}
                />
              )}
            </Field>
            <Field label="FTE">
              {(p) => (
                <Input
                  type="number"
                  step="0.05"
                  min="0.01"
                  max="2"
                  value={fte}
                  onChange={(e) => setFte(e.target.value)}
                  disabled={!canManage}
                  {...p}
                />
              )}
            </Field>
          </div>
          <Field label="Title" required>
            {(p) => (
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={120}
                disabled={!canManage}
                {...p}
              />
            )}
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Job profile">
              {(p) => (
                <Select
                  value={jobProfileId}
                  onChange={(e) => setJobProfileId(e.target.value)}
                  disabled={!canManage}
                  {...p}
                >
                  <option value="">—</option>
                  {jobProfiles.map((j) => (
                    <option key={j.id} value={j.id}>{j.code} · {j.title}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Department">
              {(p) => (
                <Select
                  value={departmentId}
                  onChange={(e) => setDepartmentId(e.target.value)}
                  disabled={!canManage}
                  {...p}
                >
                  <option value="">—</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Cost center">
              {(p) => (
                <Select
                  value={costCenterId}
                  onChange={(e) => setCostCenterId(e.target.value)}
                  disabled={!canManage}
                  {...p}
                >
                  <option value="">—</option>
                  {costCenters.map((c) => (
                    <option key={c.id} value={c.id}>{c.code}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Reporting manager">
              {() =>
                canManage ? (
                  <AssociatePicker
                    value={manager}
                    onChange={setManager}
                    placeholder="Search for a manager…"
                  />
                ) : (
                  <div className="rounded-md border border-navy-secondary bg-navy px-3 py-2 text-sm text-white">
                    {manager?.name ?? '—'}
                  </div>
                )
              }
            </Field>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Target start">
              {(p) => (
                <Input
                  type="date"
                  value={targetStartDate ?? ''}
                  onChange={(e) => setTargetStartDate(e.target.value)}
                  disabled={!canManage}
                  {...p}
                />
              )}
            </Field>
            <Field label="Min $/hr">
              {(p) => (
                <Input
                  type="number"
                  step="0.5"
                  value={minRate ?? ''}
                  onChange={(e) => setMinRate(e.target.value)}
                  disabled={!canManage}
                  {...p}
                />
              )}
            </Field>
            <Field label="Max $/hr">
              {(p) => (
                <Input
                  type="number"
                  step="0.5"
                  value={maxRate ?? ''}
                  onChange={(e) => setMaxRate(e.target.value)}
                  disabled={!canManage}
                  {...p}
                />
              )}
            </Field>
          </div>

          {rangeInvalid && (
            <p role="alert" className="text-sm text-alert">
              Min hourly rate must be less than or equal to the max rate.
            </p>
          )}
          {rangeStats && (
            <p className="text-xs2 text-silver tabular-nums">
              midpoint {fmtMoney(rangeStats.midpoint)} · spread{' '}
              {fmtPercent(rangeStats.spreadPct)}
            </p>
          )}

          <Field label="Notes">
            {(p) => (
              <Input
                value={notes ?? ''}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={1000}
                disabled={!canManage}
                {...p}
              />
            )}
          </Field>

          {!isNew && canManage && initial!.status !== 'FILLED' && (
            <div className="pt-3 border-t border-navy-secondary space-y-2">
              <div className="text-2xs uppercase tracking-widest text-silver/80">
                Assign to
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <AssociatePicker
                    value={assignTo}
                    onChange={setAssignTo}
                    placeholder="Search for an associate to fill this seat…"
                  />
                </div>
                <Button
                  size="sm"
                  onClick={assign}
                  disabled={!assignTo || submitting}
                >
                  <Users className="h-4 w-4" />
                  Fill
                </Button>
              </div>
            </div>
          )}

          {error && <ErrorBanner>{error}</ErrorBanner>}
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
              <Button
                variant="outline"
                onClick={() =>
                  void transition('OPEN', `${initial!.code} is open for hiring.`)
                }
                disabled={submitting}
              >
                Open
              </Button>
            )}
            {initial!.status !== 'FROZEN' && initial!.status !== 'FILLED' && (
              <Button variant="outline" onClick={() => void freeze()} disabled={submitting}>
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
              disabled={!code.trim() || !title.trim() || rangeInvalid}
            >
              {isNew ? 'Create' : 'Save'}
            </Button>
          )}
        </div>
      </DrawerFooter>
    </>
  );
}
