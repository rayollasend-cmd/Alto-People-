import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { WORKER_CAPABILITIES, WORK_TASK_RISKS, WORK_TASK_RISK_LABELS, type LocationSummary, type WorkTaskRisk } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { createTask } from '@/lib/tasksApi';
import { useTerm } from '@/lib/auth';
import { Button, Input, Select, Textarea } from '@/components/ui';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';

/** The catalog, read loosely: the literal union is for the registry, not a picker. */
const CAPS: ReadonlyArray<{ code: string; label: string; types: readonly string[] }> = WORKER_CAPABILITIES;

/** A new task; the engine assigns it the moment it is saved. */
export function NewTaskDialog({ sites, defaultLocationId, day, onClose, onCreated }: { sites: LocationSummary[]; defaultLocationId: string; day: string; onClose: () => void; onCreated: (id: string) => void }) {
  const term = useTerm();
  const [type, setType] = useState('');
  const [locationId, setLocationId] = useState(defaultLocationId || sites[0]?.id || '');
  const [area, setArea] = useState('');
  const [startTime, setStartTime] = useState('14:00');
  const [endTime, setEndTime] = useState('18:00');
  const [capability, setCapability] = useState<string>(CAPS[0]?.code ?? 'stocking');
  const [risk, setRisk] = useState<WorkTaskRisk>('LOW');
  const [minutes, setMinutes] = useState('30');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');

  const save = useMutation({
    mutationFn: () =>
      createTask({
        type: type.trim(),
        locationId,
        area: area.trim() || null,
        windowStart: new Date(`${day}T${startTime}:00`).toISOString(),
        windowEnd: new Date(`${day}T${endTime}:00`).toISOString(),
        capability,
        risk,
        estimatedMinutes: Number(minutes) || 30,
        reference: reference.trim() || null,
        notes: notes.trim() || null,
      }),
    onSuccess: (t) => {
      toast.success(t.assignment ? `Assigned to ${t.assignment.workerName}.` : 'Saved; waiting for a person.');
      onCreated(t.id);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the task.'),
  });

  const valid = type.trim().length >= 2 && locationId && startTime < endTime;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>The engine ranks everyone free in the window and assigns the task as soon as it is saved, or queues it for you with the reason.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Task" required>
              {(p) => <Input {...p} value={type} onChange={(e) => setType(e.target.value)} placeholder="Unload the 6 AM truck" maxLength={80} />}
            </Field>
          </div>
          <Field label={term('site')} required>
            {(p) => (
              <Select {...p} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Where inside">{(p) => <Input {...p} value={area} onChange={(e) => setArea(e.target.value)} placeholder="Dock 3" maxLength={120} />}</Field>
          <Field label="From" required>
            {(p) => <Input {...p} type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />}
          </Field>
          <Field label="To" required>
            {(p) => <Input {...p} type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />}
          </Field>
          <Field label="Needs" required>
            {(p) => (
              <Select {...p} value={capability} onChange={(e) => setCapability(e.target.value)}>
                {CAPS.filter((c) => c.types.includes('PERSON') || c.types.includes('ROBOT')).map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Risk" required>
            {(p) => (
              <Select {...p} value={risk} onChange={(e) => setRisk(e.target.value as WorkTaskRisk)}>
                {WORK_TASK_RISKS.map((r) => (
                  <option key={r} value={r}>
                    {WORK_TASK_RISK_LABELS[r]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Estimated minutes" required>
            {(p) => <Input {...p} type="number" min={5} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} />}
          </Field>
          <Field label="Reference">{(p) => <Input {...p} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Truck 4471 · Banquet B · Rooms 210–240" maxLength={160} />}</Field>
          <div className="sm:col-span-2">
            <Field label="Notes">{(p) => <Textarea {...p} value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={2000} />}</Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={!valid} loading={save.isPending}>
            Save and assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
