import { useCallback, useEffect, useState } from 'react';
import { CalendarRange, Pencil, Plus } from 'lucide-react';
import { toast } from 'sonner';
import type {
  TimeOffCategory,
  TimeOffEntitlement,
} from '@alto-people/shared';
import {
  listAdminEntitlements,
  upsertAdminEntitlement,
} from '@/lib/timeOffApi';
import { ApiError } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Label, FormHint } from '@/components/ui/Label';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';

const CATEGORIES: TimeOffCategory[] = [
  'VACATION',
  'PTO',
  'BEREAVEMENT',
  'JURY_DUTY',
  'OTHER',
];

const fmtHours = (mins: number) => `${(mins / 60).toFixed(1)}h`;

interface Props {
  canManage: boolean;
}

export function AdminTimeOffEntitlementsView({ canManage }: Props) {
  const [items, setItems] = useState<TimeOffEntitlement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<TimeOffEntitlement | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listAdminEntitlements();
      setItems(res.entitlements);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load.');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <CalendarRange className="h-4 w-4 text-gold" />
              Annual entitlements
            </CardTitle>
            <CardDescription>
              VACATION / PTO / etc. lump-sum granted at the policy anchor
              each year. Carryover cap applies excess balance forward;
              anything beyond is forfeited. SICK uses the per-worked-hour
              accrual model and isn't shown here.
            </CardDescription>
          </div>
          {canManage && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              New entitlement
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {error && (
          <div
            className="m-4 p-3 rounded-md border border-alert/40 bg-alert/10 text-alert text-sm"
            role="alert"
          >
            {error}
          </div>
        )}
        {!items && (
          <div className="p-4 space-y-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        )}
        {items && items.length === 0 && (
          <p className="text-sm text-silver p-6 text-center">
            No entitlements configured yet. Click "New entitlement" to set up
            a VACATION or PTO allowance for an associate.
          </p>
        )}
        {items && items.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Associate</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Annual</TableHead>
                <TableHead className="text-right hidden md:table-cell">Carryover cap</TableHead>
                <TableHead className="hidden lg:table-cell">Anchor</TableHead>
                <TableHead className="hidden lg:table-cell">Last grant</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="text-white">{e.associateName}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px]">
                      {e.category}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right text-silver tabular-nums">
                    {fmtHours(e.annualMinutes)}
                  </TableCell>
                  <TableCell className="text-right hidden md:table-cell text-silver tabular-nums">
                    {fmtHours(e.carryoverMaxMinutes)}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-silver text-xs">
                    {String(e.policyAnchorMonth).padStart(2, '0')}-
                    {String(e.policyAnchorDay).padStart(2, '0')}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-silver text-xs">
                    {e.lastGrantedAt
                      ? new Date(e.lastGrantedAt).toLocaleDateString()
                      : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    {canManage && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing(e)}
                        aria-label="Edit"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <EntitlementDialog
        open={creating || editing !== null}
        onOpenChange={(v) => {
          if (!v) {
            setCreating(false);
            setEditing(null);
          }
        }}
        existing={editing}
        onSaved={() => {
          setCreating(false);
          setEditing(null);
          refresh();
        }}
      />
    </Card>
  );
}

interface DialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  existing: TimeOffEntitlement | null;
  onSaved: () => void;
}

function EntitlementDialog({ open, onOpenChange, existing, onSaved }: DialogProps) {
  const [associateId, setAssociateId] = useState(existing?.associateId ?? '');
  const [category, setCategory] = useState<TimeOffCategory>(
    existing?.category ?? 'VACATION'
  );
  const [annualHours, setAnnualHours] = useState(
    existing ? (existing.annualMinutes / 60).toString() : '80'
  );
  const [carryoverHours, setCarryoverHours] = useState(
    existing ? (existing.carryoverMaxMinutes / 60).toString() : '40'
  );
  const [anchorMonth, setAnchorMonth] = useState(
    existing?.policyAnchorMonth ?? 1
  );
  const [anchorDay, setAnchorDay] = useState(existing?.policyAnchorDay ?? 1);
  const [submitting, setSubmitting] = useState(false);

  // Re-seed every time the dialog opens for a different row.
  useEffect(() => {
    if (!open) return;
    setAssociateId(existing?.associateId ?? '');
    setCategory(existing?.category ?? 'VACATION');
    setAnnualHours(existing ? (existing.annualMinutes / 60).toString() : '80');
    setCarryoverHours(
      existing ? (existing.carryoverMaxMinutes / 60).toString() : '40'
    );
    setAnchorMonth(existing?.policyAnchorMonth ?? 1);
    setAnchorDay(existing?.policyAnchorDay ?? 1);
  }, [open, existing]);

  const submit = async () => {
    const aId = associateId.trim();
    if (!aId) {
      toast.error('Associate ID is required');
      return;
    }
    const annual = Number(annualHours);
    const carry = Number(carryoverHours);
    if (!Number.isFinite(annual) || annual < 0) {
      toast.error('Annual hours must be a non-negative number');
      return;
    }
    if (!Number.isFinite(carry) || carry < 0) {
      toast.error('Carryover hours must be a non-negative number');
      return;
    }

    setSubmitting(true);
    try {
      await upsertAdminEntitlement({
        associateId: aId,
        category,
        annualMinutes: Math.round(annual * 60),
        carryoverMaxMinutes: Math.round(carry * 60),
        policyAnchorMonth: anchorMonth,
        policyAnchorDay: anchorDay,
      });
      toast.success('Entitlement saved');
      onSaved();
    } catch (err) {
      toast.error('Could not save', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {existing ? 'Edit entitlement' : 'New entitlement'}
          </DialogTitle>
          <DialogDescription>
            One entitlement row per associate × category. Editing the same
            (associate, category) pair updates in place.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="ent-assoc" required>
              Associate ID (UUID)
            </Label>
            <Input
              id="ent-assoc"
              value={associateId}
              onChange={(e) => setAssociateId(e.target.value)}
              disabled={!!existing}
              placeholder="e.g. 8a3f…"
              autoFocus={!existing}
            />
            <FormHint>
              Find on the associate's onboarding application detail page.
            </FormHint>
          </div>
          <div>
            <Label htmlFor="ent-cat" required>
              Category
            </Label>
            <select
              id="ent-cat"
              value={category}
              onChange={(e) => setCategory(e.target.value as TimeOffCategory)}
              disabled={!!existing}
              className="mt-1 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 text-white px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright disabled:opacity-50"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ent-annual" required>
                Annual grant (hours)
              </Label>
              <Input
                id="ent-annual"
                type="number"
                step="0.5"
                min="0"
                value={annualHours}
                onChange={(e) => setAnnualHours(e.target.value)}
              />
              <FormHint>e.g. 80 = 10 days/year.</FormHint>
            </div>
            <div>
              <Label htmlFor="ent-carry" required>
                Carryover cap (hours)
              </Label>
              <Input
                id="ent-carry"
                type="number"
                step="0.5"
                min="0"
                value={carryoverHours}
                onChange={(e) => setCarryoverHours(e.target.value)}
              />
              <FormHint>0 = use it or lose it.</FormHint>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ent-month">Anchor month</Label>
              <Input
                id="ent-month"
                type="number"
                min="1"
                max="12"
                value={anchorMonth}
                onChange={(e) => setAnchorMonth(Number(e.target.value))}
              />
            </div>
            <div>
              <Label htmlFor="ent-day">Anchor day</Label>
              <Input
                id="ent-day"
                type="number"
                min="1"
                max="31"
                value={anchorDay}
                onChange={(e) => setAnchorDay(Number(e.target.value))}
              />
              <FormHint>Reset fires on this date each year.</FormHint>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} loading={submitting}>
            {existing ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
