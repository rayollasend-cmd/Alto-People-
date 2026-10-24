import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Repeat, Trash2 } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import {
  addOneOnOneActionItem,
  deleteOneOnOneActionItem,
  updateOneOnOne,
  updateOneOnOneActionItem,
  type OneOnOne,
  type OneOnOneActionItem,
  type OneOnOneCadence,
} from '@/lib/perf84Api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Drawer, DrawerBody, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';

/**
 * One 1:1, worked in place: the agenda both people add to, the manager's
 * notes, the action items agreed (open ones carry to the next meeting of a
 * repeating 1:1), and Complete — which books the next one when it repeats.
 */

export const CADENCE_LABEL: Record<OneOnOneCadence, string> = { WEEKLY: 'Weekly', BIWEEKLY: 'Every two weeks' };

export function OneOnOneDrawer({
  meeting,
  canManage,
  onClose,
  queryKey,
}: {
  meeting: OneOnOne;
  canManage: boolean;
  onClose: () => void;
  queryKey: readonly unknown[];
}) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey });
  const [agenda, setAgenda] = useState(meeting.agenda ?? '');
  const [notes, setNotes] = useState(meeting.managerNotes ?? '');
  const [newItem, setNewItem] = useState('');
  const [items, setItems] = useState<OneOnOneActionItem[]>(meeting.actionItems ?? []);
  const scheduled = meeting.status === 'SCHEDULED';
  const dirty = agenda !== (meeting.agenda ?? '') || notes !== (meeting.managerNotes ?? '');

  const save = useMutation({
    mutationFn: (extra: { status?: 'COMPLETED'; cadence?: OneOnOneCadence | null }) =>
      updateOneOnOne(meeting.id, { agenda: agenda.trim() || null, managerNotes: notes.trim() || null, ...extra }),
    onSuccess: (r, extra) => {
      if (extra.status === 'COMPLETED') {
        const carried = items.filter((i) => !i.doneAt).length;
        toast.success(
          r.nextId
            ? `Completed. The next 1:1 is booked${carried > 0 ? ` and ${carried} open ${carried === 1 ? 'item carries' : 'items carry'} onto it` : ''}.`
            : '1:1 completed.',
        );
        onClose();
      } else if (extra.cadence !== undefined) {
        toast.success(extra.cadence ? `Repeats ${CADENCE_LABEL[extra.cadence].toLowerCase()}.` : 'Stops repeating after this one.');
      } else {
        toast.success('Saved.');
      }
      refresh();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save the 1:1.'),
  });

  const add = useMutation({
    mutationFn: (text: string) => addOneOnOneActionItem(meeting.id, { text }),
    onSuccess: (r) => {
      setItems((cur) => [...cur, r.item]);
      setNewItem('');
      refresh();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not add it.'),
  });
  const toggle = async (item: OneOnOneActionItem) => {
    const done = !item.doneAt;
    setItems((cur) => cur.map((i) => (i.id === item.id ? { ...i, doneAt: done ? new Date().toISOString() : null } : i)));
    try {
      await updateOneOnOneActionItem(item.id, { done });
      refresh();
    } catch (e) {
      setItems((cur) => cur.map((i) => (i.id === item.id ? item : i)));
      toast.error(e instanceof ApiError ? e.message : 'Could not update it.');
    }
  };
  const remove = async (item: OneOnOneActionItem) => {
    setItems((cur) => cur.filter((i) => i.id !== item.id));
    try {
      await deleteOneOnOneActionItem(item.id);
      refresh();
    } catch (e) {
      setItems((cur) => [...cur, item]);
      toast.error(e instanceof ApiError ? e.message : 'Could not remove it.');
    }
  };

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} width="max-w-lg" confirmDiscard={() => dirty}>
      <DrawerHeader>
        <DrawerTitle>1:1 with {meeting.associateName ?? 'them'}</DrawerTitle>
        <p className="text-sm text-ink-muted">
          {fmtDateTime(meeting.scheduledFor)}
          {meeting.completedAt ? ` · held ${fmtDate(meeting.completedAt)}` : ''}
          {meeting.cadence ? ` · repeats ${CADENCE_LABEL[meeting.cadence].toLowerCase()}` : ''}
        </p>
      </DrawerHeader>
      <DrawerBody className="space-y-5">
        <Field label="Agenda" hint="Both of you add to it — they see it from their own Performance page.">
          {(f) => (
            <Textarea rows={4} value={agenda} disabled={!canManage || !scheduled} onChange={(e) => setAgenda(e.target.value)} placeholder="Topics to cover…" {...f} />
          )}
        </Field>
        {meeting.associateNotes && (
          <div className="rounded-md border border-line bg-surface-raised px-3 py-2 text-sm text-ink">
            <span className="text-ink-muted">Their notes: </span>
            {meeting.associateNotes}
          </div>
        )}
        <div>
          <p className="mb-2 text-sm font-medium text-ink">Action items</p>
          {items.length === 0 ? (
            <p className="text-sm text-ink-muted">No action items agreed so far.</p>
          ) : (
            <ul className="space-y-1.5" aria-label="Action items">
              {items.map((i) => (
                <li key={i.id} className="flex items-start gap-2">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={!!i.doneAt}
                    aria-label={i.doneAt ? `Mark “${i.text}” not done` : `Mark “${i.text}” done`}
                    disabled={!canManage}
                    onClick={() => void toggle(i)}
                    className={cn(
                      'mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border',
                      i.doneAt ? 'border-success bg-success text-surface' : 'border-line',
                    )}
                  >
                    {i.doneAt && <Check className="h-3 w-3" aria-hidden="true" />}
                  </button>
                  <span className={cn('min-w-0 flex-1 text-sm', i.doneAt ? 'text-ink-muted line-through' : 'text-ink')}>
                    {i.text}
                    {i.carried && !i.doneAt && (
                      <Badge variant="outline" size="sm" className="ml-2">
                        carried over
                      </Badge>
                    )}
                  </span>
                  {canManage && (
                    <button type="button" aria-label={`Remove “${i.text}”`} onClick={() => void remove(i)} className="text-ink-muted hover:text-alert">
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canManage && (
            <form
              className="mt-2 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (newItem.trim()) add.mutate(newItem.trim());
              }}
            >
              <Input value={newItem} onChange={(e) => setNewItem(e.target.value)} placeholder="Add an action item" aria-label="New action item" maxLength={500} />
              <Button type="submit" size="sm" variant="secondary" disabled={!newItem.trim()} loading={add.isPending}>
                Add
              </Button>
            </form>
          )}
        </div>
        {canManage && (
          <Field label="Your notes" hint="Only you and HR see these.">
            {(f) => <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} {...f} />}
          </Field>
        )}
        {canManage && scheduled && (
          <Field label="Repeats">
            {(f) => (
              <Select
                value={meeting.cadence ?? ''}
                onChange={(e) => save.mutate({ cadence: (e.target.value || null) as OneOnOneCadence | null })}
                {...f}
              >
                <option value="WEEKLY">Weekly</option>
                <option value="BIWEEKLY">Every two weeks</option>
                <option value="">Doesn’t repeat</option>
              </Select>
            )}
          </Field>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        {canManage && dirty && (
          <Button variant="secondary" onClick={() => save.mutate({})} loading={save.isPending && !save.variables?.status}>
            Save
          </Button>
        )}
        {canManage && scheduled && (
          <Button onClick={() => save.mutate({ status: 'COMPLETED' })} loading={save.isPending && save.variables?.status === 'COMPLETED'}>
            {meeting.cadence ? (
              <>
                <Repeat className="mr-1.5 h-4 w-4" aria-hidden="true" /> Complete &amp; book next
              </>
            ) : (
              'Complete'
            )}
          </Button>
        )}
      </DrawerFooter>
    </Drawer>
  );
}
