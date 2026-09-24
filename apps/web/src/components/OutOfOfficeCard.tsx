import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarOff, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { createDelegation, getDelegationCandidates, getMyDelegations, removeDelegation } from '@/lib/delegationsApi';
import { fmtDate, parseYmd } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';

/**
 * Settings → Out of office. A manager names who covers their team inbox
 * for a date range; for those days the cover sees and acts on their
 * direct reports and is copied on their notifications. The manager keeps
 * everything throughout — cover adds a reader, never removes one.
 */

const today = () => new Date().toISOString().slice(0, 10);

export function OutOfOfficeCard() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const enabled = can('view:my-team');
  const mine = useQuery({ queryKey: ['delegations', 'mine'], queryFn: getMyDelegations, enabled });
  const candidates = useQuery({ queryKey: ['delegations', 'candidates'], queryFn: getDelegationCandidates, enabled });
  const [toUserId, setToUserId] = useState('');
  const [startsOn, setStartsOn] = useState(today());
  const [endsOn, setEndsOn] = useState(today());
  const [note, setNote] = useState('');

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['delegations'] });
  const create = useMutation({
    mutationFn: () => createDelegation({ toUserId, startsOn, endsOn, note: note.trim() || undefined }),
    onSuccess: (r) => {
      toast.success(`${r.delegation.to.name} covers your team ${fmtDate(parseYmd(r.delegation.startsOn))} – ${fmtDate(parseYmd(r.delegation.endsOn))}.`);
      setToUserId('');
      setNote('');
      void invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not set cover.'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeDelegation(id),
    onSuccess: () => {
      toast.success('Cover removed.');
      void invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not remove cover.'),
  });

  if (!enabled) return null;
  const given = mine.data?.given ?? [];
  const received = mine.data?.received ?? [];
  const valid = toUserId !== '' && startsOn !== '' && endsOn !== '' && endsOn >= startsOn;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarOff className="h-4 w-4 text-gold" />
          Out of office
        </CardTitle>
        <CardDescription>
          Name who covers your team inbox while you are away. For those days they see and can act on your direct
          reports and are copied on your notifications; you keep everything as usual.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {given.length > 0 && (
          <ul className="space-y-2">
            {given.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 rounded-md border border-navy-secondary px-3 py-2 text-sm">
                <span className="text-white">{d.to.name}</span>
                <span className="text-silver tabular-nums">
                  {fmtDate(parseYmd(d.startsOn))} – {fmtDate(parseYmd(d.endsOn))}
                </span>
                {d.startsOn <= (mine.data?.today ?? '') && <Badge variant="success">Covering now</Badge>}
                {d.note && <span className="text-xs text-silver/70">{d.note}</span>}
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto text-silver hover:text-alert"
                  aria-label={`Remove cover by ${d.to.name}`}
                  onClick={() => remove.mutate(d.id)}
                  disabled={remove.isPending}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {received.length > 0 && (
          <p className="text-sm text-silver">
            You are covering for{' '}
            {received.map((d, i) => (
              <span key={d.id}>
                {i > 0 && ', '}
                <span className="text-white">{d.from.name}</span> until {fmtDate(parseYmd(d.endsOn))}
              </span>
            ))}
            .
          </p>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Who covers" className="sm:col-span-2">
            {(p) => (
              <Select value={toUserId} onChange={(e) => setToUserId(e.target.value)} {...p}>
                <option value="">Choose a manager…</option>
                {(candidates.data?.candidates ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} — {c.email}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="From">{(p) => <Input type="date" value={startsOn} min={today()} onChange={(e) => setStartsOn(e.target.value)} {...p} />}</Field>
          <Field label="Through">{(p) => <Input type="date" value={endsOn} min={startsOn} onChange={(e) => setEndsOn(e.target.value)} {...p} />}</Field>
          <Field label="Note (optional)" className="sm:col-span-2">
            {(p) => <Input value={note} maxLength={200} placeholder="e.g. Vacation — back Monday" onChange={(e) => setNote(e.target.value)} {...p} />}
          </Field>
        </div>
        <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!valid || create.isPending}>
          Set cover
        </Button>
      </CardContent>
    </Card>
  );
}
