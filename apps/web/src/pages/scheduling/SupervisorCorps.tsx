import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Store, UserRoundCog } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useTerm } from '@/lib/auth';
import { listClients, listClientLocations } from '@/lib/clientsApi';
import { listSupervisorCorps, placeSupervisor, type CorpsSupervisor } from '@/lib/workforceApi';
import { setSupervisorShiftWindows, listClientShiftWindows } from '@/lib/shiftWindowsApi';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Card, CardContent } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';
import { ListTemplate } from '@/components/templates';
import { ShiftLeadsCard } from '@/components/ShiftLeadsCard';

/**
 * The supervisor corps — field leadership's own page: every shift and
 * floor supervisor, where they are placed (client, store) and which shift
 * they lead, with one dialog to move them. The charter said the corps is
 * theirs to run; before this, placing a supervisor meant a ticket to HR
 * for a Users & access page they could not open.
 */

export function SupervisorCorps() {
  const term = useTerm();
  const q = useQuery({ queryKey: ['workforce', 'supervisors'], queryFn: listSupervisorCorps, staleTime: 60_000 });
  const [editing, setEditing] = useState<CorpsSupervisor | null>(null);
  const [filter, setFilter] = useState<'all' | 'unplaced' | 'SHIFT_SUPERVISOR' | 'FLOOR_SUPERVISOR'>('all');

  const rows = useMemo(() => {
    const all = q.data?.supervisors ?? [];
    return all.filter((s) => (filter === 'all' ? true : filter === 'unplaced' ? !s.clientId : s.role === filter));
  }, [q.data, filter]);
  const byClient = useMemo(() => {
    const map = new Map<string, { name: string; rows: CorpsSupervisor[] }>();
    for (const s of rows) {
      const key = s.clientId ?? 'none';
      const b = map.get(key) ?? { name: s.clientName ?? `No ${term('label.client').toLowerCase()} yet`, rows: [] };
      b.rows.push(s);
      map.set(key, b);
    }
    return [...map.entries()].sort(([a], [b]) => (a === 'none' ? -1 : b === 'none' ? 1 : 0));
  }, [rows, term]);
  const unplaced = (q.data?.supervisors ?? []).filter((s) => !s.clientId).length;

  return (
    <ListTemplate
      title={`${term('site')} leads`}
      topbarTitle={`${term('site')} leads`}
      subtitle={`Who leads which ${term('site').toLowerCase()} and shift. Place a supervisor here; roles and access stay with HR.`}
      filters={
        // One filter look across the app (the kit's pills).
        <SegmentedControl
          ariaLabel="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'Everyone' },
            { value: 'unplaced', label: unplaced > 0 ? `Not placed (${unplaced})` : 'Not placed' },
            { value: 'SHIFT_SUPERVISOR', label: 'Shift supervisors' },
            { value: 'FLOOR_SUPERVISOR', label: 'Floor supervisors' },
          ]}
        />
      }
    >
      {q.isError ? (
        <QueryError what={`the ${term('site').toLowerCase()} leads`} query={q} />
      ) : !q.data ? (
        <Skeleton className="h-64" />
      ) : rows.length === 0 ? (
        <EmptyState icon={UserRoundCog} title="Nobody here" description="No supervisor matches this filter." />
      ) : (
        <div className="space-y-4">
          {byClient.map(([key, group]) => (
            <Card key={key} className={key === 'none' ? 'border-warning/40' : undefined}>
              <CardContent>
                <SectionTitle
                  icon={Store}
                  title={group.name}
                  trailing={
                    // Said, not a bare number: how many supervisors sit here.
                    <span className="text-xs tabular-nums text-ink-muted" data-testid="corps-count">
                      {key === 'none' ? `${group.rows.length} not placed` : `${group.rows.length} placed`}
                    </span>
                  }
                />
                <ul className="divide-y divide-navy-secondary/60">
                  {group.rows.map((s) => (
                    <li key={s.userId} className="flex items-center gap-3 py-2.5">
                      <Avatar src={s.photoUrl ?? null} name={s.name} email={s.email} size="md" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <Link to={s.associateId ? `/people?associateId=${s.associateId}` : `/admin/users?user=${s.userId}`} className="truncate text-sm font-medium text-ink hover:text-gold-bright">
                            {s.name}
                          </Link>
                          <Badge variant={s.role === 'SHIFT_SUPERVISOR' ? 'accent' : 'default'} size="sm">
                            {s.role === 'SHIFT_SUPERVISOR' ? 'Shift supervisor' : 'Floor supervisor'}
                          </Badge>
                        </div>
                        <div className="mt-0.5 text-xs text-silver">
                          {s.windows.length > 0 ? [...new Set(s.windows.map((w) => w.label))].join(' & ') : s.clientId ? 'No shift yet' : 'Not placed'}
                          {s.role === 'FLOOR_SUPERVISOR' && (s.lead ? ` · reports to ${s.lead.name}` : ' · no shift supervisor')}
                        </div>
                      </div>
                      <Button size="sm" variant="outline" onClick={() => setEditing(s)}>
                        Place
                      </Button>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
          {/* Every shift with its lead's name, or "No lead" — not only the gaps. */}
          <ShiftLeadsCard showLed onChanged={() => void q.refetch()} />
        </div>
      )}
      {editing && <PlaceDialog supervisor={editing} onClose={() => setEditing(null)} />}
    </ListTemplate>
  );
}

function PlaceDialog({ supervisor, onClose }: { supervisor: CorpsSupervisor; onClose: () => void }) {
  const term = useTerm();
  const qc = useQueryClient();
  const [clientId, setClientId] = useState<string>(supervisor.clientId ?? '');
  const [locationId, setLocationId] = useState<string>(supervisor.locationId ?? '');
  const [shiftLabel, setShiftLabel] = useState<string>(supervisor.windows[0]?.label ?? '');
  const clients = useQuery({ queryKey: ['clients', 'all-active'], queryFn: () => listClients({ status: 'ACTIVE' }), staleTime: 5 * 60_000 });
  const stores = useQuery({ queryKey: ['clients', clientId, 'locations'], queryFn: () => listClientLocations(clientId), enabled: !!clientId, staleTime: 5 * 60_000 });
  const windows = useQuery({ queryKey: ['shift-windows', clientId], queryFn: () => listClientShiftWindows(clientId), enabled: !!clientId, staleTime: 60_000 });
  const storeWindows = (windows.data?.stores ?? []).find((s) => s.locationId === locationId)?.windows ?? [];

  const save = useMutation({
    mutationFn: async () => {
      const r = await placeSupervisor(supervisor.userId, { clientId: clientId || null, locationId: locationId || null });
      if (clientId && locationId && shiftLabel) {
        await setSupervisorShiftWindows(supervisor.userId, [{ locationId, label: shiftLabel }]);
      }
      return r;
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['workforce'] });
      toast.success(r.windowsDropped && !shiftLabel ? `${supervisor.name} placed. Their old shift was dropped — pick a new one.` : `${supervisor.name} placed.`);
      onClose();
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : 'Could not place them.'),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Place {supervisor.name}</DialogTitle>
          <DialogDescription>
            Which {term('label.client').toLowerCase()}, which {term('site').toLowerCase()}, which shift. Moving them to another {term('label.client').toLowerCase()} drops their shift.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label={term('label.client')}>
            {(p) => (
              <Select
                {...p}
                value={clientId}
                onChange={(e) => {
                  setClientId(e.target.value);
                  setLocationId('');
                  setShiftLabel('');
                }}
              >
                <option value="">— none —</option>
                {(clients.data?.clients ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={term('site')} hint={clientId ? undefined : `Pick the ${term('label.client').toLowerCase()} first.`}>
            {(p) => (
              <Select
                {...p}
                value={locationId}
                disabled={!clientId}
                onChange={(e) => {
                  setLocationId(e.target.value);
                  setShiftLabel('');
                }}
              >
                <option value="">— floats across the {term('label.client').toLowerCase()} —</option>
                {(stores.data?.locations ?? []).filter((l) => l.isActive).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Shift" hint={locationId && storeWindows.length === 0 ? `This ${term('site').toLowerCase()} has no named shift windows yet.` : undefined}>
            {(p) => (
              <Select {...p} value={shiftLabel} disabled={!locationId || storeWindows.length === 0} onChange={(e) => setShiftLabel(e.target.value)}>
                <option value="">— keep as is —</option>
                {storeWindows.map((w) => (
                  <option key={w.label} value={w.label}>
                    {w.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={save.isPending}>
            Place
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
