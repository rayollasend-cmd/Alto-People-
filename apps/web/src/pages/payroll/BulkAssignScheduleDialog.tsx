import { useEffect, useMemo, useState } from 'react';
import { Search, Users } from 'lucide-react';
import type { DirectoryEntry, PayrollSchedule } from '@alto-people/shared';
import { listDirectory } from '@/lib/directoryApi';
import { assignPayrollSchedule } from '@/lib/payrollApi';
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
import { Input } from '@/components/ui/Input';
import { toast } from '@/components/ui/Toaster';

interface Props {
  open: boolean;
  schedule: PayrollSchedule | null;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}

export function BulkAssignScheduleDialog({ open, schedule, onOpenChange, onSaved }: Props) {
  const [people, setPeople] = useState<DirectoryEntry[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setQ('');
    setPeople(null);
    listDirectory({ status: 'ACTIVE' })
      .then((r) => setPeople(r.associates))
      .catch((err) =>
        toast.error(err instanceof ApiError ? err.message : "Couldn't load directory."),
      );
  }, [open]);

  const filtered = useMemo(() => {
    if (!people) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return people;
    return people.filter((p) =>
      `${p.firstName} ${p.lastName} ${p.email}`.toLowerCase().includes(needle),
    );
  }, [people, q]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    if (!schedule || selected.size === 0) return;
    setSubmitting(true);
    try {
      const r = await assignPayrollSchedule(schedule.id, [...selected]);
      toast.success(`Assigned ${r.assigned} associate${r.assigned === 1 ? '' : 's'}.`);
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't assign. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign associates to {schedule?.name ?? 'this schedule'}</DialogTitle>
          <DialogDescription>
            Selected associates will be moved to this schedule. Each associate can only belong to
            one schedule, so this overwrites any prior assignment.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-silver/70" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name or email…"
              className="pl-8"
            />
          </div>
          <div className="max-h-72 overflow-y-auto rounded border border-silver/20 bg-black/30">
            {!people && (
              <div className="p-4 text-sm text-silver/70">Loading directory…</div>
            )}
            {people && filtered.length === 0 && (
              <div className="p-4 text-sm text-silver/70">No matching associates.</div>
            )}
            {filtered.map((p) => (
              <label
                key={p.id}
                className="flex cursor-pointer items-center gap-2 border-b border-silver/10 px-3 py-1.5 text-sm last:border-b-0 hover:bg-silver/5"
              >
                <input
                  type="checkbox"
                  className="accent-gold"
                  checked={selected.has(p.id)}
                  onChange={() => toggle(p.id)}
                />
                <span className="flex-1 truncate">
                  <span className="text-silver">
                    {p.firstName} {p.lastName}
                  </span>
                  <span className="ml-2 text-xs text-silver/70">{p.email}</span>
                </span>
                {p.workplaceClientName && (
                  <span className="text-[10px] uppercase tracking-wide text-silver/70">
                    {p.workplaceClientName}
                  </span>
                )}
              </label>
            ))}
          </div>
          <p className="text-xs text-silver/70">
            <Users className="mr-1 inline h-3 w-3" />
            {selected.size} selected
          </p>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} loading={submitting} disabled={selected.size === 0}>
            Assign {selected.size > 0 ? selected.size : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
