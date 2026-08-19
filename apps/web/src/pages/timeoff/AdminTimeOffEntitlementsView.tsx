import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarRange, Download, Pencil, Plus } from 'lucide-react';
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
import { fmtDate, ymdLocal } from '@/lib/format';
import { downloadCsv } from '@/lib/csv';
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
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { SearchInput } from '@/components/ui/FilterBar';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { Select } from '@/components/ui/Select';
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

// Human-readable labels — raw enum values never reach the user's eyes.
const CATEGORY_LABELS: Record<TimeOffCategory, string> = {
  SICK: 'Sick',
  VACATION: 'Vacation',
  PTO: 'PTO',
  BEREAVEMENT: 'Bereavement',
  JURY_DUTY: 'Jury duty',
  OTHER: 'Other',
};

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Days in a month, 1-based month. Year 2000 is a leap year, so February
 *  offers the 29th — a valid (if unusual) yearly anchor. */
const daysInMonth = (month: number) => new Date(2000, month, 0).getDate();

const fmtHours = (mins: number) => `${(mins / 60).toFixed(1)}h`;

const fmtAnchor = (month: number, day: number) =>
  `${MONTH_NAMES[month - 1]?.slice(0, 3) ?? month} ${day}`;

interface Props {
  canManage: boolean;
}

export function AdminTimeOffEntitlementsView({ canManage }: Props) {
  const [items, setItems] = useState<TimeOffEntitlement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<TimeOffCategory | 'ALL'>(
    'ALL',
  );
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

  const visible = useMemo(() => {
    if (!items) return null;
    const q = search.trim().toLowerCase();
    return items.filter(
      (e) =>
        (categoryFilter === 'ALL' || e.category === categoryFilter) &&
        (!q || e.associateName.toLowerCase().includes(q)),
    );
  }, [items, search, categoryFilter]);

  const exportCsv = () => {
    if (!visible || visible.length === 0) return;
    downloadCsv(`time-off-entitlements-${ymdLocal()}.csv`, [
      [
        'Associate',
        'Category',
        'Annual hours',
        'Carryover cap hours',
        'Anchor',
        'Last grant',
      ],
      ...visible.map((e) => [
        e.associateName,
        CATEGORY_LABELS[e.category] ?? e.category,
        e.annualMinutes / 60,
        e.carryoverMaxMinutes / 60,
        fmtAnchor(e.policyAnchorMonth, e.policyAnchorDay),
        e.lastGrantedAt ? fmtDate(e.lastGrantedAt) : '',
      ]),
    ]);
  };

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
              Vacation, PTO, and similar lump sums granted at the policy
              anchor each year. Carryover cap applies excess balance forward;
              anything beyond is forfeited. Sick time uses the per-worked-hour
              accrual model and isn't shown here.
            </CardDescription>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={exportCsv}
              disabled={!visible || visible.length === 0}
            >
              <Download className="h-4 w-4" />
              Export CSV
            </Button>
            {canManage && (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" />
                New entitlement
              </Button>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <SearchInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search associate…"
            aria-label="Search by associate name"
            wrapperClassName="w-full sm:w-56"
          />
          <Select
            value={categoryFilter}
            onChange={(e) =>
              setCategoryFilter(e.target.value as TimeOffCategory | 'ALL')
            }
            aria-label="Filter by category"
            className="w-auto"
          >
            <option value="ALL">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
          {items && visible && (
            <span className="text-xs text-silver/80 tabular-nums">
              {visible.length === items.length
                ? `${items.length} row${items.length === 1 ? '' : 's'}`
                : `${visible.length} of ${items.length} rows`}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {error && (
          <ErrorBanner
            className="m-4"
            action={
              <Button size="sm" variant="secondary" onClick={refresh}>
                Retry
              </Button>
            }
          >
            {error}
          </ErrorBanner>
        )}
        {!error && !items && (
          <div className="p-4 space-y-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        )}
        {!error && items && items.length === 0 && (
          <div className="p-6">
            <EmptyState
              icon={CalendarRange}
              title="No entitlements yet"
              description="Set up a vacation or PTO allowance for an associate to start granting annual balances."
              action={
                canManage ? (
                  <Button onClick={() => setCreating(true)}>
                    <Plus className="h-4 w-4" />
                    New entitlement
                  </Button>
                ) : undefined
              }
            />
          </div>
        )}
        {!error && items && items.length > 0 && visible && visible.length === 0 && (
          <p className="text-sm text-silver p-6 text-center">
            No entitlements match your filters.
          </p>
        )}
        {!error && visible && visible.length > 0 && (
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
              {visible.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="text-white">{e.associateName}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-2xs">
                      {CATEGORY_LABELS[e.category] ?? e.category}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right text-silver tabular-nums">
                    {fmtHours(e.annualMinutes)}
                  </TableCell>
                  <TableCell className="text-right hidden md:table-cell text-silver tabular-nums">
                    {fmtHours(e.carryoverMaxMinutes)}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-silver text-xs">
                    {fmtAnchor(e.policyAnchorMonth, e.policyAnchorDay)}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-silver text-xs">
                    {fmtDate(e.lastGrantedAt)}
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
  const [assoc, setAssoc] = useState<PickedAssociate | null>(
    existing ? { id: existing.associateId, name: existing.associateName } : null
  );
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
    setAssoc(
      existing ? { id: existing.associateId, name: existing.associateName } : null
    );
    setCategory(existing?.category ?? 'VACATION');
    setAnnualHours(existing ? (existing.annualMinutes / 60).toString() : '80');
    setCarryoverHours(
      existing ? (existing.carryoverMaxMinutes / 60).toString() : '40'
    );
    setAnchorMonth(existing?.policyAnchorMonth ?? 1);
    setAnchorDay(existing?.policyAnchorDay ?? 1);
  }, [open, existing]);

  const submit = async () => {
    const aId = assoc?.id ?? '';
    if (!aId) {
      toast.error('Pick an associate.');
      return;
    }
    const annual = Number(annualHours);
    const carry = Number(carryoverHours);
    if (!Number.isFinite(annual) || annual < 0) {
      toast.error('Annual hours must be a non-negative number.');
      return;
    }
    if (!Number.isFinite(carry) || carry < 0) {
      toast.error('Carryover hours must be a non-negative number.');
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
      toast.success('Entitlement saved.');
      onSaved();
    } catch (err) {
      toast.error('Could not save.', {
        description: err instanceof Error ? err.message : 'Something went wrong.',
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
          <Field label="Associate" required>
            {() =>
              existing ? (
                <div className="rounded-md border border-navy-secondary bg-navy px-3 py-2 text-sm text-white">
                  {existing.associateName}
                </div>
              ) : (
                <AssociatePicker value={assoc} onChange={setAssoc} />
              )
            }
          </Field>
          <Field label="Category" required>
            {(p) => (
              <Select
                value={category}
                onChange={(e) => setCategory(e.target.value as TimeOffCategory)}
                disabled={!!existing}
                {...p}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Annual grant (hours)"
              required
              hint="e.g. 80 = 10 days/year."
            >
              {(p) => (
                <Input
                  type="number"
                  step="0.5"
                  min="0"
                  value={annualHours}
                  onChange={(e) => setAnnualHours(e.target.value)}
                  {...p}
                />
              )}
            </Field>
            <Field
              label="Carryover cap (hours)"
              required
              hint="0 = use it or lose it."
            >
              {(p) => (
                <Input
                  type="number"
                  step="0.5"
                  min="0"
                  value={carryoverHours}
                  onChange={(e) => setCarryoverHours(e.target.value)}
                  {...p}
                />
              )}
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Anchor month">
              {(p) => (
                <Select
                  value={String(anchorMonth)}
                  onChange={(e) => {
                    const m = Number(e.target.value);
                    setAnchorMonth(m);
                    // Keep the day valid for the new month (e.g. Jan 31 → Feb 29).
                    const max = daysInMonth(m);
                    setAnchorDay((d) => (d > max ? max : d));
                  }}
                  {...p}
                >
                  {MONTH_NAMES.map((name, i) => (
                    <option key={name} value={i + 1}>
                      {name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Anchor day" hint="Reset fires on this date each year.">
              {(p) => (
                <Select
                  value={String(anchorDay)}
                  onChange={(e) => setAnchorDay(Number(e.target.value))}
                  {...p}
                >
                  {Array.from(
                    { length: daysInMonth(anchorMonth) },
                    (_, i) => i + 1,
                  ).map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          {Number.isFinite(Number(annualHours)) &&
            Number.isFinite(Number(carryoverHours)) &&
            anchorMonth >= 1 &&
            anchorMonth <= 12 && (
              <p className="text-xs text-silver">
                Renews every {MONTH_NAMES[anchorMonth - 1]} {anchorDay} · up to{' '}
                <span className="text-gold">
                  {Number(annualHours) + Number(carryoverHours)}h
                </span>{' '}
                available right after a reset (annual grant + max carryover).
              </p>
            )}
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
