import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { bookTeamOneOnOne, type DirectReport } from '@/lib/teamApi';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';

/**
 * The 1:1 rhythm on a team row: when the next one is and how long since
 * the last — and, with none booked, one button that books a repeating one
 * (prefilled for the next weekday at 10:00, weekly).
 */

const DAY_MS = 86_400_000;

export function daysAgo(iso: string, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - Date.parse(iso)) / DAY_MS));
}

export function oneOnOneSummary(r: Pick<DirectReport, 'lastOneOnOneAt' | 'nextOneOnOne'>): string {
  const parts: string[] = [];
  if (r.nextOneOnOne) parts.push(`Next ${fmtDate(r.nextOneOnOne.scheduledFor)}`);
  if (r.lastOneOnOneAt) {
    const d = daysAgo(r.lastOneOnOneAt);
    parts.push(d === 0 ? 'last today' : `last ${d}d ago`);
  } else {
    parts.push('none held yet');
  }
  return parts.join(' · ');
}

/** Next weekday at 10:00 local, as a datetime-local value. */
function nextWeekdayAt10(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T10:00`;
}

export function OneOnOneCell({ report }: { report: DirectReport }) {
  const [open, setOpen] = useState(false);
  const overdue = !report.nextOneOnOne && (report.lastOneOnOneAt ? daysAgo(report.lastOneOnOneAt) > 21 : true);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className={overdue ? 'text-warning' : 'text-ink-muted'} title={report.nextOneOnOne ? fmtDateTime(report.nextOneOnOne.scheduledFor) : undefined}>
        {oneOnOneSummary(report)}
      </span>
      {!report.nextOneOnOne && (
        <Button size="xs" variant="secondary" onClick={() => setOpen(true)} aria-label={`Book a 1:1 with ${report.firstName}`}>
          <CalendarPlus className="h-3.5 w-3.5" aria-hidden="true" /> Book
        </Button>
      )}
      {open && <BookDialog report={report} onClose={() => setOpen(false)} />}
    </span>
  );
}

function BookDialog({ report, onClose }: { report: DirectReport; onClose: () => void }) {
  const qc = useQueryClient();
  const [when, setWhen] = useState(nextWeekdayAt10);
  const [cadence, setCadence] = useState<'WEEKLY' | 'BIWEEKLY' | ''>('WEEKLY');
  const book = useMutation({
    mutationFn: () => bookTeamOneOnOne(report.id, { scheduledFor: new Date(when).toISOString(), cadence: cadence || null }),
    onSuccess: () => {
      toast.success(`1:1 with ${report.firstName} booked${cadence ? ` — repeats ${cadence === 'WEEKLY' ? 'weekly' : 'every two weeks'}` : ''}.`);
      void qc.invalidateQueries({ queryKey: ['team'] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not book it.'),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            1:1 with {report.firstName} {report.lastName}
          </DialogTitle>
          <DialogDescription>A repeating 1:1 books the next one when you complete this one, and carries open action items onto it.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="When">{(f) => <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} {...f} />}</Field>
          <Field label="Repeats">
            {(f) => (
              <Select value={cadence} onChange={(e) => setCadence(e.target.value as typeof cadence)} {...f}>
                <option value="WEEKLY">Weekly</option>
                <option value="BIWEEKLY">Every two weeks</option>
                <option value="">Just this once</option>
              </Select>
            )}
          </Field>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => book.mutate()} loading={book.isPending} disabled={!when}>
            Book 1:1
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
