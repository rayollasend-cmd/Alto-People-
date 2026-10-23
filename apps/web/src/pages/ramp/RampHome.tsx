import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Download, Plus, Target, Trash2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { urlBoolean, useUrlState } from '@/lib/useUrlState';
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
  type RampTemplate,
  TEMPLATE_LABELS,
  listRampOwners,
} from '@/lib/ramp125Api';
import { useAuth, useTerm } from '@/lib/auth';
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
  Select,
  SkeletonRows,
  Textarea,
} from '@/components/ui';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { fmtDate, parseYmd, ymdLocal } from '@/lib/format';
import { downloadCsv } from '@/lib/csv';
import { statusTone } from '@/lib/status';
import { ListTemplate } from '@/components/templates';
import { Label } from '@/components/ui/Label';
import { pickOne } from '@/lib/validationCopy';

// Ramp-only milestone codes the shared vocabulary doesn't carry: ON_TRACK is
// an in-flight state (gold per the Badge contract), ACHIEVED is terminal-good
// and MISSED terminal-bad. PENDING comes from the shared map.
const RAMP_STATUS_TONES = {
  ON_TRACK: 'accent',
  ACHIEVED: 'success',
  MISSED: 'destructive',
} as const;

export function RampHome() {
  const term = useTerm();
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:onboarding') : false;
  const [open, setOpen] = useState<string | null>(null); // associateId
  const [showNew, setShowNew] = useState(false);
  const [search, setSearch] = useState('');
  // ?missed=1 — plans with a missed milestone, kept in the URL.
  const [missedOnly, setMissedOnly] = useUrlState('missed', false, urlBoolean);

  const refreshQuery = useQuery({
    queryKey: ['RampHome', 'rows'],
    queryFn: () => listRampPlans(),
  });
  const rows: RampPlanRow[] | null = refreshQuery.data?.plans ?? null;
  const loadError = refreshQuery.error ? refreshQuery.error instanceof ApiError ? refreshQuery.error.message : 'Failed to load ramp plans.' : null;
  const refresh = () => void refreshQuery.refetch();

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
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title="30/60/90 plans"
        subtitle={`Every new hire's first weeks, from the first shift on — owned by their manager or the ${term('label.store').toLowerCase()}’s ${term('role.shiftSupervisor').toLowerCase()}.`}
        actions={[
          ...(canManage ? [{ label: 'New ramp plan', icon: Plus, primary: true, onSelect: () => setShowNew(true) }] : []),
          { label: 'Export CSV', icon: Download, onSelect: onExportCsv, hidden: !filtered || filtered.length === 0 },
        ]}
    >

      {/* No search or filter over an empty list. */}
      {rows && rows.length > 0 && (
        <FilterBar
          bare
          search={
            <Input
              placeholder="Search by name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full sm:max-w-xs"
              aria-label={`Search plans by ${term('worker').toLowerCase()} name`}
            />
          }
        >
          <FilterChip active={missedOnly} onClick={() => setMissedOnly(!missedOnly)} count={rows.filter((p) => p.missed > 0).length}>
            Has missed milestones
          </FilterChip>
        </FilterBar>
      )}

      <Card>
        <CardContent className="p-0">
          {loadError ? (
            <div className="p-6">
              <ErrorBanner
                action={
                  <Button size="sm" variant="secondary" onClick={refresh}>
                    Retry
                  </Button>
                }
              >
                {loadError}
              </ErrorBanner>
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
                  <Button variant="outline" onClick={() => setShowNew(true)}>
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
                        {(p.managerName || p.managerEmail) && ` · Owner ${p.managerName ?? p.managerEmail}`}
                        {p.template === 'SEASONAL' && ' · Seasonal'}
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
                    <RampMiniTimeline row={p} pct={pct} />
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
    </ListTemplate>
  );
}

function NewPlanDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const term = useTerm();
  const [associate, setAssociate] = useState<PickedAssociate | null>(null);
  const [startDate, setStartDate] = useState(ymdLocal());
  const [notes, setNotes] = useState('');
  const [template, setTemplate] = useState<RampTemplate>('STANDARD');
  const [ownerId, setOwnerId] = useState('');
  const [saving, setSaving] = useState(false);
  const owners = useQuery({ queryKey: ['ramp', 'owners'], queryFn: listRampOwners });

  const submit = async () => {
    if (!associate) {
      toast.error(pickOne(term));
      return;
    }
    setSaving(true);
    try {
      await createRampPlan({
        associateId: associate.id,
        startDate,
        notes: notes.trim() || null,
        template,
        managerId: ownerId || null,
      });
      toast.success(template === 'SEASONAL' ? 'Plan created for the season, from the first shift on.' : 'Plan created, from the first shift to day 90.');
      onSaved();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Could not create the plan.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>New 30/60/90 plan</DrawerTitle>
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
          <Label htmlFor="ramp-template">Plan</Label>
          <Select id="ramp-template" className="mt-1" value={template} onChange={(e) => setTemplate(e.target.value as RampTemplate)}>
            {(Object.keys(TEMPLATE_LABELS) as RampTemplate[]).map((t) => (
              <option key={t} value={t}>
                {TEMPLATE_LABELS[t]}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="ramp-owner">Owner</Label>
          <Select id="ramp-owner" className="mt-1" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">Nobody yet</option>
            {(owners.data?.owners ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
                {o.siteName ? ` — ${o.siteName}` : ''}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-silver">Their manager, or the shift supervisor at the store they start at.</p>
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
          The plan's checkpoints are created from the template. You can add
          more once the plan exists.
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
  const [showAdd, setShowAdd] = useState(false);
  // One in-flight action at a time — a double-click on Delete/Archive
  // used to fire the write twice.
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

  const refreshQuery = useQuery({
    queryKey: ['PlanDetailDrawer', 'plan', associateId],
    queryFn: () => getActivePlanForAssociate(associateId),
  });
  const plan: RampPlan | null | undefined = refreshQuery.data?.plan ?? undefined;
  const loadError = refreshQuery.error ? refreshQuery.error instanceof ApiError ? refreshQuery.error.message : 'Failed to load the plan.' : null;
  const refresh = () => void refreshQuery.refetch();

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{plan?.associateName ?? 'Ramp plan'}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {loadError ? (
          <ErrorBanner
            action={
              <Button size="sm" variant="secondary" onClick={refresh}>
                Retry
              </Button>
            }
          >
            {loadError}
          </ErrorBanner>
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

            <ol className="relative space-y-2 border-l-2 border-line pl-5" aria-label="The plan's timeline">
              {plan.milestones.length === 0 ? (
                <li className="list-none"><EmptyState size="sm" title={"No milestones yet."} /></li>
              ) : (
                plan.milestones.map((m) => (
                  <li
                    key={m.id}
                    className="relative p-3 rounded border border-navy-secondary"
                  >
                    <span
                      aria-hidden="true"
                      className={`absolute -left-[1.65rem] top-4 h-3 w-3 rounded-full border-2 ${m.status === 'ACHIEVED' ? 'border-success bg-success' : m.status === 'MISSED' ? 'border-alert bg-alert' : m.status === 'ON_TRACK' ? 'border-accent bg-accent' : 'border-line bg-surface'}`}
                    />
                    <div className="mb-1 text-2xs uppercase tracking-wider text-ink-muted">
                      {checkpointLabel(m.dayCheckpoint)} · {fmtDate(addDaysYmd(plan.startDate, m.dayCheckpoint - 1))}
                    </div>
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
                                  : 'Could not update the milestone.',
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
                        <Badge variant={statusTone(m.status, { overrides: RAMP_STATUS_TONES })}>
                          {STATUS_LABELS[m.status]}
                        </Badge>
                      )}
                      {canManage && (
                        <button
                          aria-label={`Delete milestone ${m.title}`}
                          disabled={actionKey !== null}
                          onClick={async () => {
                            if (!(await confirm({ title: `Delete "${m.title}"?`, destructive: true }))) return;
                            await act(`del-${m.id}`, async () => {
                              try {
                                await deleteMilestone(m.id);
                                toast.success('Milestone deleted.');
                                refresh();
                              } catch (err) {
                                toast.error(
                                  err instanceof ApiError
                                    ? err.message
                                    : 'Could not delete the milestone.',
                                );
                              }
                            });
                          }}
                          className="text-silver hover:text-alert disabled:opacity-40"
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
                  </li>
                ))
              )}
            </ol>

            {canManage && (
              <div className="flex gap-2 pt-2">
                <Button size="sm" onClick={() => setShowAdd(true)}>
                  <Plus className="mr-1 h-3 w-3" /> Add milestone
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={actionKey === 'archive'}
                  disabled={actionKey !== null}
                  onClick={async () => {
                    if (!(await confirm({ title: 'Archive this plan?', destructive: true }))) return;
                    await act('archive', async () => {
                      try {
                        await archiveRampPlan(plan.id);
                        toast.success('Plan archived.');
                        onClose();
                      } catch (err) {
                        toast.error(
                          err instanceof ApiError
                            ? err.message
                            : 'Could not archive the plan.',
                        );
                      }
                    });
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
      toast.error('Title is required.');
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
      toast.error(
        err instanceof ApiError ? err.message : 'Could not add the milestone.',
      );
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

/** "First shift", "Week 2", "Day 30" — how a checkpoint reads on the timeline. */
function checkpointLabel(day: number): string {
  if (day <= 1) return 'First shift';
  if (day % 7 === 0 && day <= 56) return `Week ${day / 7}`;
  return `Day ${day}`;
}

/** YYYY-MM-DD plus n days, as a local date. */
function addDaysYmd(ymd: string, n: number): Date | null {
  const d = parseYmd(ymd);
  if (!d) return null;
  d.setDate(d.getDate() + n);
  return d;
}

const DOT: Record<RampMilestoneStatus, string> = {
  ACHIEVED: 'bg-success border-success',
  MISSED: 'bg-alert border-alert',
  ON_TRACK: 'bg-accent border-accent',
  PENDING: 'bg-surface border-line',
};

/** The plan's checkpoints on one line, placed by day, with an accessible progress value. */
function RampMiniTimeline({ row, pct }: { row: RampPlanRow; pct: number }) {
  const ms = row.milestones ?? [];
  const last = Math.max(1, ...ms.map((m) => m.dayCheckpoint));
  return (
    <div className="w-40 shrink-0">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={`${row.associateName}: ${row.achieved} of ${row.total} milestones achieved`}
        className="relative h-3"
      >
        <span aria-hidden="true" className="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-line" />
        {ms.map((m) => (
          <span
            key={`${m.dayCheckpoint}-${m.title}`}
            aria-hidden="true"
            title={`${checkpointLabel(m.dayCheckpoint)}: ${m.title} — ${STATUS_LABELS[m.status]}`}
            className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 ${DOT[m.status]}`}
            style={{ left: `${(m.dayCheckpoint / last) * 100}%` }}
          />
        ))}
      </div>
    </div>
  );
}
