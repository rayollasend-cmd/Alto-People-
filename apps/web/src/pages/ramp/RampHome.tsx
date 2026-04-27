import { useEffect, useState } from 'react';
import { CheckCircle2, Plus, Target, Trash2, XCircle } from 'lucide-react';
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
} from '@/components/ui';
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
  const [open, setOpen] = useState<string | null>(null); // associateId
  const [showNew, setShowNew] = useState(false);

  const refresh = () => {
    setRows(null);
    listRampPlans()
      .then((r) => setRows(r.plans))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Ramp plans"
        subtitle="30/60/90-day milestones for new hires. Manager updates status as the new hire progresses."
        breadcrumbs={[{ label: 'Workforce' }, { label: 'Ramp plans' }]}
      />

      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> New ramp plan
          </Button>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6">
              <SkeletonRows count={3} />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Target}
              title="No active plans"
              description={
                canManage
                  ? "Start a ramp plan when a new hire's first day is scheduled."
                  : "Your manager hasn't set one up yet."
              }
            />
          ) : (
            <div className="divide-y divide-navy-secondary">
              {rows.map((p) => {
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
                        Started {p.startDate}
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
                        <span className="text-destructive ml-2">
                          {p.missed} missed
                        </span>
                      )}
                    </div>
                    <div className="w-32 h-2 bg-navy-secondary rounded-full overflow-hidden">
                      <div
                        className="h-full bg-green-500"
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
  const [associateId, setAssociateId] = useState('');
  const [startDate, setStartDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!associateId.trim()) {
      toast.error('Associate ID required.');
      return;
    }
    setSaving(true);
    try {
      await createRampPlan({
        associateId: associateId.trim(),
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
          <Label>Associate ID</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={associateId}
            onChange={(e) => setAssociateId(e.target.value)}
          />
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
          <textarea
            className="mt-1 w-full h-24 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm"
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
  const [plan, setPlan] = useState<RampPlan | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const refresh = () => {
    setPlan(null);
    getActivePlanForAssociate(associateId)
      .then((r) => setPlan(r.plan))
      .catch(() => setPlan(null));
  };
  useEffect(() => {
    refresh();
  }, [associateId]);

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{plan?.associateName ?? 'Loading…'}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {!plan ? (
          <SkeletonRows count={3} />
        ) : (
          <>
            <div className="text-sm text-silver">
              Started {plan.startDate}
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
                        <select
                          className="text-xs bg-midnight border border-navy-secondary rounded p-1 text-white"
                          value={m.status}
                          onChange={async (e) => {
                            try {
                              await updateMilestone(m.id, {
                                status: e.target.value as RampMilestoneStatus,
                              });
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
                        </select>
                      ) : (
                        <Badge variant={STATUS_VARIANT[m.status]}>
                          {STATUS_LABELS[m.status]}
                        </Badge>
                      )}
                      {canManage && (
                        <button
                          onClick={async () => {
                            if (!window.confirm(`Delete "${m.title}"?`)) return;
                            try {
                              await deleteMilestone(m.id);
                              refresh();
                            } catch (err) {
                              toast.error(
                                err instanceof ApiError
                                  ? err.message
                                  : 'Failed.',
                              );
                            }
                          }}
                          className="text-silver hover:text-destructive"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                    {m.achievedAt && (
                      <div className="text-xs text-green-400 mt-1 flex items-center gap-1">
                        <CheckCircle2 className="h-3 w-3" /> Achieved{' '}
                        {new Date(m.achievedAt).toLocaleDateString()}
                      </div>
                    )}
                    {m.status === 'MISSED' && (
                      <div className="text-xs text-destructive mt-1 flex items-center gap-1">
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
                    if (!window.confirm('Archive this plan?')) return;
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
          <textarea
            className="mt-1 w-full h-24 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm"
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
