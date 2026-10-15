import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Megaphone } from 'lucide-react';
import { toast } from 'sonner';
import {
  STATUS_COMPONENTS,
  STATUS_INCIDENT_STATE_LABELS,
  type StatusComponentKey,
  type StatusImpact,
  type StatusIncidentState,
} from '@alto-people/shared';
import { listStatusIncidents, postStatusIncident, updateStatusIncident, type StatusIncidentAdmin } from '@/lib/statusApi';
import { ApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * The operator's side of the public status page: post an incident, keep
 * its timeline current, resolve it. Lives on the Reliability page because
 * that is where the person who notices an outage already is. Only the
 * platform operator's org managers see it (the API refuses everyone else).
 */

const KEY = ['status', 'incidents'] as const;
const OPEN_STATES: StatusIncidentState[] = ['INVESTIGATING', 'IDENTIFIED', 'MONITORING'];

function stateBadge(s: StatusIncidentState) {
  return <Badge variant={s === 'RESOLVED' ? 'success' : s === 'MONITORING' ? 'info' : 'pending'}>{STATUS_INCIDENT_STATE_LABELS[s]}</Badge>;
}

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Try again.';
}

function NewIncident({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [component, setComponent] = useState<StatusComponentKey>('API');
  const [impact, setImpact] = useState<StatusImpact>('DEGRADED');
  const [note, setNote] = useState('');
  const post = useMutation({
    mutationFn: () => postStatusIncident({ title, component, impact, state: 'INVESTIGATING', note }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      toast.success('Posted to the status page');
      onDone();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const ready = title.trim().length >= 3 && note.trim().length >= 3;
  return (
    <form
      className="space-y-3 rounded-lg border border-line bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) post.mutate();
      }}
    >
      <Field label="What is wrong" required>
        {(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} placeholder="WhatsApp deliveries delayed" />}
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Component" required>
          {(p) => (
            <Select {...p} value={component} onChange={(e) => setComponent(e.target.value as StatusComponentKey)}>
              {STATUS_COMPONENTS.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Impact" required>
          {(p) => (
            <Select {...p} value={impact} onChange={(e) => setImpact(e.target.value as StatusImpact)}>
              <option value="DEGRADED">Degraded</option>
              <option value="OUTAGE">Outage</option>
            </Select>
          )}
        </Field>
      </div>
      <Field label="First update" required hint="What people will read on the public page right now.">
        {(p) => <Textarea {...p} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={3} />}
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!ready || post.isPending}>
          {post.isPending ? 'Posting…' : 'Post incident'}
        </Button>
      </div>
    </form>
  );
}

function IncidentRow({ i }: { i: StatusIncidentAdmin }) {
  const qc = useQueryClient();
  const [state, setState] = useState<StatusIncidentState>(i.state === 'RESOLVED' ? 'RESOLVED' : i.state);
  const [note, setNote] = useState('');
  const update = useMutation({
    mutationFn: () => updateStatusIncident(i.id, { state, note }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      setNote('');
      toast.success(state === 'RESOLVED' ? 'Resolved on the status page' : 'Update posted');
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const component = STATUS_COMPONENTS.find((c) => c.key === i.component)?.label ?? i.component;
  const last = i.updates[i.updates.length - 1];
  return (
    <li className="space-y-3 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-1">
        <div className="min-w-0">
          <div className="font-medium text-ink">{i.title}</div>
          <div className="mt-0.5 text-xs2 text-ink-muted">
            {component} · {i.impact === 'OUTAGE' ? 'Outage' : 'Degraded'} · started {fmtDateTime(i.startedAt)}
            {i.resolvedAt ? ` · resolved ${fmtDateTime(i.resolvedAt)}` : ''}
          </div>
          {last && <p className="mt-1 text-sm text-ink-muted">{last.note}</p>}
        </div>
        {stateBadge(i.state)}
      </div>
      {i.state !== 'RESOLVED' && (
        <form
          className="grid gap-2 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim().length >= 3) update.mutate();
          }}
        >
          <Field label="State" className="mb-0">
            {(p) => (
              <Select {...p} value={state} onChange={(e) => setState(e.target.value as StatusIncidentState)}>
                {[...OPEN_STATES, 'RESOLVED' as const].map((s) => (
                  <option key={s} value={s}>
                    {STATUS_INCIDENT_STATE_LABELS[s]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Update" className="mb-0">
            {(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="What changed, in a sentence" />}
          </Field>
          <Button type="submit" size="sm" variant="secondary" disabled={note.trim().length < 3 || update.isPending}>
            {state === 'RESOLVED' ? 'Resolve' : 'Post update'}
          </Button>
        </form>
      )}
    </li>
  );
}

export function StatusIncidentsPanel() {
  const q = useQuery({ queryKey: KEY, queryFn: listStatusIncidents, staleTime: 30_000 });
  const [posting, setPosting] = useState(false);
  const incidents = q.data?.incidents ?? [];
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Megaphone className="h-4 w-4 text-gold" aria-hidden="true" />
            Public status page
          </CardTitle>
          <CardDescription>What a customer or a prospect sees at /status. The component states are measured; the incidents are yours to post.</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <a href="/status" target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4" /> Open
            </a>
          </Button>
          {!posting && (
            <Button size="sm" onClick={() => setPosting(true)}>
              Post incident
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {posting && <NewIncident onDone={() => setPosting(false)} />}
        {q.isLoading ? (
          <Skeleton className="h-24" />
        ) : q.isError ? (
          <p className="text-sm text-alert" role="alert">
            {errorText(q.error)}
          </p>
        ) : incidents.length === 0 ? (
          <EmptyState icon={Megaphone} title="Nothing posted" description="The page says all systems operational from its own measures until you post something." />
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {incidents.map((i) => (
              <IncidentRow key={i.id} i={i} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
