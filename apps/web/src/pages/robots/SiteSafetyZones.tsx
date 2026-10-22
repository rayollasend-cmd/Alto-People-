import { useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pentagon, ShieldAlert, Undo2, Users } from 'lucide-react';
import { toast } from 'sonner';
import type { SiteSafetyZoneSummary, ZoneShape } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import { boundsOf, closesPolygon, polygonValid, round1, shapeLabel, shapePoints, type Point } from '@/lib/robotZones';
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
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';

const err = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

const shapeLine = (z: SiteSafetyZoneSummary) => shapeLabel(z.shape);

type DrawMode = 'polygon' | 'rect';
const MODES: { value: DrawMode; label: string }[] = [
  { value: 'polygon', label: 'Polygon' },
  { value: 'rect', label: 'Rectangle' },
];

/**
 * The site map as a drawing surface: the zones that exist, and the polygon
 * being drawn. A click adds a vertex; a click on the first vertex (or
 * "Close shape") closes it; a vertex can be dragged after it is placed.
 * Units are the commissioning map's own.
 */
export function ZoneCanvas({
  zones,
  draft,
  onDraftChange,
  onClose,
  drawing,
}: {
  zones: SiteSafetyZoneSummary[];
  draft: Point[];
  onDraftChange: (next: Point[]) => void;
  onClose: () => void;
  drawing: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const b = useMemo(() => boundsOf([...zones.map((z) => z.shape), ...(draft.length ? [{ type: 'polygon' as const, points: draft.length >= 3 ? draft : [...draft, draft[0]!, draft[0]!] }] : [])]), [zones, draft]);
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  const tolerance = Math.max(w, h) * 0.03;

  const toMap = (e: { clientX: number; clientY: number }): Point => {
    const svg = svgRef.current!;
    const rect = svg.getBoundingClientRect();
    const x = b.minX + ((e.clientX - rect.left) / Math.max(1, rect.width)) * w;
    const y = b.minY + ((e.clientY - rect.top) / Math.max(1, rect.height)) * h;
    return [round1(x), round1(y)];
  };

  return (
    <div className="space-y-2">
      <svg
        ref={svgRef}
        viewBox={`${b.minX} ${b.minY} ${w} ${h}`}
        className={`aspect-square w-full max-w-xl rounded-lg border border-line bg-surface-raised/40 ${drawing ? 'cursor-crosshair' : ''}`}
        role="img"
        aria-label={drawing ? 'Site map: click to add a vertex, click the first vertex to close the zone' : 'Site map with its safety zones'}
        data-testid="zone-canvas"
        onClick={(e) => {
          if (!drawing || dragging !== null) return;
          const p = toMap(e);
          if (closesPolygon(draft, p, tolerance)) {
            onClose();
            return;
          }
          onDraftChange([...draft, p]);
        }}
        onPointerMove={(e) => {
          if (dragging === null) return;
          const p = toMap(e);
          onDraftChange(draft.map((v, i) => (i === dragging ? p : v)));
        }}
        onPointerUp={() => setDragging(null)}
        onPointerLeave={() => setDragging(null)}
      >
        {zones.map((z) => (
          <g key={z.id}>
            <polygon points={shapePoints(z.shape)} className={z.guestOccupied ? 'fill-alert/25 stroke-alert' : 'fill-success/15 stroke-success'} strokeWidth={Math.max(w, h) * 0.005} vectorEffect="non-scaling-stroke" />
            <text x={labelX(z.shape)} y={labelY(z.shape)} fontSize={Math.max(w, h) * 0.035} className="fill-ink" textAnchor="middle">
              {z.name}
            </text>
          </g>
        ))}
        {draft.length > 0 && (
          <g>
            <polyline points={draft.map(([x, y]) => `${x},${y}`).join(' ')} fill="none" className="stroke-gold" strokeWidth={Math.max(w, h) * 0.006} strokeDasharray={`${Math.max(w, h) * 0.015} ${Math.max(w, h) * 0.01}`} />
            {draft.map(([x, y], i) => (
              <circle
                key={i}
                cx={x}
                cy={y}
                r={Math.max(w, h) * (i === 0 ? 0.02 : 0.014)}
                className={i === 0 ? 'fill-gold stroke-ink cursor-pointer' : 'fill-surface stroke-gold cursor-move'}
                strokeWidth={Math.max(w, h) * 0.004}
                data-testid={`vertex-${i}`}
                onPointerDown={(e) => {
                  if (i === 0 && draft.length >= 3) return; // the first vertex closes on click
                  e.stopPropagation();
                  setDragging(i);
                }}
                onClick={(e) => {
                  if (i === 0 && draft.length >= 3) {
                    e.stopPropagation();
                    onClose();
                  }
                }}
              />
            ))}
          </g>
        )}
      </svg>
    </div>
  );
}

function labelX(shape: ZoneShape): number {
  if (shape.type === 'rect') return shape.x + shape.w / 2;
  return shape.points.reduce((s, p) => s + p[0], 0) / shape.points.length;
}
function labelY(shape: ZoneShape): number {
  if (shape.type === 'rect') return shape.y + shape.h / 2;
  return shape.points.reduce((s, p) => s + p[1], 0) / shape.points.length;
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
  const [mode, setMode] = useState<DrawMode>('polygon');
  const [rect, setRect] = useState({ x: '0', y: '0', w: '10', h: '10' });
  const [draft, setDraft] = useState<Point[]>([]);
  const [closed, setClosed] = useState(false);
  const shape = (): ZoneShape =>
    mode === 'rect' ? { type: 'rect', x: Number(rect.x), y: Number(rect.y), w: Number(rect.w), h: Number(rect.h) } : { type: 'polygon', points: draft };
  const shapeReady = mode === 'rect' ? Number(rect.w) > 0 && Number(rect.h) > 0 : closed && polygonValid(draft);
  const create = useMutation({
    mutationFn: () => createSafetyZone(locationId, { name: name.trim(), shape: shape() }),
    onSuccess: () => {
      toast.success('Zone added.');
      setName('');
      setDraft([]);
      setClosed(false);
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
          <CardContent className="space-y-3">
            <SectionTitle title="Add a zone" description="Draw it on the commissioning map, in its units: a polygon around the lobby bar, or a rectangle by its numbers." />
            <SegmentedControl ariaLabel="Zone shape" options={MODES} value={mode} onChange={(m) => { setMode(m); setDraft([]); setClosed(false); }} />
            {mode === 'polygon' ? (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
                <ZoneCanvas zones={zones} draft={draft} drawing={!closed} onDraftChange={(next) => setDraft(next)} onClose={() => setClosed(true)} />
                <div className="space-y-3">
                  <Field label="Name" required>{(fp) => <Input {...fp} value={name} onChange={(e) => setName(e.target.value)} placeholder="Pool deck" />}</Field>
                  <p className="text-xs text-ink-muted" aria-live="polite">
                    {draft.length === 0
                      ? 'Click the map to place the first corner.'
                      : closed
                        ? `${draft.length} corners, closed. Drag a corner to adjust it, or add the zone.`
                        : draft.length < 3
                          ? `${draft.length} of at least 3 corners.`
                          : `${draft.length} corners. Click the first corner, or Close shape, to finish.`}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={() => setClosed(true)} disabled={closed || !polygonValid(draft)}>
                      <Pentagon className="h-3.5 w-3.5" />
                      Close shape
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => { setDraft((d) => d.slice(0, -1)); setClosed(false); }} disabled={draft.length === 0}>
                      <Undo2 className="h-3.5 w-3.5" />
                      Undo corner
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => { setDraft([]); setClosed(false); }} disabled={draft.length === 0}>
                      Clear
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-5">
                <Field label="Name" required className="sm:col-span-1">{(fp) => <Input {...fp} value={name} onChange={(e) => setName(e.target.value)} placeholder="Pool deck" />}</Field>
                {(['x', 'y', 'w', 'h'] as const).map((k) => (
                  <Field key={k} label={k === 'w' ? 'Width' : k === 'h' ? 'Height' : k.toUpperCase()}>{(fp) => <Input {...fp} type="number" value={rect[k]} onChange={(e) => setRect((r) => ({ ...r, [k]: e.target.value }))} />}</Field>
                ))}
              </div>
            )}
            <div className="flex justify-end">
              <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim() || !shapeReady}>
                Add zone
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </ListTemplate>
  );
}
