import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Clock } from 'lucide-react';
import { toast } from 'sonner';
import { fmtShiftWindow } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import {
  listClientShiftWindows,
  setSupervisorShiftWindows,
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
import { cn } from '@/lib/cn';

const keyOf = (locationId: string, label: string) => `${locationId}|${label}`;

/**
 * Assign a shift supervisor their shift — the store shift windows they lead,
 * picked the way their client is. Focus, not a lock: it's where their pages
 * open and who hears about a shift first; they still see the whole store.
 * Every supervisor has at least one once the client's stores name any.
 */
export type ShiftDialogUser = Pick<
  AdminUser,
  'id' | 'email' | 'associateName' | 'clientId' | 'clientName' | 'shiftWindows'
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
  const [stores, setStores] = useState<StoreShiftWindows[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const who = user.associateName ?? user.email;

  useEffect(() => {
    if (!open || !user.clientId) return;
    let live = true;
    setStores(null);
    setLoadError(false);
    setPicked(new Set((user.shiftWindows ?? []).map((w) => keyOf(w.locationId, w.label))));
    listClientShiftWindows(user.clientId)
      .then((r) => live && setStores(r.stores))
      .catch(() => live && setLoadError(true));
    return () => {
      live = false;
    };
  }, [open, user.clientId, user.shiftWindows]);

  const withWindows = useMemo(() => (stores ?? []).filter((s) => s.windows.length > 0), [stores]);
  const defined = withWindows.length > 0;

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
      toast.success(picked.size === 1 ? 'Shift assigned.' : `${picked.size} shifts assigned.`);
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
          <DialogTitle>{who}’s shift</DialogTitle>
          <DialogDescription>
            The shifts {who} leads at {user.clientName ?? 'this client'}. Their pages open on these
            hours and shift alerts reach them first. They still see the whole store.
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
          <div className="max-h-[55vh] space-y-4 overflow-y-auto pr-1">
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
                            {others.length > 0
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
          </div>
        )}

        <DialogFooter>
          {defined && !readOnly && picked.size === 0 && (
            <span className="mr-auto self-center text-xs text-warning">Pick at least one shift.</span>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {defined && !readOnly ? 'Cancel' : 'Close'}
          </Button>
          {defined && !readOnly && (
            <Button onClick={() => void save()} loading={saving} disabled={picked.size === 0}>
              Save
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
