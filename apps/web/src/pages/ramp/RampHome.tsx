import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Download, Plus, Target, Trash2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  addMilestone,
  archiveRampPlan,
  createRampPlan,
  deleteMilestone,
  getActivePlanForAssociate,
  listRampPlans,
  STATUS_LABELS,
  updateMilestone,
  type RampMilestoneStatus,
  type RampPlan,
  type RampPlanRow,
} from '@/lib/ramp125Api';
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
  Input,
  PageHeader,
  Select,
  SkeletonRows,
  Textarea,
} from '@/components/ui';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { fmtDate, parseYmd, ymdLocal } from '@/lib/format';
import { downloadCsv } from '@/lib/csv';
import { Label } from '@/components/ui/Label';

const STATUS_VARIANT: Record<
  RampMilestoneStatus,
  'pending' | 'success' | 'destructive' | 'accent'
> = {
  PENDING: 'pending',
  ON_TRACK: 'accent',
  ACHIEVED: 'success',
  MISSED: 'destructive',
};

export function RampHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:onboarding') : false;
  const [rows, setRows] = useState<RampPlanRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null); // associateId
  const [showNew, setShowNew] = useState(false);
  const [search, setSearch] = useState('');
  const [missedOnly, setMissedOnly] = useState(false);

  const refresh = () => {
    setRows(null);
    setLoadError(null);
    listRampPlans()
      .then((r) => setRows(r.plans))
      .catch((err) =>
        setLoadError(
          err instanceof ApiError ? err.message : 'Failed to load ramp plans.',
        ),
      );
  };
  useEffect(() => {
    refresh();
  }, []);

  const filtered = useMemo(() => {
    if (!rows) return null;
    const q = search.trim().toLowerCase();
    return rows.filter(
      (p) =>
        (!q || p.associateName.toLowerCase().includes(q)) &&
        (!missedOnly || p.missed > 0),
    );
  }, [rows, search, missedOnly]);

  const onExportCsv = () => {
    if (!filtered) return;
    downloadCsv(`ramp-plans-${ymdLocal()}.csv`, [
      ['Associate', 'Email', 'Start date', 'Manager email', 'Milestones', 'Achieved', 'Missed'],
      ...filtered.map((p) => [
        p.associateName,
        p.associateEmail,
        p.startDate,
        p.managerEmail ?? '',
        p.total,
        p.achieved,
        p.missed,
      ]),
    ]);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Ramp plans"
        subtitle="30/60/90-day milestones for new hires. Manager updates status as the new hire progresses."
        breadcrumbs={[{ label: 'Workforce' }, { label: 'Ramp plans' }]}
      />

      <div className="flex flex-wrap items-center gap-2 justify-end">
        <Input
          placeholder="Search by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
          aria-label="Search plans by associate name"
        />
        <Button
          size="sm"
          variant={missedOnly ? 'secondary' : 'ghost'}
          aria-pressed={missedOnly}
          onClick={() => setMissedOnly((v) => !v)}
        >
          Has missed milestones
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onExportCsv}
          disabled={!filtered || filtered.length === 0}
        >
          <Download className="mr-2 h-4 w-4" /> Export CSV
        </Button>
        {canManage && (
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> New ramp plan
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {loadError ? (
            <div className="p-6 space-y-3">
              <p role="alert" className="text-sm text-alert">{loadError}</p>
              <Button size="sm" variant="secondary" onClick={refresh}>
                Retry
              </Button>
            </div>
          ) : filtered === null ? (
            <div className="p-6">
              <SkeletonRows count={3} />
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Target}
              title={rows && rows.length > 0 ? 'No matches' : 'No active plans'}
              description={
                rows && rows.length > 0
                  ? 'No plan matches the current search or filter.'
                  : canManage
                    ? "Start a ramp plan when a new hire's first day is scheduled."
                    : "Your manager hasn't set one up yet."
              }
              action={
                canManage && (!rows || rows.length === 0) ? (
                  <Button onClick={() => setShowNew(true)}>
                    <Plus className="mr-2 h-4 w-4" /> New ramp plan
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="divide-y divide-navy-secondary">
              {filtered.map((p) => {
                const pct = p.total === 0 ? 0 : Math.round((p.achieved / p.total) * 100);
                return (
                  <button
                    key={p.id}
                    onClick={() => setOpen(p.associateId)}
                    className="w-full p-4 text-left hover:bg-navy-tertiary transition flex items-center gap-4"
                  >
                    <Target className="h-5 w-5 text-silver" />
                    <div className="flex-1">
                      <div className="text-sm font-medium text-white">
                        {p.associateName}
                      </div>
                      <div className="text-xs text-silver">
                        Started {fmtDate(parseYmd(p.startDate))}
                        {p.managerEmail && ` · Manager ${p.managerEmail}`}
                      </div>
                    </div>
                    <div className="text-xs text-silver">
                      <span className="text-white font-semibold">
                        {p.achieved}
                      </span>
                      {' / '}
                      {p.total} achieved
                      {p.missed > 0 && (
                        <span className="text-alert ml-2">
                          {p.missed} missed
                        </span>
                      )}
                    </div>
                    <div className="w-32 h-2 bg-navy-secondary rounded-full overflow-hidden">
                      <div
                        className="h-full bg-success"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {showNew && (
        <NewPlanDrawer
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
      {open && (
        <PlanDetailDrawer
          associateId={open}
          canManage={canManage}
          onClose={() => {
            setOpen(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function NewPlanDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [associate, setAssociate] = useState<PickedAssociate | null>(null);
  const [startDate, setStartDate] = useState(ymdLocal());
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!associate) {
      toast.error('Pick an associate.');
      return;
    }
    setSaving(true);
    try {
      await createRampPlan({
        associateId: associate.id,
        startDate,
        notes: notes.trim() || null,
      });
      toast.success('Ramp plan created with 30/60/90 milestones.');
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
        <DrawerTitle>New ramp plan</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Associate</Label>
          <div className="mt-1">
            <AssociatePicker value={associate} onChange={setAssociate} />
          </div>
        </div>
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
          <Label>Notes (optional)</Label>
          <Textarea
            className="mt-1 h-24"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="text-xs text-silver">
          Default 30/60/90-day milestones will be created. You can add more
          (Day 180, etc.) once the plan exists.
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Creating…' : 'Create plan'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function PlanDetailDrawer({
  associateId,
  canManage,
  onClose,
}: {
  associateId: string;
  canManage: boolean;
  onClose: () => void;
}) {
  const confirm = useConfirm();
  // undefined = loading; null = the associate has no active plan.
  const [plan, setPlan] = useState<RampPlan | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const refresh = () => {
    setPlan(undefined);
    setLoadError(null);
    getActivePlanForAssociate(associateId)
      .then((r) => setPlan(r.plan))
      .catch((err) =>
        setLoadError(
          err instanceof ApiError ? err.message : 'Failed to load the plan.',
        ),
      );
  };
  useEffect(() => {
    refresh();
  }, [associateId]);

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{plan?.associateName ?? 'Ramp plan'}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {loadError ? (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-alert">{loadError}</p>
            <Button size="sm" variant="secondary" onClick={refresh}>
              Retry
            </Button>
          </div>
        ) : plan === undefined ? (
          <SkeletonRows count={3} />
        ) : plan === null ? (
          <div className="text-sm text-silver">
            This associate has no active ramp plan.
          </div>
        ) : (
          <>
            <div className="text-sm text-silver">
              Started {fmtDate(parseYmd(plan.startDate))}
              {plan.managerEmail && ` · Manager ${plan.managerEmail}`}
            </div>
            {plan.notes && (
              <div className="text-sm italic text-silver">{plan.notes}</div>
            )}

            <div className="space-y-2">
              {plan.milestones.length === 0 ? (
                <div className="text-sm text-silver">No milestones yet.</div>
              ) : (
                plan.milestones.map((m) => (
                  <div
                    key={m.id}
                    className="p-3 rounded border border-navy-secondary"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline">Day {m.dayCheckpoint}</Badge>
                          <div className="text-sm font-medium text-white">
                            {m.title}
                          </div>
                        </div>
                        {m.description && (
                          <div className="text-xs text-silver mt-1">
                            {m.description}
                          </div>
                        )}
                        {m.notes && (
                          <div className="text-xs text-silver italic mt-1">
                            {m.notes}
                          </div>
                        )}
                      </div>
                      {canManage ? (
                        <Select
                          size="sm"
                          value={m.status}
                          onChange={async (e) => {
                            const next = e.target.value as RampMilestoneStatus;
                            try {
                              await updateMilestone(m.id, { status: next });
                              toast.success(
                                `Milestone marked ${STATUS_LABELS[next]}.`,
                              );
                              refresh();
                            } catch (err) {
                              toast.error(
                                err instanceof ApiError
                                  ? err.message
                                  : 'Failed.',
                              );
                            }
                          }}
                        >
                          {(Object.keys(STATUS_LABELS) as RampMilestoneStatus[]).map(
                            (s) => (
                              <option key={s} value={s}>
                                {STATUS_LABELS[s]}
                              </option>
                            ),
                          )}
                        </Select>
                      ) : (
                        <Badge variant={STATUS_VARIANT[m.status]}>
                          {STATUS_LABELS[m.status]}
                        </Badge>
                      )}
                      {canManage && (
                        <button
                          onClick={async () => {
                            if (!(await confirm({ title: `Delete "${m.title}"?`, destructive: true }))) return;
                            try {
                              await deleteMilestone(m.id);
                              toast.success('Milestone deleted.');
                              refresh();
                            } catch (err) {
                              toast.error(
                                err instanceof ApiError
                                  ? err.message
                                  : 'Failed.',
                              );
                            }
                          }}
                          className="text-silver hover:text-alert"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                    {m.achievedAt && (
                      <div className="text-xs text-success mt-1 flex items-center gap-1">
                        <CheckCircle2 className="h-3 w-3" /> Achieved{' '}
                        {fmtDate(m.achievedAt)}
                      </div>
                    )}
                    {m.status === 'MISSED' && (
                      <div className="text-xs text-alert mt-1 flex items-center gap-1">
                        <XCircle className="h-3 w-3" /> Missed
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>

            {canManage && (
              <div className="flex gap-2 pt-2">
                <Button size="sm" onClick={() => setShowAdd(true)}>
                  <Plus className="mr-1 h-3 w-3" /> Add milestone
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    if (!(await confirm({ title: 'Archive this plan?', destructive: true }))) return;
                    try {
                      await archiveRampPlan(plan.id);
                      toast.success('Archived.');
                      onClose();
                    } catch (err) {
                      toast.error(
                        err instanceof ApiError ? err.message : 'Failed.',
                      );
                    }
                  }}
                >
                  Archive plan
                </Button>
              </div>
            )}
          </>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>Close</Button>
      </DrawerFooter>
      {showAdd && plan && (
        <AddMilestoneDrawer
          planId={plan.id}
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            refresh();
          }}
        />
      )}
    </Drawer>
  );
}

function AddMilestoneDrawer({
  planId,
  onClose,
  onSaved,
}: {
  planId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [day, setDay] = useState('180');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!title.trim()) {
      toast.error('Title required.');
      return;
    }
    setSaving(true);
    try {
      await addMilestone(planId, {
        dayCheckpoint: parseInt(day, 10) || 180,
        title: title.trim(),
        description: description.trim() || null,
      });
      toast.success('Milestone added.');
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
        <DrawerTitle>Add milestone</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Day checkpoint</Label>
          <Input
            type="number"
            min="1"
            max="365"
            className="mt-1 max-w-[120px]"
            value={day}
            onChange={(e) => setDay(e.target.value)}
          />
        </div>
        <div>
          <Label>Title</Label>
          <Input
            className="mt-1"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div>
          <Label>Description (optional)</Label>
          <Textarea
            className="mt-1 h-24"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Add'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
