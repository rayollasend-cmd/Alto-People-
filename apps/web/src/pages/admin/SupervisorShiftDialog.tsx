import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRightLeft, Clock } from 'lucide-react';
import { toast } from 'sonner';
import { fmtShiftWindow } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import {
  getLeadFloorTeam,
  listClientShiftWindows,
  setFloorSupervisorLead,
  setSupervisorShiftWindows,
  type ClientShiftSupervisor,
  type LeadFloorTeam,
  type StoreShiftWindows,
} from '@/lib/shiftWindowsApi';
import type { AdminUser } from '@/lib/usersAdminApi';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Skeleton } from '@/components/ui/Skeleton';
import { HandOverDialog } from '@/components/FloorTeam';
import { cn } from '@/lib/cn';

const keyOf = (locationId: string, label: string) => `${locationId}|${label}`;

/**
 * Assign a supervisor their shift — the store shift windows they lead (a
 * shift supervisor) or work (a floor supervisor), picked the way their
 * client is. Focus, not a lock: it's where their pages open and who hears
 * about a shift first; they still see the whole store. Every supervisor
 * has at least one once the client's stores name any.
 *
 * A floor supervisor then gets the shift supervisor in charge of them —
 * whoever leads the shift they picked is suggested; any shift supervisor
 * at the client can be chosen (covering while the usual lead is out).
 *
 * For a shift supervisor, HR / Workforce can hand their shift to one of
 * their floor supervisors from here — the day they're out sick at home.
 */
export type ShiftDialogUser = Pick<
  AdminUser,
  'id' | 'email' | 'associateName' | 'clientId' | 'clientName' | 'shiftWindows' | 'role' | 'leadUserId' | 'leadName'
>;

export function SupervisorShiftDialog({
  user,
  open,
  onOpenChange,
  onSaved,
  readOnly = false,
}: {
  user: ShiftDialogUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  /** A viewer who can see assignments but not change them (manage:org). */
  readOnly?: boolean;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // null = not chosen by hand yet: follow the suggestion.
  const [leadPick, setLeadPick] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [team, setTeam] = useState<LeadFloorTeam | null>(null);
  const [handOverOpen, setHandOverOpen] = useState(false);
  const who = user.associateName ?? user.email;
  const first = who.split(' ')[0] ?? who;
  const isFloor = user.role === 'FLOOR_SUPERVISOR';

  const storesQuery = useQuery({
    queryKey: ['SupervisorShiftDialog', 'stores', open, user.clientId, user.shiftWindows, user.leadUserId, user.role, user.id, readOnly],
    queryFn: () => listClientShiftWindows(user.clientId!),
    enabled: !(!open || !user.clientId),
  });
  const stores: StoreShiftWindows[] | null = storesQuery.data?.stores ?? null;
  const supervisors: ClientShiftSupervisor[] = storesQuery.data ? storesQuery.data.supervisors ?? [] : [];
  const loadError = storesQuery.isError;
  useEffect(() => {
    setPicked(new Set((user.shiftWindows ?? []).map((w) => keyOf(w.locationId, w.label))));
    setLeadPick(user.leadUserId ?? null);
  }, [open, user.clientId, user.shiftWindows, user.leadUserId, user.role, user.id, readOnly]);
  const team2Query = useQuery({
    queryKey: ['SupervisorShiftDialog', 'team', open, user.clientId, user.shiftWindows, user.leadUserId, user.role, user.id, readOnly],
    queryFn: () => getLeadFloorTeam(user.id),
    enabled: !(!open || !user.clientId) && (user.role === 'SHIFT_SUPERVISOR' && !readOnly),
  });
  useEffect(() => {
    const t = team2Query.data;
    if (t === undefined) return;
    setTeam(t);
  }, [team2Query.data]);
  useEffect(() => {
    if (!team2Query.isError) return;
    setTeam(null);
  }, [team2Query.isError, team2Query.error]);

  const withWindows = useMemo(() => (stores ?? []).filter((s) => s.windows.length > 0), [stores]);
  const defined = withWindows.length > 0;

  // Floor supervisor: who leads the shifts they picked — suggested first.
  const leadsPicked = (s: ClientShiftSupervisor) => s.windows.some((w) => picked.has(keyOf(w.locationId, w.label)));
  const orderedSups = useMemo(
    () => [...supervisors].sort((a, b) => Number(leadsPicked(b)) - Number(leadsPicked(a)) || a.name.localeCompare(b.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [supervisors, picked],
  );
  const suggested = orderedSups.find(leadsPicked) ?? null;
  const leadId = leadPick ?? suggested?.userId ?? '';
  const lead = supervisors.find((s) => s.userId === leadId) ?? null;
  const needsLead = isFloor && supervisors.length > 0 && !leadId;

  const toggle = (k: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const save = async () => {
    setSaving(true);
    try {
      await setSupervisorShiftWindows(
        user.id,
        [...picked].map((k) => {
          const [locationId, ...rest] = k.split('|');
          return { locationId: locationId!, label: rest.join('|') };
        }),
      );
      if (isFloor && (leadId || user.leadUserId)) {
        await setFloorSupervisorLead(user.id, leadId || null);
      }
      toast.success(
        isFloor && lead
          ? `Shift assigned — ${first} reports to ${lead.name}.`
          : picked.size === 1
            ? 'Shift assigned.'
            : `${picked.size} shifts assigned.`,
      );
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {who}’s shift{isFloor ? ' and shift supervisor' : ''}
          </DialogTitle>
          <DialogDescription>
            {isFloor
              ? `The shift ${who} works at ${user.clientName ?? 'this client'}, and the shift supervisor in charge of them — whose SOP they help on, who can hand them the shift, and who hears first if they're late.`
              : `The shifts ${who} leads at ${user.clientName ?? 'this client'}. Their pages open on these hours and shift alerts reach them first. They still see the whole store.`}
          </DialogDescription>
        </DialogHeader>

        {loadError ? (
          <p className="text-sm text-alert">Couldn’t load this client’s shifts. Close and try again.</p>
        ) : stores === null ? (
          <div className="space-y-2">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : !defined ? (
          <div className="rounded-md border border-navy-secondary bg-navy-secondary/30 p-4 text-sm text-silver">
            {user.clientName ?? 'This client'} hasn’t named its shifts yet. Add them as shift windows
            on each store’s staffing targets in{' '}
            <Link to="/labor-costs" className="text-gold underline underline-offset-2">
              Labor costs
            </Link>
            , then come back to assign one.
          </div>
        ) : (
          <div className="max-h-[55dvh] space-y-4 overflow-y-auto pr-1">
            {withWindows.map((s) => (
              <fieldset key={s.locationId}>
                <legend className="mb-1.5 text-xs uppercase tracking-wide text-silver/80">
                  {s.locationName}
                </legend>
                <div className="space-y-1.5">
                  {s.windows.map((w) => {
                    const k = keyOf(s.locationId, w.label);
                    const on = picked.has(k);
                    const others = w.leads.filter((l) => l.userId !== user.id);
                    return (
                      <label
                        key={k}
                        className={cn(
                          'flex items-center gap-3 rounded-md border px-3 py-2.5 transition',
                          !readOnly && 'cursor-pointer',
                          on
                            ? 'border-gold/50 bg-gold/10'
                            : 'border-navy-secondary bg-navy-secondary/30 hover:border-silver/30',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggle(k)}
                          disabled={readOnly}
                          className="h-4 w-4 accent-gold"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <span className="text-sm font-medium text-white">{w.label}</span>
                            <span className="inline-flex items-center gap-1 text-xs text-silver">
                              <Clock className="h-3 w-3" aria-hidden="true" />
                              {fmtShiftWindow(w)}
                            </span>
                          </div>
                          <div className="text-xs2 text-silver/80">
                            Target {w.targetCount} ·{' '}
                            {isFloor
                              ? others.length > 0
                                ? `Led by ${others.map((l) => l.name).join(', ')}`
                                : 'No shift supervisor leads this shift yet'
                              : others.length > 0
                                ? `Also led by ${others.map((l) => l.name).join(', ')}`
                                : on
                                  ? `${who} leads it`
                                  : 'Nobody leads this shift yet'}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ))}

            {isFloor && (
              <fieldset>
                <legend className="mb-1.5 text-xs uppercase tracking-wide text-silver/80">
                  Shift supervisor in charge of {first}
                </legend>
                {supervisors.length === 0 ? (
                  <p className="text-sm text-warning">
                    {user.clientName ?? 'This client'} has no shift supervisor yet — assign one there first.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {orderedSups.map((sup) => {
                      const on = leadId === sup.userId;
                      const theirs = [...new Set(sup.windows.map((w) => w.label))];
                      return (
                        <label
                          key={sup.userId}
                          className={cn(
                            'flex items-center gap-3 rounded-md border px-3 py-2.5 transition',
                            !readOnly && 'cursor-pointer',
                            on
                              ? 'border-gold/50 bg-gold/10'
                              : 'border-navy-secondary bg-navy-secondary/30 hover:border-silver/30',
                          )}
                        >
                          <input
                            type="radio"
                            name="lead"
                            checked={on}
                            onChange={() => setLeadPick(sup.userId)}
                            disabled={readOnly}
                            className="h-4 w-4 accent-gold"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-baseline gap-x-2">
                              <span className="text-sm font-medium text-white">{sup.name}</span>
                              {suggested?.userId === sup.userId && (
                                <span className="text-2xs font-medium uppercase tracking-wider text-gold">
                                  Suggested
                                </span>
                              )}
                            </div>
                            <div className="text-xs2 text-silver/80">
                              {theirs.length > 0 ? `Leads ${theirs.join(', ')}` : 'No shift assigned'}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
                {lead && picked.size > 0 && !leadsPicked(lead) && (
                  <p className="mt-1.5 text-xs text-warning">
                    {lead.name} doesn’t lead {first}’s shift — fine while covering, but the suggestion is whoever
                    does.
                  </p>
                )}
              </fieldset>
            )}
          </div>
        )}

        <DialogFooter>
          {team && team.team.length > 0 && (
            <Button variant="outline" className="mr-auto" onClick={() => setHandOverOpen(true)}>
              <ArrowRightLeft className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Hand over {first}’s shift
            </Button>
          )}
          {defined && !readOnly && picked.size === 0 && (
            <span className="mr-auto self-center text-xs text-warning">Pick at least one shift.</span>
          )}
          {defined && !readOnly && picked.size > 0 && needsLead && (
            <span className="mr-auto self-center text-xs text-warning">Pick their shift supervisor.</span>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {defined && !readOnly ? 'Cancel' : 'Close'}
          </Button>
          {defined && !readOnly && (
            <Button onClick={() => void save()} loading={saving} disabled={picked.size === 0 || needsLead}>
              Save
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
      {team && handOverOpen && (
        <HandOverDialog
          open
          onOpenChange={setHandOverOpen}
          team={team.team}
          today={team.today}
          lead={{ userId: user.id, name: who }}
          onSaved={() => {
            void getLeadFloorTeam(user.id).then(setTeam).catch(() => undefined);
          }}
        />
      )}
    </Dialog>
  );
}
