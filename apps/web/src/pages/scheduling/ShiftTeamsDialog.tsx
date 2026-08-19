import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Plus, Trash2, Users, X } from 'lucide-react';
import type { ShiftTeam, ShiftTeamDetailResponse } from '@alto-people/shared';
import {
  addShiftTeamMember,
  assignTeamMemberHere,
  createShiftTeam,
  deleteShiftTeam,
  getShiftTeam,
  listShiftTeams,
  removeShiftTeamMember,
  updateShiftTeam,
} from '@/lib/schedulingApi';
import { ApiError } from '@/lib/api';
import { useConfirm } from '@/lib/confirm';
import { AssociatePicker } from '@/components/ui/AssociatePicker';
import { Button } from '@/components/ui/Button';
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { toast } from '@/components/ui/Toaster';
import { cn } from '@/lib/cn';

function minuteToTime(m: number | null): string {
  if (m == null) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

function timeToMinute(t: string): number | null {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/**
 * Manage the standing crews at one work site — create/rename/delete teams
 * and maintain their member lists. The scheduling page's Shift filter and
 * pickers read these teams to scope the roster.
 */
export function ShiftTeamsDialog({
  open,
  onOpenChange,
  clientId,
  locationId,
  locationName,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientId: string;
  locationId: string;
  locationName: string | null;
  onChanged: () => void;
}) {
  const confirm = useConfirm();
  const [teams, setTeams] = useState<ShiftTeam[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ShiftTeamDetailResponse | null>(null);
  const [newName, setNewName] = useState('');
  const [newStart, setNewStart] = useState('');
  const [newEnd, setNewEnd] = useState('');
  const [busy, setBusy] = useState(false);
  // Edit fields for the selected team.
  const [editName, setEditName] = useState('');
  const [editStart, setEditStart] = useState('');
  const [editEnd, setEditEnd] = useState('');

  const refreshTeams = useCallback(async () => {
    try {
      const r = await listShiftTeams({ locationId });
      setTeams(r.teams);
      return r.teams;
    } catch {
      setTeams([]);
      return [];
    }
  }, [locationId]);

  useEffect(() => {
    if (!open) return;
    setTeams(null);
    setSelectedId(null);
    setDetail(null);
    setNewName('');
    setNewStart('');
    setNewEnd('');
    void refreshTeams();
  }, [open, refreshTeams]);

  const loadDetail = useCallback(async (id: string) => {
    setSelectedId(id);
    setDetail(null);
    try {
      const d = await getShiftTeam(id);
      setDetail(d);
      setEditName(d.team.name);
      setEditStart(minuteToTime(d.team.startMinute));
      setEditEnd(minuteToTime(d.team.endMinute));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load team.');
      setSelectedId(null);
    }
  }, []);

  const onCreate = async () => {
    if (!newName.trim() || busy) return;
    setBusy(true);
    try {
      const created = await createShiftTeam({
        clientId,
        locationId,
        name: newName.trim(),
        startMinute: timeToMinute(newStart),
        endMinute: timeToMinute(newEnd),
      });
      setNewName('');
      setNewStart('');
      setNewEnd('');
      await refreshTeams();
      onChanged();
      void loadDetail(created.id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Create failed.');
    } finally {
      setBusy(false);
    }
  };

  const onSaveEdits = async () => {
    if (!selectedId || !editName.trim() || busy) return;
    setBusy(true);
    try {
      await updateShiftTeam(selectedId, {
        name: editName.trim(),
        startMinute: timeToMinute(editStart),
        endMinute: timeToMinute(editEnd),
      });
      await refreshTeams();
      await loadDetail(selectedId);
      onChanged();
      toast.success('Team updated.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Update failed.');
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (!selectedId || busy) return;
    const ok = await confirm({
      title: 'Delete this shift team?',
      description:
        'Its members are not affected — only the grouping goes away.',
      confirmLabel: 'Delete team',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await deleteShiftTeam(selectedId);
      setSelectedId(null);
      setDetail(null);
      await refreshTeams();
      onChanged();
      toast.success('Team deleted.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Delete failed.');
    } finally {
      setBusy(false);
    }
  };

  const onAddMember = async (associateId: string) => {
    if (!selectedId || busy) return;
    setBusy(true);
    try {
      await addShiftTeamMember(selectedId, associateId);
      await loadDetail(selectedId);
      await refreshTeams();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not add member.');
    } finally {
      setBusy(false);
    }
  };

  const onRemoveMember = async (associateId: string) => {
    if (!selectedId || busy) return;
    setBusy(true);
    try {
      await removeShiftTeamMember(selectedId, associateId);
      await loadDetail(selectedId);
      await refreshTeams();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not remove member.');
    } finally {
      setBusy(false);
    }
  };

  const onAssignHere = async (associateId: string) => {
    if (!selectedId || busy) return;
    setBusy(true);
    try {
      await assignTeamMemberHere(selectedId, associateId);
      await loadDetail(selectedId);
      onChanged(); // location-scoped rosters now include them
      toast.success('Assigned to this site.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not assign to this site.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Shift teams{locationName ? ` — ${locationName}` : ''}</DialogTitle>
          <DialogDescription>
            Standing crews at this site (e.g. “Morning”, “Overnight”). Pick a
            team in the schedule’s Shift filter to see only its members when
            building the week.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-[16rem_1fr] gap-4">
          {/* Team list + create */}
          <div className="space-y-2">
            {teams === null ? (
              <SkeletonRows count={3} rowHeight="h-14" />
            ) : teams.length === 0 ? (
              <div className="text-sm text-silver">No teams yet — create one below.</div>
            ) : (
              <ul className="space-y-1">
                {teams.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => void loadDetail(t.id)}
                      className={cn(
                        'w-full rounded-md border px-3 py-2 text-left text-sm transition-colors',
                        t.id === selectedId
                          ? 'border-gold/50 bg-gold/10 text-white'
                          : 'border-navy-secondary bg-navy-secondary/30 text-silver hover:text-white',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate">{t.name}</span>
                        <span className="inline-flex items-center gap-1 text-xs text-silver/70 tabular-nums">
                          <Users className="h-3 w-3" />
                          {t.memberCount}
                        </span>
                      </div>
                      {t.startMinute != null && t.endMinute != null && (
                        <div className="text-xs2 text-silver/60 tabular-nums">
                          {minuteToTime(t.startMinute)} – {minuteToTime(t.endMinute)}
                        </div>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="rounded-md border border-dashed border-navy-secondary p-2 space-y-2">
              <Input
                placeholder="New team name (e.g. Morning)"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={80}
              />
              <div className="flex items-center gap-1">
                <Input
                  type="time"
                  aria-label="Default start time"
                  value={newStart}
                  onChange={(e) => setNewStart(e.target.value)}
                />
                <span className="text-silver/60 text-xs">–</span>
                <Input
                  type="time"
                  aria-label="Default end time"
                  value={newEnd}
                  onChange={(e) => setNewEnd(e.target.value)}
                />
              </div>
              <Button
                size="sm"
                onClick={onCreate}
                disabled={!newName.trim() || busy}
                className="w-full"
              >
                <Plus className="h-3.5 w-3.5" />
                Create team
              </Button>
            </div>
          </div>

          {/* Selected team detail */}
          <div>
            {!selectedId ? (
              <div className="flex h-full items-center justify-center rounded-md border border-navy-secondary/60 p-8 text-sm text-silver">
                Select a team to manage its members.
              </div>
            ) : detail === null ? (
              <div className="space-y-4">
                <Skeleton className="h-9 w-full" />
                <SkeletonRows count={3} rowHeight="h-10" />
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="grow min-w-[10rem]">
                    <div className="mb-1 text-2xs uppercase tracking-widest text-silver">
                      Name
                    </div>
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      maxLength={80}
                    />
                  </div>
                  <div>
                    <div className="mb-1 text-2xs uppercase tracking-widest text-silver">
                      Default times
                    </div>
                    <div className="flex items-center gap-1">
                      <Input
                        type="time"
                        aria-label="Edit default start time"
                        value={editStart}
                        onChange={(e) => setEditStart(e.target.value)}
                      />
                      <span className="text-silver/60 text-xs">–</span>
                      <Input
                        type="time"
                        aria-label="Edit default end time"
                        value={editEnd}
                        onChange={(e) => setEditEnd(e.target.value)}
                      />
                    </div>
                  </div>
                  <Button size="sm" variant="secondary" onClick={onSaveEdits} disabled={busy}>
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={onDelete}
                    disabled={busy}
                    aria-label="Delete team"
                    title="Delete team"
                  >
                    <Trash2 className="h-4 w-4 text-alert" />
                  </Button>
                </div>

                <div>
                  <div className="mb-1 text-2xs uppercase tracking-widest text-silver">
                    Add member
                  </div>
                  <AssociatePicker
                    value={null}
                    onChange={(v) => {
                      if (v) void onAddMember(v.id);
                    }}
                    placeholder="Search the directory by name…"
                  />
                </div>

                <div>
                  <div className="mb-1 text-2xs uppercase tracking-widest text-silver">
                    Members{' '}
                    <span className="tabular-nums text-silver/70">
                      {detail.members.length}
                    </span>
                  </div>
                  {detail.members.length === 0 ? (
                    <p className="text-sm text-silver">
                      Nobody yet — add associates above.
                    </p>
                  ) : (
                    <ul className="divide-y divide-navy-secondary rounded-md border border-navy-secondary">
                      {detail.members.map((m) => (
                        <li
                          key={m.associateId}
                          className="flex items-center gap-2 px-3 py-2 text-sm"
                        >
                          <span className="text-white">
                            {m.firstName} {m.lastName}
                          </span>
                          <span className="text-silver/70 text-xs truncate">
                            {m.email}
                          </span>
                          {!m.atLocation && (
                            <span className="inline-flex items-center gap-1.5">
                              <span
                                className="inline-flex items-center gap-1 text-xs text-warning"
                                title="Nothing on their record points at this location — often an invite where no work site was picked, so approval never opened an assignment."
                              >
                                <AlertTriangle className="h-3.5 w-3.5" />
                                not at this site
                              </span>
                              <button
                                type="button"
                                onClick={() => void onAssignHere(m.associateId)}
                                disabled={busy}
                                className="text-xs text-gold hover:underline focus:underline focus:outline-none disabled:opacity-50"
                                title="Record this site as their work location (opens an assignment here)"
                              >
                                Assign to this site
                              </button>
                            </span>
                          )}
                          {m.portalActive === false && (
                            <span
                              className="text-xs2 text-silver/60"
                              title="Their portal login isn't active (invite not accepted, or access was re-sent). They can still be scheduled — this only affects signing in."
                            >
                              no portal access
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => void onRemoveMember(m.associateId)}
                            className="ml-auto text-silver/60 hover:text-alert"
                            aria-label={`Remove ${m.firstName} ${m.lastName}`}
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
