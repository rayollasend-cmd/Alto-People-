import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Users } from 'lucide-react';
import type { TimeOffCategory } from '@alto-people/shared';
import { listDirectory } from '@/lib/directoryApi';
import { useClients } from '@/lib/useClients';
import { bulkUpsertEntitlements } from '@/lib/timeOffApi';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * ONE POLICY, A WHOLE ROSTER.
 *
 * Entitlements were created one associate at a time, and they are the only
 * way most categories ever get a balance — only SICK accrues, and only
 * where state law provides for it, which in Florida it does not. So a
 * client with two hundred people meant two hundred trips through a form,
 * and until someone made all of them those associates could request time
 * off that could never be approved. The approver found out, not the
 * requester.
 *
 * Existing policies are left alone by default. Applying a company standard
 * should not quietly overwrite the exception someone negotiated for one
 * person.
 */

const CATEGORIES: TimeOffCategory[] = ['PTO', 'VACATION', 'SICK', 'BEREAVEMENT', 'JURY_DUTY', 'OTHER'];

export function BulkEntitlementDialog({
  open,
  onClose,
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  onApplied: () => void;
}) {
  const { clients } = useClients();
  const [clientId, setClientId] = useState('');
  const [category, setCategory] = useState<TimeOffCategory>('PTO');
  const [annualHours, setAnnualHours] = useState('80');
  const [carryoverHours, setCarryoverHours] = useState('40');
  const [skipExisting, setSkipExisting] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roster = useQuery({
    queryKey: ['directory', 'bulk-entitlement', clientId],
    queryFn: () => listDirectory({ status: 'ACTIVE', ...(clientId ? { clientId } : {}) }),
    enabled: open,
  });

  const people = useMemo(
    () => (roster.data?.associates ?? []).filter((a) => !!a.id),
    [roster.data],
  );
  const allPicked = people.length > 0 && people.every((p) => picked.has(p.id));

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const apply = async () => {
    const annual = Math.round(Number(annualHours) * 60);
    const carry = Math.round(Number(carryoverHours) * 60);
    if (!Number.isFinite(annual) || annual < 0) return setError('Annual hours must be a number.');
    if (!Number.isFinite(carry) || carry < 0) return setError('Carryover hours must be a number.');
    if (picked.size === 0) return setError('Choose at least one person.');
    setBusy(true);
    setError(null);
    try {
      const r = await bulkUpsertEntitlements({
        category,
        annualMinutes: annual,
        carryoverMaxMinutes: carry,
        associateIds: [...picked],
        skipExisting,
      });
      const parts = [`${r.created} added`];
      if (r.updated) parts.push(`${r.updated} updated`);
      if (r.skippedExisting) parts.push(`${r.skippedExisting} already had one`);
      toast.success(`Policy applied — ${parts.join(', ')}.`);
      setPicked(new Set());
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not apply the policy.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Apply a policy to many</DialogTitle>
          <DialogDescription>
            Without an entitlement an associate has no balance, and their time off can be
            requested but never approved. This gives a whole roster the same one.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Category" required>
            {(p) => (
              <Select {...p} value={category} onChange={(e) => setCategory(e.target.value as TimeOffCategory)}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c.replace(/_/g, ' ')}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Hours a year" required>
            {(p) => <Input {...p} type="number" min={0} value={annualHours} onChange={(e) => setAnnualHours(e.target.value)} />}
          </Field>
          <Field label="Carryover cap (hours)" required>
            {(p) => <Input {...p} type="number" min={0} value={carryoverHours} onChange={(e) => setCarryoverHours(e.target.value)} />}
          </Field>
        </div>

        <Field label="Who">
          {(p) => (
            <Select
              {...p}
              value={clientId}
              onChange={(e) => {
                setClientId(e.target.value);
                setPicked(new Set());
              }}
            >
              <option value="">Everyone I can see</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <div className="rounded-lg border border-navy-secondary">
          <div className="flex items-center justify-between border-b border-navy-secondary px-3 py-2">
            <span className="flex items-center gap-1.5 text-xs text-silver">
              <Users className="h-3.5 w-3.5" aria-hidden="true" />
              {picked.size} of {people.length} selected
            </span>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setPicked(allPicked ? new Set() : new Set(people.map((x) => x.id)))}
              disabled={people.length === 0}
            >
              {allPicked ? 'Clear all' : 'Select all'}
            </Button>
          </div>
          {roster.isLoading ? (
            <Skeleton className="m-3 h-32" />
          ) : people.length === 0 ? (
            <p className="px-3 py-4 text-sm text-silver">No active associates here.</p>
          ) : (
            <ul className="max-h-56 overflow-y-auto">
              {people.map((a) => (
                <li key={a.id}>
                  <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm hover:bg-navy-secondary/30">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-gold"
                      checked={picked.has(a.id)}
                      onChange={() => toggle(a.id)}
                    />
                    <span className="min-w-0 flex-1 truncate text-white">
                      {a.firstName} {a.lastName}
                    </span>
                    <span className="shrink-0 truncate text-xs text-silver/70">{a.position ?? ''}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm text-silver">
          <input
            type="checkbox"
            className="h-4 w-4 accent-gold"
            checked={skipExisting}
            onChange={(e) => setSkipExisting(e.target.checked)}
          />
          Leave anyone who already has a policy for this category alone
        </label>

        {error && <ErrorBanner>{error}</ErrorBanner>}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void apply()} loading={busy} disabled={busy || picked.size === 0}>
            Apply to {picked.size || 'no one'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
