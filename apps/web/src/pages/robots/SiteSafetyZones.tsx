import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, Users } from 'lucide-react';
import { toast } from 'sonner';
import type { SiteSafetyZoneSummary } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import { createSafetyZone, listSafetyZones, setZoneOccupied, updateSafetyZone } from '@/lib/robotsApi';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';

const err = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

function shapeLine(z: SiteSafetyZoneSummary): string {
  return z.shape.type === 'rect' ? `Rectangle ${z.shape.w} × ${z.shape.h} at ${z.shape.x}, ${z.shape.y}` : `Polygon, ${z.shape.points.length} points`;
}

/**
 * Brief 3-1 — a site's safety zones. While a zone is marked occupied by
 * guests, no robot operates inside it (the shift gate and the assignment
 * engine both read this). A supervisor flips the switch from the floor;
 * an administrator draws the zones.
 */
export function SiteSafetyZones() {
  const { locationId = '' } = useParams();
  const { can } = useAuth();
  const canManage = can('manage:org');
  const canFloor = can('manage:scheduling');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['robots', 'zones', locationId], queryFn: () => listSafetyZones(locationId), enabled: !!locationId });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['robots', 'zones', locationId] });
  const occupy = useMutation({
    mutationFn: ({ id, occupied }: { id: string; occupied: boolean }) => setZoneOccupied(id, occupied),
    onSuccess: (z) => {
      toast.success(z.guestOccupied ? `${z.name}: robots keep out until it is cleared.` : `${z.name}: clear for robots.`);
      void invalidate();
    },
    onError: (e) => toast.error(err(e, 'Could not update the zone.')),
  });
  const allow = useMutation({
    mutationFn: ({ id, allowed }: { id: string; allowed: boolean }) => updateSafetyZone(id, { robotsAllowedWhenOccupied: allowed }),
    onSuccess: () => void invalidate(),
    onError: (e) => toast.error(err(e, 'Could not update the zone.')),
  });
  const [name, setName] = useState('');
  const [rect, setRect] = useState({ x: '0', y: '0', w: '10', h: '10' });
  const create = useMutation({
    mutationFn: () => createSafetyZone(locationId, { name: name.trim(), shape: { type: 'rect', x: Number(rect.x), y: Number(rect.y), w: Number(rect.w), h: Number(rect.h) } }),
    onSuccess: () => {
      toast.success('Zone added.');
      setName('');
      void invalidate();
    },
    onError: (e) => toast.error(err(e, 'Could not add the zone.')),
  });
  const zones = q.data?.zones ?? [];
  const occupied = zones.filter((z) => z.guestOccupied).length;

  return (
    <ListTemplate
      title="Safety zones"
      subtitle="Where guests gather on this site's map. While a zone is occupied, no robot operates inside it."
      breadcrumbs={[{ label: 'Robots', to: '/robots' }, { label: 'Safety zones' }]}
      summary={
        q.data ? (
          <p className="text-sm text-ink-muted">
            {zones.length} zone{zones.length === 1 ? '' : 's'} · {occupied} occupied right now
          </p>
        ) : null
      }
    >
      {q.isError ? (
        <QueryError what="the safety zones" query={q} />
      ) : q.isPending ? (
        <Skeleton className="h-40" />
      ) : zones.length === 0 ? (
        <EmptyState icon={ShieldAlert} title="No zones yet" description={canManage ? 'Draw the first zone below: the lobby bar, the pool deck, a banquet floor.' : 'An administrator draws the zones for this site.'} />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {zones.map((z) => (
            <li key={z.id} className="rounded-lg border border-line bg-surface px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium text-ink">{z.name}</div>
                  <div className="text-xs text-ink-muted">{shapeLine(z)}</div>
                  {z.guestOccupied && z.occupiedSince && <div className="text-xs2 text-ink-muted">Occupied since {fmtDateTime(z.occupiedSince)}</div>}
                </div>
                <Badge variant={z.guestOccupied ? (z.robotsAllowedWhenOccupied ? 'pending' : 'destructive') : 'success'}>{z.guestOccupied ? (z.robotsAllowedWhenOccupied ? 'Occupied · robots allowed' : 'Occupied · robots keep out') : 'Clear'}</Badge>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {canFloor && (
                  <Button size="xs" variant={z.guestOccupied ? 'outline' : 'secondary'} onClick={() => occupy.mutate({ id: z.id, occupied: !z.guestOccupied })} loading={occupy.isPending}>
                    <Users className="h-3.5 w-3.5" />
                    {z.guestOccupied ? 'Mark clear' : 'Guests are here'}
                  </Button>
                )}
                {canManage && (
                  <label className="flex items-center gap-2 text-xs text-ink-muted">
                    <input type="checkbox" className="h-5 w-5 accent-gold" checked={z.robotsAllowedWhenOccupied} onChange={(e) => allow.mutate({ id: z.id, allowed: e.target.checked })} />
                    Robots may operate while occupied
                  </label>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <Card className="mt-5">
          <CardContent className="space-y-3 pt-5">
            <SectionTitle title="Add a zone" description="A rectangle on the commissioning map, in its units. Polygons come through the API." />
            <div className="grid gap-3 sm:grid-cols-5">
              <Field label="Name" required className="sm:col-span-1">{(fp) => <Input {...fp} value={name} onChange={(e) => setName(e.target.value)} placeholder="Pool deck" />}</Field>
              {(['x', 'y', 'w', 'h'] as const).map((k) => (
                <Field key={k} label={k === 'w' ? 'Width' : k === 'h' ? 'Height' : k.toUpperCase()}>{(fp) => <Input {...fp} type="number" value={rect[k]} onChange={(e) => setRect((r) => ({ ...r, [k]: e.target.value }))} />}</Field>
              ))}
            </div>
            <div className="flex justify-end">
              <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim() || !(Number(rect.w) > 0) || !(Number(rect.h) > 0)}>
                Add zone
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </ListTemplate>
  );
}
